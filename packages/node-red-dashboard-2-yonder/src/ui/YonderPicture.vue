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
            <span v-if="props.cost" class="y-pic__cost">{{ props.cost }}</span>
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
            attempt: 0,
            lastFrameAt: null,
            now: Date.now(),
            reason: '',
            stillSrc: '',
            stillsTimer: null,
            retryTimer: null,
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
         * `path` from the editor is the camera's own name, and the widget
         * appends `-preview` to it — so the *default* cannot be the expensive
         * one by anybody's oversight (picture.ts does the same on the way in).
         * Holding the full-rate key is what takes it off.
         */
        streamPath () {
            const path = this.props.path || ''
            const base = path.endsWith('-preview') ? path.slice(0, -8) : path
            return this.rate === 'full' ? base : `${base}-preview`
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
        command (value) {
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
        this.requestLive()
    },
    beforeUnmount () {
        clearInterval(this.tick)
        clearTimeout(this.retryTimer)
        clearTimeout(this.stillsTimer)
        this.teardown()
    },
    methods: {
        teardown () {
            if (this.pc) { this.pc.close(); this.pc = null }
        },
        /**
         * The operator asking for a live picture: on mount, and whenever the
         * mode is set back to live.
         *
         * The deadline is armed here because it belongs to the request, not
         * to an attempt (R-VID-14).
         */
        requestLive () {
            this.attempt = 0
            this.lastFrameAt = null
            this.reason = ''
            this.stillSrc = ''
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
        },
        async connect () {
            this.teardown()
            const pc = new RTCPeerConnection()
            this.pc = pc
            pc.addTransceiver('video', { direction: 'recvonly' })
            pc.ontrack = (e) => {
                if (this.$refs.video) this.$refs.video.srcObject = e.streams[0]
                // The deadline reads this and stands down: a picture that has
                // arrived and then goes stale is the degrade's, which holds
                // the last frame rather than replacing it with a still.
                this.lastFrameAt = Date.now()
                this.attempt = 0
                this.reason = ''
            }
            pc.onconnectionstatechange = () => {
                if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.retry()
            }
            try {
                const offer = await pc.createOffer()
                await pc.setLocalDescription(offer)
                // Through the console's own route, not straight at the media
                // server: the exchange carries the keys that encrypt the video,
                // and it is what puts the picture behind the interface's
                // credential (R-SEC-13).
                const answer = await fetch(`/video/${this.streamPath}/whep`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/sdp' },
                    body: offer.sdp
                })
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
                await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
            } catch (e) {
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
