<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-pic" :class="'y-pic--' + mode">
        <video
            ref="video"
            class="y-pic__video"
            :style="{ filter: degradeFilter }"
            autoplay
            muted
            playsinline
        ></video>
        <img v-if="mode === 'stills' && stillSrc" class="y-pic__video" :src="stillSrc" alt="" />
        <div v-if="staleFor > 0" class="y-pic__hatch"></div>
        <div class="y-pic__hud">
            <span class="y-pic__badge" :class="'tone-' + tone">{{ caption }}</span>
            <span v-if="staleFor > 0" class="y-pic__age">{{ ageText }}</span>
            <span v-if="cost" class="y-pic__cost">{{ cost }}</span>
        </div>
        <div v-if="reason" class="y-pic__reason">{{ reason }}</div>
        <div v-if="mode === 'off'" class="y-pic__off">
            not requested · this changes nothing the aircraft sends anyone else
        </div>
    </div>
</template>

<script>
/**
 * The live picture, and the three things that happen to it (R-VID-03).
 *
 * **The hazard is a stale picture read as a live one.** So when contact goes,
 * four signals at once: it desaturates, it darkens, it takes a hatch, and it
 * carries a count that keeps running. A badge alone is what an operator stops
 * seeing after ten minutes. By the time contact has been gone a minute the
 * shot is barely readable and the count is the loudest thing on it, which is
 * correct — its only remaining value is telling the operator what they were
 * looking at when contact went.
 *
 * **Going black is rejected.** It cannot be misread, and it deletes the one
 * thing still held: where the camera was pointing, what was in shot, where the
 * horizon was.
 *
 * **Nothing on the aircraft changes when this browser's link goes.** The
 * pipeline's state is what the operator last set it to; the ground station's
 * link is not the console's link. This component therefore never draws a claim
 * about the other outputs — a console losing its link says nothing whatever
 * about the aircraft's ground-station feed, and the row that reports it reads
 * 'not known from here'. Greying it out, or leaving it green, would be
 * inventing a fact.
 *
 * **The session reconnects on its own, with backoff, showing the attempt
 * count.** No button: the operator asked for a live picture and never withdrew
 * the request. The picture returns immediately when it does, because the
 * preview branch runs a short keyframe interval of its own (pipeline.ts) — so
 * a reconnecting browser is a late joiner that does not have to wait out a
 * group of pictures.
 *
 * **Falling back to stills happens without being asked**, twelve seconds after
 * live video fails to establish: long enough for a slow negotiation to finish,
 * short enough that nobody is left staring at nothing. It changes nothing on
 * the aircraft, so the default should simply be the useful one — and it
 * reports *why*, because a browser blocked by a network, a carrier discarding
 * UDP and a camera that has stopped producing frames all present as no
 * picture, and only one of them is worth walking outside for.
 *
 * **Off is not the link being down**, and must not look like it: the neutral
 * tone rather than the fault tone, 'not requested' rather than 'no contact'.
 * Turning off your own view changes nothing about what the aircraft sends
 * anyone else, and the caption says so.
 *
 * **Two timers, not one.** The deadline for stills and the wait before the
 * next attempt are separate, and the deadline is armed on the operator's
 * *request* rather than on an attempt. One field for both meant a failed
 * negotiation cancelled its own reconnect, and a camera that answers in a
 * millisecond — the case the fall-back exists for — never reached the
 * deadline at all.
 *
 * **`lastFrameAt` is a frame, and only ever a frame.** It used to be set in
 * `ontrack`, which is a *negotiation* event: it fires once, when the remote
 * description adds the track, before any media flows. Nothing then updated it
 * again, so the age above counted from the handshake and a perfectly healthy
 * picture read "no contact" three seconds after it connected and was an
 * unreadable dark rectangle a minute later. That is this component's own
 * hazard inverted, and worse than it: an operator who sees all four degrade
 * signals fire on every good session learns inside one flight to ignore them.
 * It also broke the fall-back, because `lastFrameAt === null` is how the
 * twelve-second deadline knows no media ever arrived — a handshake that
 * completed over TCP while the carrier discarded the UDP is exactly the case
 * R-VID-14 exists for, and it would never have fallen back.
 *
 * The signal is the video element's `timeupdate`: the media clock advancing,
 * which is what "a frame arrived" means, fired by every browser as the
 * picture paints and stopping the moment the picture does.
 * `requestVideoFrameCallback` is not in every browser, and polling
 * `getStats()` for `framesDecoded` needs a timer of its own and reports the
 * decoder rather than the thing on screen.
 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

export default {
    name: 'YonderPicture',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return {
            mode: 'live',
            pc: null,
            /** Aborts the handshake in flight, when nobody wants it any more. */
            abort: null,
            /**
             * Which attempt is the current one.
             *
             * A number rather than the peer connection itself: `data` is
             * reactive, so `this.pc` hands back a proxy and `this.pc === pc`
             * is false against the object `connect()` is holding. A counter
             * compares by value and cannot be fooled by the framework.
             */
            session: 0,
            attempt: 0,
            lastFrameAt: null,
            now: Date.now(),
            reason: '',
            stillSrc: '',
            stillsTimer: null,
            retryTimer: null,
            /** The last cost the flow sent, held across later commands. */
            sentCost: '',
            /** The camera the flow last said this picture is of. */
            sentPath: '',
            /** The path the session in hand was negotiated against. */
            negotiated: '',
            tick: null,
            /**
             * `preview` or `full`.
             *
             * **The cheap copy is the default, always** (R-VID-13). A component
             * that defaulted to the full-rate stream would spend most of a
             * field uplink the moment somebody opened a page, and the operator
             * would have no reason to suspect it. The full rate is reached by
             * *holding* a key — held, not toggled, so nobody leaves it on.
             */
            rate: 'preview'
        }
    },
    computed: {
        /**
         * What the operator's rail last sent this picture.
         *
         * Read from the store rather than a prop, because a soft key's press
         * travels to Node-RED and comes back as a message — which is the only
         * path a *separate* widget has to this one. Without it every mode key
         * on the rail would be a control that reaches nothing: the four
         * `setMode` states and the whole of the held full-rate key were
         * reachable from a unit test and from nowhere else on the page.
         */
        command () {
            return this.$store?.state?.data?.messages?.[this.id]?.payload
        },
        /**
         * The path this session negotiates against.
         *
         * The widget appends `-preview` to the camera's own name — so the
         * *default* cannot be the expensive one by anybody's oversight
         * (picture.ts does the same on the way in). Holding the full-rate key
         * is what takes it off.
         *
         * **The camera's name comes from the message first.** Written into the
         * wiring it was one device's camera id frozen at deploy time, so every
         * board whose camera is not called that got a 404 and a picture
         * reporting "this camera is not streaming" about a camera that was
         * running. The editor field stays as the fall-back for a page that
         * genuinely is about one fixed camera.
         */
        streamPath () {
            const configured = this.props.path || ''
            const path = this.told || configured
            const base = path.endsWith('-preview') ? path.slice(0, -8) : path
            if (!base) return ''
            return this.rate === 'full' ? base : `${base}-preview`
        },
        /**
         * What watching this costs, stated before it is asked (R-VID-11).
         *
         * **From the message, in preference to the editor field.** The
         * configured string is `cameraStrip()`'s own numbers frozen at deploy
         * time and reachable by nothing: raise `bitrate_kbps` and this went on
         * saying 2.07 Mb/s while the readout strip beside it — which is
         * computed — said 8.27. The page contradicted itself, and the figure
         * an operator uses to decide whether to spend a field uplink was the
         * wrong one of the two. The prop stays as the fall-back, so the
         * picture states *something* before the first read arrives.
         *
         * It rides on an object payload because a string payload is already
         * this widget's command channel (see `command` above); the two cannot
         * be confused, and the last cost is kept so a later `rate:` command
         * does not put the stale literal back on screen.
         */
        cost () {
            const payload = this.command
            if (payload && typeof payload === 'object' && typeof payload.cost === 'string') {
                return payload.cost
            }
            return this.sentCost || this.props.cost
        },
        /** The camera named by the last message that named one. */
        told () {
            const payload = this.command
            return payload && typeof payload === 'object' && typeof payload.path === 'string'
                ? payload.path
                : this.sentPath
        },
        staleFor () {
            if (this.mode !== 'live' || this.lastFrameAt === null) return 0
            return Math.max(0, Math.floor((this.now - this.lastFrameAt) / 1000) - 2)
        },
        degradeFilter () {
            if (this.staleFor === 0) return 'none'
            // Saturation to zero and brightness to a third over a minute. Both
            // curves are deliberately slow at the start: a two-second network
            // hiccup should not make the picture flinch.
            const t = Math.min(1, this.staleFor / 60)
            return `saturate(${(1 - t).toFixed(2)}) brightness(${(1 - 0.65 * t).toFixed(2)})`
        },
        tone () {
            if (this.mode === 'off') return 'neutral'
            if (this.staleFor > 0) return 'bad'
            if (this.mode === 'stills') return 'waiting'
            return 'good'
        },
        caption () {
            if (this.mode === 'off') return 'off'
            if (this.mode === 'stills') return 'stills'
            if (this.staleFor > 0) return 'no contact'
            if (this.attempt > 0) return `reconnecting · attempt ${this.attempt}`
            // Named, never implied. An operator who cannot tell which copy
            // they are watching cannot tell what it is costing them.
            return this.rate === 'full' ? 'live · full rate' : 'live · preview'
        },
        ageText () {
            const s = this.staleFor
            return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ${s % 60} s ago`
        }
    },
    watch: {
        /**
         * A key on the rail, arriving as a message.
         *
         * Two vocabularies and nothing else: `mode:live|stills|off` and
         * `rate:full|preview`. Anything else is ignored rather than guessed at
         * — a picture that acted on a message it did not understand would be
         * originating behaviour nobody asked for (R-CMD-04).
         *
         * **Never wire this widget's own output back into it.** `setMode`
         * emits `mode:<mode>` when the operator changes it, so a flow that
         * looped that back would be a picture commanding itself.
         */
        /**
         * The camera this picture is of, changing under it.
         *
         * Nothing in the shipped flows changes it after the first message, but
         * the first message *is* a change — from nothing, or from the editor's
         * fall-back — and a computed with no watcher would leave the session
         * negotiated against the old name under the new label.
         *
         * Against the path the session in hand was actually negotiated with,
         * rather than against the previous value: holding the full-rate key
         * moves this too, and `setRate` renegotiates already, so comparing
         * with the old value would close the session it had just opened. It
         * also means being *told* the camera the picture is already showing —
         * which every read does, five seconds apart — costs nothing.
         */
        streamPath (next) {
            if (this.mode !== 'live' || next === this.negotiated) return
            this.requestLive()
        },
        command (value) {
            if (value && typeof value === 'object') {
                if (typeof value.cost === 'string') this.sentCost = value.cost
                if (typeof value.path === 'string') this.sentPath = value.path
                return
            }
            if (typeof value !== 'string') return
            if (value.startsWith('mode:')) {
                const mode = value.slice(5)
                if (['live', 'stills', 'off'].includes(mode)) this.setMode(mode)
                return
            }
            if (value.startsWith('rate:')) {
                const rate = value.slice(5)
                if (rate === 'full' || rate === 'preview') this.setRate(rate)
            }
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    mounted () {
        this.tick = setInterval(() => { this.now = Date.now() }, 1000)
        // The media clock, which is the only honest source for the age this
        // component draws. See the note on `lastFrameAt` above.
        if (this.$refs.video) this.$refs.video.addEventListener('timeupdate', this.onFrame)
        this.requestLive()
    },
    beforeUnmount () {
        clearInterval(this.tick)
        clearTimeout(this.retryTimer)
        clearTimeout(this.stillsTimer)
        if (this.$refs.video) this.$refs.video.removeEventListener('timeupdate', this.onFrame)
        this.teardown()
    },
    methods: {
        /**
         * A frame reached the screen (R-VID-03).
         *
         * This is the whole of what stands the degrade down, and it clears the
         * attempt count and the reason with it: a picture that is *painting*
         * is the only evidence that the session came back. A handshake that
         * completes and delivers nothing keeps counting, which is what the
         * fall-back to stills is waiting to hear.
         */
        onFrame () {
            this.lastFrameAt = Date.now()
            this.attempt = 0
            this.reason = ''
        },
        /**
         * Nothing in flight: the session, and the handshake that was setting
         * it up.
         *
         * **The picture is deliberately left alone.** A reconnect tears down
         * and rebuilds, and blanking here would delete the last frame between
         * attempts — the one thing still held, and what "holds the picture
         * rather than blanking it" means. `blank()` is the other half, and it
         * is called only where the operator has actually left live video.
         */
        teardown () {
            // Anything still in flight belongs to nobody from here on.
            this.session += 1
            if (this.abort) { this.abort.abort(); this.abort = null }
            if (this.pc) { this.pc.close(); this.pc = null }
        },
        /**
         * Let go of the last live frame.
         *
         * **Closing a peer connection does not clear the screen.** It ends the
         * tracks, and a media element holding an ended stream goes on painting
         * its last decoded frame indefinitely — so `off` used to leave a
         * frozen live frame up, in the *neutral* tone, captioned "off", with
         * the age pinned to zero by `staleFor`: no hatch, no count, no
         * degrade. Identically in `stills` mode with no stills source, which
         * `picture.ts` records as the normal state today, where the frozen
         * frame showed through the `v-if`'d-away `<img>` under a badge reading
         * "stills" in the *waiting* tone.
         *
         * A frozen frame with nothing saying it is frozen is the hazard this
         * whole component exists for, and both of those drew it in a tone
         * meaning nothing is wrong.
         */
        blank () {
            if (this.$refs.video) this.$refs.video.srcObject = null
            this.lastFrameAt = null
        },
        /**
         * The operator asking for a live picture: on mount, whenever the mode
         * is set back to live, and whenever the `streamPath` watcher decides
         * the session in hand is negotiated against the wrong camera.
         *
         * The deadline is armed here because it belongs to the request, not
         * to an attempt (R-VID-14).
         *
         * **A pending backoff must not survive into this request.** Without
         * the line below, a retry armed by an earlier failed attempt kept
         * running underneath a fresh one — and on an ordinary startup, not
         * only behind an operator's key press: the daemon slow to answer, the
         * first negotiation 503s, the first read then names the camera and
         * this method connects and paints, and the stale timer fires into
         * `connect()` a moment later and closes the session that just came
         * up. Same bug shape as `Supervisor.start()`, same fix.
         */
        requestLive () {
            this.attempt = 0
            this.lastFrameAt = null
            this.reason = ''
            this.stillSrc = ''
            clearTimeout(this.retryTimer)
            clearTimeout(this.stillsTimer)
            this.stillsTimer = setTimeout(() => {
                // Twelve seconds: long enough for a slow negotiation to
                // finish, short enough that nobody is left staring at nothing.
                // Falling back changes nothing on the aircraft, so the default
                // is simply the useful one (R-VID-14).
                if (this.mode === 'live' && this.lastFrameAt === null) this.toStills()
            }, this.props.stillsAfterMs || 12000)
            this.connect()
        },
        /**
         * The fall-back, which keeps the reason: the reason is the half of
         * this that tells an operator whether it is worth walking outside.
         */
        toStills () {
            this.mode = 'stills'
            this.stillSrc = this.props.stillsUrl || ''
            clearTimeout(this.retryTimer)
            // Nothing is watching the session now, and a track arriving after
            // this would be live video under a badge reading 'stills'.
            this.teardown()
            this.blank()
        },
        /**
         * One handshake, and the rule that it may only ever speak for itself.
         *
         * **A session check after every await, and an `AbortController` on
         * the fetch.** A handshake nobody is waiting for any more still
         * finishes: holding FULL RATE closes the preview session and opens the
         * full-rate one, and the abandoned preview exchange then resolved into
         * `pc0.setRemoteDescription()`, which rejects with `InvalidStateError`
         * on a closed connection. That became a *reason* on screen and a
         * `retry()`, and the backoff then tore down the good full-rate
         * session: the key dropped the picture it was pressed for. The same
         * path put "this browser could not negotiate a stream" underneath the
         * "off" panel, which contradicts this component's own rule that off
         * must not look like the link being down.
         *
         * The abort stops the request; the session check is what makes an answer
         * that arrives anyway belong to nobody — and one of them always can,
         * because `abort()` cannot recall a response already delivered.
         *
         * The check is at every await rather than only the interesting one:
         * the fetch is the boundary a test can hold open and the only one long
         * enough for an operator to act inside, but "the session may have
         * changed while we were away" is true of all of them, and a rule
         * applied at three awaits out of five is a rule nobody can rely on.
         */
        async connect () {
            this.teardown()
            this.negotiated = this.streamPath
            // Nothing has said which camera this is yet. Not a fault and not a
            // reconnect: the message that names it is what starts this, through
            // the `streamPath` watcher.
            if (!this.streamPath) {
                this.reason = 'this picture has not been told which camera to show'
                return
            }
            const session = this.session
            const mine = () => this.session === session
            const pc = new RTCPeerConnection()
            const abort = new AbortController()
            this.pc = pc
            this.abort = abort
            pc.addTransceiver('video', { direction: 'recvonly' })
            pc.ontrack = (e) => {
                if (!mine()) return
                // Negotiation, not media: `lastFrameAt` is deliberately not
                // set here. The track exists; nothing has painted yet, and
                // `onFrame` is what says otherwise.
                if (this.$refs.video) this.$refs.video.srcObject = e.streams[0]
            }
            pc.onconnectionstatechange = () => {
                if (!mine()) return
                if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.retry()
            }
            try {
                const offer = await pc.createOffer()
                if (!mine()) return
                await pc.setLocalDescription(offer)
                if (!mine()) return
                // Through the console's own route, not straight at the media
                // server: the exchange carries the keys that encrypt the video,
                // and it is what puts the picture behind the interface's
                // credential (R-SEC-13).
                const answer = await fetch(`/video/${this.streamPath}/whep`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/sdp' },
                    body: offer.sdp,
                    signal: abort.signal
                })
                if (!mine()) return
                if (!answer.ok) {
                    // Distinguished deliberately. Only one of these is worth
                    // walking outside for.
                    this.reason = answer.status === 401
                        ? 'this session is not logged in'
                        : answer.status === 404
                            ? 'this camera is not streaming; start it on the rail'
                            : 'the media server is not answering'
                    this.retry()
                    return
                }
                const sdp = await answer.text()
                if (!mine()) return
                await pc.setRemoteDescription({ type: 'answer', sdp })
            } catch (e) {
                // An abandoned handshake is not a fault, and must not report
                // one: this is the branch that used to draw a reason under the
                // "off" panel and reconnect over a working session.
                if (!mine()) return
                this.reason = `this browser could not negotiate a stream (${e.name || 'error'})`
                this.retry()
            }
        },
        retry () {
            // A picture nobody is asking for does not reconnect: an off view
            // that kept negotiating would be spending a cellular uplink on a
            // stream with nothing on screen indicating it.
            if (this.mode !== 'live') return
            const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
            this.attempt += 1
            clearTimeout(this.retryTimer)
            // No button. The operator asked for a live picture and never
            // withdrew the request.
            this.retryTimer = setTimeout(() => this.connect(), wait)
        },
        /**
         * Full rate while the key is held, and the cheap copy the moment it is
         * let go (R-VID-11, R-VID-13).
         *
         * It renegotiates, because the two rates are two paths on the media
         * server — the preview is a second encode of frames already decoded,
         * not a re-scale of the first. The gap is short: the preview branch
         * runs a keyframe interval of its own, so coming back is a late
         * joiner's wait rather than a group of pictures.
         *
         * Nothing is emitted back to Node-RED here. The key that sent this
         * already told the device what the operator asked for, and a second
         * message would be this widget reporting somebody else's press.
         */
        setRate (rate) {
            if (rate === this.rate) return
            this.rate = rate
            if (this.mode === 'live') this.requestLive()
        },
        setMode (mode) {
            this.mode = mode
            if (mode === 'live') {
                this.requestLive()
            } else {
                clearTimeout(this.retryTimer)
                clearTimeout(this.stillsTimer)
                this.teardown()
                this.blank()
                // A mode the operator chose is not a failure, and carries no
                // reason: 'off' is 'not requested', never 'no contact'.
                this.reason = ''
                this.stillSrc = mode === 'stills' ? (this.props.stillsUrl || '') : ''
            }
            this.$socket.emit('widget-action', this.id, { payload: `mode:${mode}`, topic: this.props.label })
        }
    }
}
</script>

<style scoped>
/* **Fills the box the page gave it, and never sets its own height.**
   `aspect-ratio: 16/9` looked right and was not: the widget's height is a
   whole number of grid rows, the width is a fraction of the viewport, and the
   two agree at exactly one window size. Everywhere else the frame was taller
   than its widget and spilled over what followed — 543 px of picture in a
   468 px box, with the reason for the missing picture among the 75 px that
   escaped. The video letterboxes itself inside whatever box it gets
   (`object-fit: contain`), so the aspect ratio was never this element's to
   hold. */
.y-pic { position: relative; background: var(--yonder-display, #04060a); height: 100%; min-height: 160px; overflow: hidden; }
.y-pic__video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: filter 1s linear; }
/* The hatch is the third of four signals, and the one that cannot be mistaken
   for a dark scene or a badly exposed shot. */
.y-pic__hatch {
    position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(45deg,
        transparent 0 14px,
        color-mix(in srgb, var(--yonder-bad, #ff4034) 22%, transparent) 14px 16px);
}
.y-pic__hud { position: absolute; top: 8px; left: 8px; display: flex; gap: 8px; align-items: baseline; }
.y-pic__badge {
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 2px;
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
}
.y-pic__age {
    /* Not uppercased: `s` and `min` are units. */
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 15px; font-weight: 600; text-transform: none;
    color: var(--yonder-bad, #ff4034);
}
.y-pic__cost {
    /* What watching this costs, stated rather than discovered (R-VID-14).
       Never uppercased: kb/s rendered as KB/S says kilobytes. */
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 11px; text-transform: none;
    color: var(--yonder-label, #7f8a95);
}
.y-pic__reason, .y-pic__off {
    position: absolute; left: 8px; right: 8px; bottom: 8px;
    font-family: var(--yonder-font, system-ui, sans-serif); font-size: 12px;
    color: var(--yonder-label, #7f8a95);
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    padding: 4px 6px; border-radius: 2px;
}
.tone-neutral { color: var(--yonder-neutral, #7d7869); }
.tone-waiting { color: var(--yonder-waiting, #ffcf28); }
.tone-good    { color: var(--yonder-good, #35d06a); }
.tone-bad     { color: var(--yonder-bad, #ff4034); }
</style>
