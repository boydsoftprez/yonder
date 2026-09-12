<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-pic" :class="{ 'y-pic--scene': scene }">
        <header v-if="!scene" class="y-pic__toolbar" aria-label="Video status">
            <div class="y-pic__controls">
                <strong v-if="selectedCameraName" class="y-pic__camera" :title="selectedCameraName">{{ selectedCameraName }}</strong>
                <div class="y-pic__view-modes" role="group" aria-label="This preview">
                    <span>This preview</span>
                    <button v-for="choice in ['live', 'stills', 'off']" :key="choice" type="button" :aria-pressed="mode === choice" :disabled="signInRequired" @click="setMode(choice)">{{ { live: 'Live', stills: 'Stills', off: 'Off' }[choice] }}</button>
                </div>
                <a v-if="signInRequired" :href="signInHref" class="y-pic__action">Sign in</a>
                <button v-else type="button" class="y-pic__action" :disabled="!videoControl.action || videoRequestPending" @click="pressVideoAction">{{ videoRequestPending ? 'Requesting…' : videoControl.label }}</button>
            </div>
            <div class="y-pic__hud">
                <span class="y-pic__badge" :class="'tone-' + tone">{{ caption }}</span>
                <span v-if="staleFor > 0" class="y-pic__age">{{ ageText }}</span>
                <span v-if="cost && !previewState" class="y-pic__cost">{{ cost }}</span>
            </div>
            <span v-if="aimable" class="y-pic__aim-help">Drag and hold to move · farther = faster · Shift for fine control · release to stop</span>

            <!-- R-VID-18: what the shared preview encode is doing, composed
                 verbatim from Task 19's own part — see this file's own doc
                 comment on why this is a second, orthogonal fact from the
                 badge above rather than a replacement for it. -->
            <YonderStateOverlay v-if="previewState" class="y-pic__state" :head="previewState.head" :size="previewState.size" :rate="previewState.rate" :bitrate="previewState.bitrate" :step="previewState.step" />

            <div v-if="recording" class="y-pic__rec"><i class="y-pic__rec-dot"></i>REC {{ recording.elapsed }}</div>

            <div v-if="footItems.length" class="y-pic__foot">
                <span v-for="item in footItems" :key="item.key" class="y-pic__foot-item">
                    <span class="y-pic__foot-k">{{ item.label }}</span>{{ item.text }}
                </span>
            </div>

            <div v-if="stats" class="y-pic__osd">
                <span class="y-pic__foot-k">LINK</span>{{ stats.linkMbps.toFixed(2) }} Mb/s<br />
                <span class="y-pic__foot-k">DROP</span>{{ stats.dropPct.toFixed(1) }} %
            </div>

            <span v-if="deliveryState?.mine?.receiverBufferMs != null" class="y-pic__receiver" title="Browser jitter buffer and decode time; these do not measure total camera-to-screen latency.">Buffer {{ Math.round(deliveryState.mine.receiverBufferMs) }} ms<span v-if="deliveryState.mine.decodeMs != null"> · decode {{ deliveryState.mine.decodeMs.toFixed(1) }} ms</span></span>
        </header>
      <div class="y-pic__fit">
        <div
            ref="frame"
            class="y-pic__frame"
            :class="{ 'is-aiming': aimable }"
            :style="scene ? null : { aspectRatio: videoAspect, '--y-pic-aspect': String(videoAspect) }"
            @pointerdown="dragDown"
            @pointermove="dragMove"
            @pointerup="onDragEnd"
            @pointercancel="onDragEnd"
            @pointerleave="onDragLeave"
            @lostpointercapture="onDragEnd"
        >
            <video
                ref="video"
                class="y-pic__video"
                :style="{ filter: degradeFilter }"
                autoplay
                muted
                playsinline
                @pause="onPlaybackPause"
            ></video>
            <img v-if="mode === 'stills' && stillSrc" class="y-pic__video" :src="stillSrc" alt="" />
            <div v-if="staleFor > 0" class="y-pic__hatch"></div>

            <!-- L-18: a still landed. The flash is the confirmation that
                 something happened at the moment the key was pressed
                 (R-UI-05); the banner says where it went. -->
            <div v-if="flashing" class="y-pic__flash" aria-hidden="true"></div>

            <div v-if="dragPointerId !== null" class="y-pic__stick-origin" :style="{ left: originX + 'px', top: originY + 'px' }" aria-hidden="true"></div>
            <div v-if="dragGesture" class="y-pic__orb" :style="{ left: orbX + 'px', top: orbY + 'px' }" aria-hidden="true"></div>

            <div v-if="mode === 'off'" class="y-pic__off">
                Preview is off in this browser.
            </div>
            <!-- The cockpit's own unavailable convention, in the window
                 (R-UI-20; JJ's ruling of 2026-09-12). See `unavailableMark`. -->
            <div v-if="showUnavailableMark" class="y-pic__unavailable" role="status">
                <svg class="y-pic__missing" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M0 0L100 100M100 0L0 100" />
                </svg>
                <span class="y-pic__stopped-l y-pic__missing-l">{{ unavailableLabel }}</span>
            </div>
            <div v-if="!signInRequired && !showUnavailableMark && ['stopped', 'failed'].includes(cameraRunState)" class="y-pic__stopped">
                <span class="y-pic__stopped-l">{{ videoControl.message }}</span>
                <!-- R-FLT-29: the message is a reason and stays; the button
                     starts the device's stream and must not exist in the
                     scene presentation, which is the flight display. See
                     this file's own `scene` prop doc comment. -->
                <button v-if="!scene" type="button" class="y-pic__start" :disabled="videoRequestPending || !videoControl.action" @click="pressStart">{{ videoRequestPending ? 'Requesting…' : videoControl.label }}</button>
            </div>
            <!-- R-UI-20 in the scene presentation: one line saying why the
                 picture is not what was asked for, and the one control that
                 is the operator's own browser rather than the aircraft. See
                 the `scene` prop's own doc comment. -->
            <div v-if="scene && ((reasonLine && noticeReason) || playbackBlocked)" class="y-pic__scene-notice">
                <div v-if="reasonLine && noticeReason" class="y-pic__reason" role="status">{{ noticeReason }}</div>
                <button v-if="playbackBlocked" type="button" class="y-pic__resume" @click="resumePlayback">Resume live video</button>
            </div>
        </div>
      </div>

        <div v-if="!scene" class="y-pic__capture-host"></div>

        <div v-if="!scene" class="y-pic__notices">
            <button v-if="playbackBlocked" type="button" class="y-pic__resume" @click="resumePlayback">Resume live video</button>
            <div v-if="noticeReason" class="y-pic__reason" role="status">{{ noticeReason }}</div>
            <div v-if="flashing" class="y-pic__saved" role="status"><i class="y-pic__saved-dot" aria-hidden="true"></i>Saved · to {{ savedTo }}</div>
        </div>

        <div v-if="!scene" class="y-pic__thumbnails">
            <YonderThumbStrip
                v-if="cameras.length"
                class="y-pic__strip"
                :cameras="cameras"
                :downlink="downlink"
                @go="onThumbGo"
            />
        </div>
    </div>
</template>

<script>
import { videoAction, previewFailure } from './camera-workflow.ts'
import { cameraSessionMixin, expireCameraSession } from './camera-session.ts'
import { AimTransport } from './aim-transport.ts'
import { AIM_RESPONSE_CHANGED, EXPO_KEY, SPEED_KEY, savedNumber, rateLimit, responseMagnitude, hasWireMotion } from './aim-response.ts'
import { ThumbnailDemand } from './thumbnail-demand.ts'
import YonderStateOverlay from './YonderStateOverlay.vue'
import YonderThumbStrip from './YonderThumbStrip.vue'
import { atIp, cameraFor, DESCRIPTORS, heldWords } from 'yonder-core/presentation'

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
 * count.** No button: the operator asked for a live picture and never
 * withdrew the request. The picture returns immediately when it does, because
 * the preview branch runs a short keyframe interval of its own (pipeline.ts)
 * — so a reconnecting browser is a late joiner that does not have to wait out
 * a group of pictures.
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
 *
 * ---
 *
 * **Three more defects, fixed together (R-VID-18, R-UI-28), because this
 * component already exists and this task is fixing and extending it rather
 * than starting over.**
 *
 * **1. The picture is the shape of the picture.** `.y-pic__frame` used to be
 * `.y-pic` itself, filling whatever box the page gave it (`height: 100%`) and
 * trusting `object-fit: contain` to letterbox or crop whatever the camera's
 * real aspect ratio turned out to be. That box was never this component's own
 * fact to assume: a camera that is not 16:9 was silently letterboxed or
 * cropped inside a page built for one that is, and an operator looking at a
 * badly-shaped picture had no way to tell a badly-aimed camera from a badly-
 * built page. `videoAspect` is read from the `<video>` element's own
 * `loadedmetadata` event — `videoWidth`/`videoHeight`, the decoder's own
 * report of the stream it just negotiated — and drives `aspect-ratio`
 * directly, so the box takes the shape of what is actually arriving. It holds
 * its last known value across a reconnect rather than resetting to the 16:9
 * default, for the same reason `blank()` leaves the last frame on screen:
 * the shape of the picture is exactly as much "the one thing still held" as
 * the pixels are.
 *
 * **And it is never taller than the slot the page gave it.** Taking the
 * shape from the decoder answered half the question and left the other half
 * open: `aspect-ratio` with `width: 100%` derives a height from a width
 * nothing has compared against the widget's own grid area, and the two agree
 * at one window size. The capture gate measured the disagreement — 543 px of
 * picture in the 408 px seven rows buy, 633 px at 1440 — which is the same
 * arithmetic as the original defect with the ratio corrected. So the frame
 * is now sized by *both* constraints at once, in `.y-pic__frame`'s own CSS
 * comment below: the width is the lesser of the room across and the room
 * down, and `aspect-ratio` turns whichever won into the height. The shape is
 * still the camera's own — nothing here letterboxes or crops, and a portrait
 * sensor still draws a portrait box — it is simply drawn at the largest size
 * that fits, with the room left over as empty panel. This is the third shape
 * of this fix and the first that satisfies both halves; the two that did not
 * are named in that comment so neither is reintroduced.
 *
 * **2. Every overlay is in front of the video, by an explicit `z-index`, not
 * by DOM order alone.** This is the defect the task is named for: a
 * hardware-decoded `<video>` element can composite in a layer of its own that
 * ignores the paint order later siblings would otherwise get for free, so
 * this file no longer leaves that to chance. `.y-pic__video` and the stills
 * `<img>` that can replace it sit at `z-index: 1`; the hatch — which must
 * wash over the video but never obscure a reading drawn on top of it — sits
 * at `z-index: 2`; every informational overlay (the hud, the state overlay,
 * the REC pill, the foot strip, the link/drop readout, the drag orb, the
 * reason and off panels) sits at `z-index: 5`. Declared, not measured:
 * `jsdom` performs no layout, so `picture.component.test.ts` compares these
 * declared values against each other rather than anything it would have to
 * render to see.
 *
 * **3. The picture wears its own state**, rather than staying silent about a
 * preview that has quietly stepped down to a smaller size or a lower rate.
 * `YonderStateOverlay` (Task 19) is composed with plain props, exactly the
 * way that component's own doc comment says this rework would — the whole
 * daemon-formatted preview-state message (§8.2), never redrawn or
 * reformatted here. It is a **second, orthogonal fact** from the existing
 * mode badge above it: the badge reports *this browser's own WebRTC session*
 * (observed entirely from `RTCPeerConnection` events and the video's own
 * `timeupdate`, with no daemon message involved at all — live, reconnecting,
 * no contact, stills, off) while the state overlay reports *the shared
 * preview encode's policy* (adaptive, pinned at its floor, holding a chosen
 * size, full rate because an operator is holding the key, or itself in a
 * stills fallback). A healthy session can be showing a stepped-down picture,
 * and a session busy reconnecting says nothing about what size the encode
 * last held — collapsing the two into one badge would silently drop
 * whichever fact lost.
 *
 * **The REC pill, the foot strip and the link/drop readout are the same
 * "picture" table from the spec (§7), each drawing what it is given and
 * deciding nothing new:** `recording` is `{ elapsed }`, pre-formatted by
 * whichever source is authoritative for it (§8.5 — the camera's own state
 * push, or the board recorder's observed state, according to destination);
 * this component does not compute a duration from a start time. `stats` is
 * `{ linkMbps, dropPct }` — "WebRTC stats in the browser" per the spec's own
 * words, a live reading this component would compute itself from
 * `RTCPeerConnection.getStats()`, wired up where the rest of the rate
 * controller is (§8.1, a later phase); until then it draws whatever the
 * message channel below hands it, which is enough to prove the drawing is
 * right without inventing a polling loop this task was not asked to build.
 *
 * **The foot strip's PAN/TILT read a fixed `°`, unstyled by any capability
 * descriptor — `DESCRIPTORS.aim` carries no sub-unit for either axis, the
 * same reason `YonderAim.vue`'s own gauges hardcode it — but ZOOM and the
 * exposure reading are display units and a label read straight from
 * `video/descriptors.ts` via `yonder-core/presentation`, never reformatted
 * by hand here.** `DESCRIPTORS.zoom.toDisplay`/`DESCRIPTORS.exposure.toDisplay`
 * are the exact functions the config schema and the write path already use
 * (a raw exposure count of 156 is 15600 µs both places); a second, hand-
 * rolled multiply-by-100 living in this file as well is precisely the second
 * source of truth that drifts the moment one of the two is changed and the
 * other is not. `sentenceLabel` is not used here — these labels are a
 * heading, not mid-sentence — so `.label` is read directly and uppercased in
 * script, the identical technique `YonderStateOverlay`'s own `headWord`
 * fallback uses and for the same stated reason: what a test reads through
 * `.text()` must be exactly what is on screen, not a capitalisation only a
 * stylesheet rule performs.
 *
 * **The thumb strip sits *beneath* the picture, not on top of it**
 * (`docs/console/design/instrument-library/README.md`'s own round-2
 * correction: "a strip under the picture with the other cameras… A press on
 * a thumbnail switches"), so it is a normal-flow sibling of `.y-pic__frame`
 * rather than one more absolutely-positioned overlay — it never enters the
 * front-of-the-video z-index question at all, because it never shares the
 * video's own stacking context. `YonderThumbStrip` (Task 19) is composed
 * with plain props, exactly as that component's own doc comment states this
 * rework would. A press names the camera whose thumbnail was pressed —
 * `YonderThumbStrip`'s own contract is an id, never a position in the array
 * — and this component treats it exactly the way it already treats being
 * *told* a camera by an incoming message: `sentPath` is updated directly, so
 * the existing `streamPath` watcher renegotiates through the exact path this
 * file already had for that (`told`, above), and the flow is also notified,
 * the same "so the flow knows what the operator asked for" reasoning
 * `setMode` already gives for its own press.
 *
 * **The drag-to-slew layer is "the orb only"** (spec §6: "the drag-to-slew
 * layer (orb only, measured from where the finger landed)") — a full pan/
 * tilt/mode/Recentre panel is `YonderAim.vue`'s own job (Task 23), composed
 * beside this picture wherever a page has room for both; duplicating any of
 * that here would be two controls able to disagree about the same gimbal.
 * What this component draws is a single affordance: press anywhere on the
 * picture and drag, and a haloed orb tracks the pointer while a rate is
 * commanded proportional to *how far the pointer has moved from where it
 * first went down* — never from the centre of the frame, because an operator
 * whose thumb lands near an edge is asking for a rate proportional to their
 * own drag distance, not to their thumb's incidental starting position
 * (coordinator resolution 5). This is exactly the blueprint's own
 * `DraftPicture.vue` reasoning ("Rate is measured from where the finger went
 * down, not from the centre of the frame: a thumb starts wherever it lands"),
 * carried into a component whose box no longer has a fixed pixel size to
 * measure against (defect 1, above) — so unlike that draft, and unlike
 * `YonderAimPad`'s own dial, the rate here is computed from the raw
 * `clientX`/`clientY` delta alone, with **no division by any measured
 * `getBoundingClientRect()` width or height anywhere in the tested path**.
 * That sidesteps this whole plan's own recurring `jsdom`-measures-everything-
 * zero trap entirely, rather than working around it with a constant the way
 * `YonderAimPad`'s own `DIAL_SIZE` has to: a constant stood in for a *fixed*
 * SVG viewport there; this box has no fixed size to stand in for, by design.
 * The dead zone and the full-rate distance (`DRAG_DEAD`, `DRAG_RANGE` below)
 * are themselves in raw CSS pixels for the same reason, and `DRAG_MAX_RATE`
 * matches `YonderAimPad`'s own `MAX_RATE` so a rate commanded from the
 * picture and a rate commanded from the aim panel mean the same thing to
 * whatever reads them.
 *
 * **The emitted events are the pad's own gesture contract, relayed by a
 * second, independent state machine, not a shared one.** `slew` carries
 * `pan`, `tilt`, a lifetime-monotonic `seq` and a `gesture` id minted fresh
 * only when a drag leaves the dead zone; `stop` carries `gesture` alone —
 * `YonderAimPad`'s own design (Task 20), and `YonderAim.vue`'s own doc
 * comment on why `stop` never gains a `pan: 0, tilt: 0` of its own invention.
 * This is a **second implementation of that same shape**, not a shared one,
 * because this component draws a full video frame with no SVG dial inside
 * it to delegate to — but the state machine itself mirrors `YonderAimPad`'s
 * own proven one method-for-method (`dragDown`/`dragMove` ~ `down`/`move`,
 * `updateDrag` ~ `updateFromEvent`, `endDragGesture` ~ `endGesture`,
 * `onDragEnd` ~ `onEnd`), including the two traps Task 20's own review
 * found: **exactly one `stop` for every ending**, with idempotency living in
 * exactly one guard (`endDragGesture`'s own `dragGesture === null` check,
 * never duplicated in `onDragEnd`), and **all eight endings** — the four
 * pointer events bound on `.y-pic__frame` in the template above, plus
 * `blur`, `visibilitychange` turning the tab hidden, and `pagehide`, attached
 * in `mounted()`/removed in `beforeUnmount()` below, plus the dead zone
 * itself ending the gesture on `updateDrag`. And **inhibited emits nothing**:
 * `dragDown` refuses the press outright while `aimable` is false, and the
 * `watch: { aimable }` below ends an in-flight gesture immediately if aim
 * stops being available mid-drag, the identical second guard
 * `YonderAimPad`'s own `updateFromEvent` needs for a fault arriving between
 * presses. `aimable` gates on `aim.state === 'present'` alone: `not-offered`,
 * `advertised` and `gated` all mean no drag layer here, because a struck or
 * dead orb duplicating `YonderAim.vue`'s own four-state vocabulary a second
 * time would be exactly the coupling this split into two components exists
 * to avoid — a camera whose aim is not fully live draws that fact once, on
 * the aim panel, not twice.
 *
 * **The trap Task 23's own review found, named directly so it is not
 * repeated a third time:** comparing only the *first* relayed event against
 * the pad's *first* emitted event lets a hardcoded `seq: 1` through, because
 * the first slew's own `seq` genuinely is 1 — the assertion would agree with
 * a mutant by coincidence. `picture.component.test.ts`'s own drag tests drag
 * far enough that the counter has visibly moved past 1, assert that it
 * moved, and only then compare — the same fix, independently re-derived for
 * a second gesture engine with the identical shape.
 *
 * **The three-tier fallback this file already had for `cost` and the
 * camera's own name — the live message, then the last message that set it,
 * then a configured default — is generalised here to eight more fields
 * rather than hand-written eight more times.** `fromPayload(key)` reads
 * `this.command` directly first (so a field arriving on *this* message is
 * never stale for even one tick behind its own watcher), falls back to
 * `sentExtra` (refreshed by the `command` watcher below, exactly the way
 * `sentCost`/`sentPath` already are, so a field set by an *earlier* message
 * survives a *later* one that does not repeat it), and finally falls back to
 * `this.props.report` — a static, editor-configured object with the same
 * shape, so a page that draws this picture with **no store at all** (R-UI-
 * 28: the Cockpit embeds it without a deck) still has a way to show a real
 * state rather than an empty one. `YonderAim.vue`'s own `report` computed is
 * the direct precedent: this is the identical live-then-configured
 * precedence, generalised across a wider payload instead of one field.
 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

/** The picture's own richer facts (R-VID-18), cached the same way `cost`
 * and the camera's own name already are — see `fromPayload`'s own doc
 * comment above for why one loop replaces eight hand-written pairs. */
const PAYLOAD_KEYS = ['state', 'runState', 'runReason', 'startBlocked', 'running', 'recording', 'cameras', 'downlink', 'aim', 'zoom', 'exposure', 'stats', 'saved']

/** `+12.4` / `−12.4` — a proper minus sign, matching every other signed
 * reading this console already draws (`YonderAim.vue`'s own gauges, the
 * blueprint's own `fmt()`), never a hyphen. */
function signed (n, digits = 1) {
    return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(digits)
}

/** How long a recording has been running, `00:13:47`. The same reading
 *  `YonderShutter` draws beside its own key, so the pill over the picture and
 *  the key under it cannot disagree about the same recording. */
export function elapsedWords (ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** How long the white flash and the banner stay up (the blueprint's own
 *  figure): long enough to be seen without being in the way of the picture. */
export const FLASH_MS = 1200

/**
 * The drag-to-slew layer's own geometry, in raw CSS pixels — see this
 * file's own doc comment on why nothing here divides by a measured
 * `getBoundingClientRect()` width or height.
 */
const DRAG_DEAD = 8
const DRAG_RANGE = 64
/** Degrees per second at full extension — matches `YonderAimPad`'s own
 * `MAX_RATE`, so a rate commanded from here and one commanded from the aim
 * panel mean the same thing to whatever reads them. */
const DRAG_MAX_RATE = 30

/** A fresh id for a new drag gesture — module-scoped for the identical
 * reason `YonderAimPad`'s own `newGestureId` is: two mounted pictures, and
 * two separate drags within one, must never collide or share an id. */
let dragGestureCounter = 0
function newDragGestureId () {
    dragGestureCounter += 1
    return 'drag-' + dragGestureCounter
}

/**
 * The header the console's stream handshake answers with — this
 * component's own copy of `VIEWER_HEADER` (`console/middleware.ts`).
 *
 * **Not imported.** That file opens with `import { createHash } from
 * "node:crypto"`, which is exactly what `yonder-core/presentation`'s own
 * doc comment keeps out of a browser bundle — the first attempt to reach a
 * runtime value past that boundary failed there once already (see that
 * file's own account of `reading()` and rollup following the barrel to
 * `readFileSync`). A header *name* cannot drift the quiet way the `-preview`
 * suffix could: the moment the two disagree, every report from every
 * session stops reaching the daemon at once, on a header `middleware.test.ts`
 * already asserts by this exact string — not a silent divergence on one
 * camera's id, but a total, immediately visible one.
 */
const VIEWER_HEADER = 'x-yonder-viewer'

/** How often a live session tells the device what it is measuring (R-VID-07,
 * R-VID-11, R-VID-19). One second, matching the tick the rate controller
 * itself runs on (`video/adaptation.ts`) — a slower report would leave that
 * tick reasoning about a reading older than the decision it feeds. */
const REPORT_INTERVAL_MS = 1000
const DECODE_STALL_MS = 5000

/**
 * One tick's own raw numbers off `RTCPeerConnection.getStats()` — the
 * inbound video RTP stream and the candidate pair actually carrying it,
 * reduced to exactly what a report needs to diff against the previous tick.
 *
 * Null whenever either is missing — which is ordinary for the first calls
 * after a handshake, before the browser has picked a pair or decoded a
 * frame — and this component reports nothing for a tick it is null on
 * rather than sending a partial reading `ViewerStats` does not allow (every
 * one of `rtt`/`loss`/`egress`/`capacity` is required).
 *
 * `report` is the `RTCStatsReport` itself: a `Map`-like object, iterated with
 * `forEach` because that is the one method every implementation (real and
 * this suite's own fake) agrees on.
 */
function sampleReport (report) {
    let inbound = null
    let pair = null
    const entries = new Map()
    report.forEach((entry, id) => {
        entries.set(entry.id || id, entry)
        if (!inbound && entry.type === 'inbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video')) {
            inbound = entry
        }
        if (!pair && entry.type === 'candidate-pair' && entry.state === 'succeeded') {
            pair = entry
        }
    })
    const selected = entries.get(inbound?.transportId)?.selectedCandidatePairId
    if (selected) pair = entries.get(selected) || null
    if (!inbound || !pair) return null
    if (typeof inbound.packetsLost !== 'number' || typeof inbound.packetsReceived !== 'number'
        || typeof inbound.bytesReceived !== 'number' || typeof pair.currentRoundTripTime !== 'number') {
        return null
    }
    return {
        at: performance.now(),
        packetsLost: inbound.packetsLost,
        packetsReceived: inbound.packetsReceived,
        bytesReceived: inbound.bytesReceived,
        currentRoundTripTime: pair.currentRoundTripTime,
        availableIncomingBitrate: typeof pair.availableIncomingBitrate === 'number' && Number.isFinite(pair.availableIncomingBitrate) && pair.availableIncomingBitrate > 0
            ? pair.availableIncomingBitrate
            : null,
        frameWidth: typeof inbound.frameWidth === 'number' ? inbound.frameWidth : null,
        frameHeight: typeof inbound.frameHeight === 'number' ? inbound.frameHeight : null,
        framesPerSecond: typeof inbound.framesPerSecond === 'number' ? inbound.framesPerSecond : null,
        jitterBufferDelay: inbound.jitterBufferDelay,
        jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
        totalDecodeTime: inbound.totalDecodeTime,
        framesDecoded: inbound.framesDecoded
    }
}

/**
 * `sample`, `prev` (the same shape, one tick earlier), the camera this
 * report is about and this browser's own `lastFrameAt`, turned into the body
 * `POST /video/<streamPath>/report` sends — or `null`, when the interval
 * between the two samples was not positive (a stopped clock is not a rate)
 * or nothing about this pair of ticks is a delta yet.
 *
 * A pure function, and tested as one directly: everything about *what a
 * report says*, kept out of the timer/session bookkeeping around it.
 */
function reportBody (camera, prev, sample, lastFrameAt) {
    const dtSeconds = (sample.at - prev.at) / 1000
    if (!(dtSeconds > 0)) return null
    const lostDelta = Math.max(0, sample.packetsLost - prev.packetsLost)
    const recvDelta = Math.max(0, sample.packetsReceived - prev.packetsReceived)
    const loss = lostDelta + recvDelta > 0 ? Math.min(1, lostDelta / (lostDelta + recvDelta)) : 0
    const byteDelta = Math.max(0, sample.bytesReceived - prev.bytesReceived)
    // `bytesReceived` is this inbound-rtp entry's own payload bytes — the
    // same layer `IP_OVERHEAD` (yonder-core/presentation, `video/present.ts`)
    // was measured from on the way out — so the interval rate is converted
    // through the identical `atIp()` the rate controller already reasons in,
    // rather than a second, unmeasured overhead figure invented here.
    const egress = atIp((byteDelta * 8) / 1000 / dtSeconds)
    const averageMs = (time, priorTime, count, priorCount) => [time, priorTime, count, priorCount].every(Number.isFinite)
        && count > priorCount && time >= priorTime ? (time - priorTime) * 1000 / (count - priorCount) : null
    const receiverBufferMs = averageMs(sample.jitterBufferDelay, prev.jitterBufferDelay, sample.jitterBufferEmittedCount, prev.jitterBufferEmittedCount)
    const decodeMs = averageMs(sample.totalDecodeTime, prev.totalDecodeTime, sample.framesDecoded, prev.framesDecoded)
    return {
        stats: {
            camera,
            rtt: sample.currentRoundTripTime * 1000,
            loss,
            egress,
            // The browser's own bandwidth estimate, already expressed at the
            // channel level GCC/BWE reasons about — unlike `egress` above, it
            // is not run through `atIp()`, which is calibrated for a
            // configured *encoder* rate and would double-count an overhead
            // this figure does not carry in the first place.
            capacity: sample.availableIncomingBitrate === null ? null : sample.availableIncomingBitrate / 1000,
            ...(receiverBufferMs !== null ? { receiverBufferMs } : {}),
            ...(decodeMs !== null ? { decodeMs } : {}),
            ...(lastFrameAt !== null ? { frameAge: Math.max(0, sample.at - lastFrameAt) } : {}),
            ...(sample.frameWidth && sample.frameHeight ? { size: `${sample.frameWidth}x${sample.frameHeight}` } : {}),
            ...(sample.framesPerSecond ? { fps: sample.framesPerSecond } : {})
        }
    }
}

export default {
    name: 'YonderPicture',
    mixins: [cameraSessionMixin],
    components: { YonderStateOverlay, YonderThumbStrip },
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) },
        /**
         * R-FLT-29: the flight display's own presentation of this picture —
         * frame and video only, filling the parent with `object-fit: cover`,
         * none of this component's own chrome. A fourth sibling of the three
         * props above, not a key inside `props`: those are the editor-
         * configured, per-widget facts (path, label, cost, …); this is a
         * host telling the component which of its two presentations to
         * draw, the same kind of fact `aimable` already is internally.
         * The Camera and Cockpit pages never set it and are unaffected.
         *
         * **Two things are drawn in the scene besides the frame, and only
         * when they are true.** The operator ruled on this after the
         * whole-branch review: one line of reason when there is one, and
         * nothing at all when the picture is fine. The design's "no chrome
         * in the scene" (decision 2) is about controls and readings that
         * repeat what the PFD already says; a picture that is black for a
         * reason the operator cannot see is R-UI-20's silent absence, which
         * is the worse fault. So `.y-pic__reason` appears in the scene when
         * something is wrong, and **Resume live video** appears when this
         * browser blocked autoplay — the one case where the picture is
         * recoverable from here, by this browser, with nothing sent to the
         * aircraft or the device. The stopped-state *message* is likewise
         * kept; its Start button is not, because that starts the device's
         * stream (R-CMD-04, R-FLT-29). Nothing else: no toolbar, no badge,
         * no strip, no capture host, no saved banner.
         */
        scene: { type: Boolean, default: false },
        /**
         * Draw the one-line reason in the scene presentation (R-UI-20, the
         * operator's ruling on decision 2). Off by default, and the host
         * sets it only where the line can actually be read.
         *
         * **This exists because a box can be too small for a sentence.** The
         * scene presentation serves two boxes: the whole attitude scene, and
         * the camera window, which is a sixth of the scene's width — about
         * 140 x 55 px on the Flight page, with roughly 40 px of usable
         * height. "The video service is unavailable. Reconnecting
         * automatically." is 68 px of text there however it is set, so it
         * cannot be shown whole; the page gate measured exactly that and
         * refused it, correctly, as content hidden from the operator
         * (`console/theme.ts`, "content is never clipped"). Truncating it
         * was worse: the bottom-anchored version kept the tail and dropped
         * the words that say what is wrong.
         *
         * So the sentence goes where it fits — the full scene, where the
         * host sets this prop — and the window does not get it at all:
         * settled by the operator on 2026-09-12, a window with no live
         * picture shows the cockpit's own unavailable mark instead
         * (`unavailableMark` below) — the red cross with its one-line label —
         * which suppresses the older stopped-state message wherever it is
         * set. The resume control is unaffected: it is `playbackBlocked`,
         * not this prop, that puts it up.
         */
        reasonLine: { type: Boolean, default: false },
        /**
         * Mark this picture the way the cockpit marks an instrument with no
         * reading: the red cross and a one-line label (R-UI-20, the
         * operator's ruling of 2026-09-12). Off by default; the host sets it
         * on the camera window.
         *
         * **Why a cross and not a sentence.** The window is about 140 x 55 px
         * and cannot show a delivery-failure sentence without hiding part of
         * it — the page gate measured 68 px of text in 40 px and refused it.
         * The choice was then a blank black box, a shorter word, or the
         * convention the rest of the cockpit already uses for "no data". The
         * operator chose the convention: a window with no picture reads as
         * one more instrument with nothing behind it, rather than as a
         * different idea the operator has to learn.
         *
         * **It never covers a frame.** `lastFrameAt === null` is the whole
         * condition, so a picture that has had media and then went quiet keeps
         * that media, desaturated, darkened and hatched, with its age in the
         * window's header — this file's own account of why going black is
         * rejected applies exactly as much to a red cross.
         */
        unavailableMark: { type: Boolean, default: false }
    },
    emits: ['stale'],
    data () {
        return {
            mode: 'live',
            videoRequestPending: false,
            videoRequestTimer: null,
            wantsLive: true,
            fallbackRetryTimer: null,
            deliveryState: null,
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
            frameNow: performance.now(),
            frameCallback: null,
            playbackBlocked: false,
            now: Date.now(),
            reason: '',
            stillSrc: '',
            stillsTimer: null,
            retryTimer: null,
            /** The last cost the flow sent, held across later commands. */
            sentCost: '',
            /** The camera the flow last said this picture is of. */
            sentPath: null,
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
            rate: 'preview',
            /** The `<video>`'s own reported shape (defect 1, see this file's
             * own doc comment) — `videoWidth / videoHeight` from
             * `loadedmetadata`, holding its last value across a reconnect
             * rather than resetting. 16:9 until a stream has ever answered. */
            videoAspect: 16 / 9,
            /** The last message's own richer facts (R-VID-18) — see
             * `fromPayload`'s own doc comment above. */
            sentExtra: {},
            /**
             * The still this picture is currently confirming (L-18).
             *
             * `flashAt` is the `at` of the capture being shown, so a *second*
             * still while the first is still flashing restarts the
             * confirmation rather than being swallowed by it; `flashing`
             * is what the two overlays are drawn from, and `flashTimer` ends
             * it. A timer rather than the once-a-second `now` clock this
             * component already keeps: a 1.2 s confirmation driven off a 1 s
             * tick lasts between 1.2 and 2.2 seconds, which is visible.
             */
            flashAt: null,
            flashing: false,
            flashTimer: null,
            savedTo: '',
            aimRefusal: null,
            /** The drag-to-slew layer's own gesture state — see this file's
             * own doc comment on why this mirrors `YonderAimPad` method-for-
             * method rather than sharing its implementation. */
            dragPointerId: null,
            dragGesture: null,
            dragSeq: 0,
            responseExpo: savedNumber(EXPO_KEY, 50, 0, 100),
            responseSpeed: savedNumber(SPEED_KEY, 60, 1, 120),
            orbX: 0,
            originX: 0,
            originY: 0,
            orbY: 0,
            downX: 0,
            downY: 0,
            /**
             * This session's own viewer id, captured off the handshake's
             * `VIEWER_HEADER` (R-VID-07, R-VID-11, R-VID-19) — null until a
             * handshake answers with one, which an older console's will not.
             * Reset on every new connection, in `stopReporting()`.
             */
            viewerId: null,
            /** `setInterval`'s id while a live session is reporting once a
             * second — see `startReporting`/`stopReporting`, below. */
            reportTimer: null,
            /** The previous tick's own raw numbers, so the next one has
             * something to compute a delta against — see `sampleReport`'s
             * own doc comment on why the first tick after any reset has
             * none. Reset on every new connection alongside `viewerId`. */
            reportBaseline: null,
            decodeProgress: null,
            thumbnailDemand: null,
            thumbnailTimer: null
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
            const path = this.told ?? configured
            // `cameraFor` (`yonder-core/presentation`) is the one place
            // `-preview` is stripped — the console's own viewer-report route
            // strips it the identical way, from the identical function, so
            // the two cannot disagree about which camera a path is about.
            const base = cameraFor(path)
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
        /**
         * **Whether the camera this picture is about is running at all.**
         *
         * `null` where the message has not said — an older console, or a
         * picture not yet told a camera — and the picture then draws nothing
         * about it rather than guessing that a camera is stopped.
         */
        selectedCameraName () { return this.cameras.find(row => row.id === cameraFor(this.streamPath))?.name || this.props.label || '' },
        /** The one line either presentation shows when something is wrong:
         *  an expired session first, then a refused aim, then whatever the
         *  delivery path last reported. Empty when the picture is fine,
         *  which is what both `v-if`s test. */
        noticeReason () {
            if (this.signInRequired) return 'Your session expired. Sign in to restore video and controls.'
            return this.aimRefusal || this.reason || ''
        },
        /** Nothing has ever arrived to show, and something says why — the
         *  states the cockpit marks unavailable. Autoplay-blocked is
         *  deliberately not one of them: that case keeps **Resume live
         *  video**, which is the thing to press, and a cross over a button
         *  is two answers to one question. `mode: 'off'` has its own panel,
         *  and a still that is showing is a picture. */
        showUnavailableMark () {
            if (!this.scene || !this.unavailableMark) return false
            if (this.mode === 'off') return false
            if (this.mode === 'stills' && this.stillSrc) return false
            if (this.lastFrameAt !== null) return false
            return this.signInRequired || !!this.reason ||
                ['stopped', 'failed'].includes(this.cameraRunState)
        },
        /** One line, and the same words the gauges use unless a shorter true
         *  one exists for the state. `DATA UNAVAILABLE` is what an operator
         *  reads under every other crossed-out instrument; the stopped and
         *  sign-in states get their own shorter truth, because "unavailable"
         *  would misdescribe a camera somebody deliberately stopped. */
        unavailableLabel () {
            if (this.signInRequired) return 'SIGN IN REQUIRED'
            if (this.cameraRunState === 'stopped') return 'VIDEO STOPPED'
            return 'DATA UNAVAILABLE'
        },
        cameraRunState () {
            return this.fromPayload('runState') || (this.cameraRunning === true ? 'running' : this.cameraRunning === false ? 'stopped' : 'unknown')
        },
        videoControl () { return videoAction(this.cameraRunState, this.cameraRunning, this.fromPayload('startBlocked')) },
        cameraRunning () {
            const running = this.fromPayload('running')
            return typeof running === 'boolean' ? running : null
        },
        told () {
            const payload = this.command
            return payload && typeof payload === 'object' && typeof payload.path === 'string'
                ? payload.path
                : this.sentPath
        },
        staleFor () {
            if (this.mode !== 'live' || this.lastFrameAt === null) return 0
            return Math.max(0, Math.floor((this.frameNow - this.lastFrameAt) / 1000) - 2)
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
            if (this.signInRequired) return 'Sign in required'
            if (this.cameraRunState === 'starting') return 'Starting video'
            if (this.cameraRunState === 'stopped') return 'Video stopped'
            if (this.cameraRunState === 'failed') return 'Video unavailable'
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
        },
        /**
         * `payload.state` (R-VID-18, R-UI-28) — see this file's own top-of-
         * file doc comment on why this is a three-tier read rather than
         * eight hand-written `cost`-shaped pairs.
         *
         * **Named `previewState`, not `state`.** This component already
         * declares a prop called `state` — Dashboard's own standard per-node
         * object, unused here, exactly as `YonderAim.vue`'s own doc comment
         * notes for its identically-named `aimState`. A computed of the same
         * name does not error; it warns once ("Computed property 'state' is
         * already defined in Props") and then silently loses to the prop, so
         * `v-if="state"` would have been permanently truthy against the
         * prop's own `{}` default and every overlay below it would have
         * rendered from an empty object on every single mount — the kind of
         * defect this whole plan's own mutation-testing discipline exists to
         * catch, caught here before a single test was written against it by
         * simply running the *existing* suite first and reading the warning.
         */
        previewState () {
            if (this.deliveryState?.camera === cameraFor(this.streamPath)) return this.deliveryState.overlay
            const v = this.fromPayload('state')
            return v && typeof v === 'object' ? v : null
        },
        /**
         * The REC pill (L-16), and where its elapsed time comes from.
         *
         * Two shapes, one meaning. A caller may hand a pre-formatted
         * `{ elapsed }` — which is what this component has always taken — or
         * the recorder's own `RecordingState`, in which case the time is
         * counted here from `since`, the board's own answer to *when*.
         *
         * **`since` is the one that ships**, and the reason is the poll: the
         * camera page reads every five seconds, so a pre-formatted string
         * would make a stopwatch that jumps in five-second steps. Counting
         * from `since` against this component's own once-a-second clock is a
         * pill that reads like a clock, and it is right for a page opened
         * *after* the recording started — the elapsed time is the device's,
         * not this browser's guess at how long it has been watching.
         *
         * `{ elapsed }` is kept because it costs one branch and it is the
         * honest shape for a source that formats its own — a camera pushing
         * its own recorder state (§8.5) has a duration and no epoch.
         */
        recording () {
            const v = this.fromPayload('recording')
            if (!v || typeof v !== 'object') return null
            if (typeof v.elapsed === 'string') return v
            if (v.recording !== true || !Number.isFinite(v.since)) return null
            return { elapsed: elapsedWords(this.now - v.since) }
        },
        /** L-18's own fact: which still is being confirmed, and where it
         * went. Read here so the watcher below has one thing to watch. */
        saved () {
            const v = this.fromPayload('saved')
            if (v?.held === 'camera' && v.kind === 'photo' && Number.isFinite(v.observedAt)) return { ...v, at: v.observedAt }
            return v && typeof v === 'object' && Number.isFinite(v.at) ? v : null
        },
        cameras () {
            const v = this.fromPayload('cameras')
            return Array.isArray(v) ? v : []
        },
        downlink () {
            const v = this.fromPayload('downlink')
            return typeof v === 'string' ? v : ''
        },
        aim () {
            const v = this.fromPayload('aim')
            return v && typeof v === 'object' ? v : null
        },
        /** `not-offered`, `advertised` and `gated` all mean no drag layer
         * here — see this file's own doc comment on why the full four-state
         * vocabulary is `YonderAim.vue`'s own territory, not drawn twice. */
        aimable () {
            if (this.signInRequired) return false
            return Boolean(this.aim && this.aim.state === 'present' && !this.aim.inhibited)
        },
        stats () {
            const v = this.fromPayload('stats')
            return v && typeof v === 'object'
                && typeof v.linkMbps === 'number' && typeof v.dropPct === 'number'
                ? v
                : null
        },
        /**
         * `PAN`/`TILT` (a fixed `°`, this console's own established
         * convention for the two axes `DESCRIPTORS.aim` has no sub-unit for)
         * then `ZOOM`/the exposure reading — both read from
         * `video/descriptors.ts` via `yonder-core/presentation`, converted
         * through the identical `toDisplay` the config schema and the write
         * path already use. See this file's own top-of-file doc comment.
         */
        footItems () {
            const items = []
            const zoom = this.fromPayload('zoom')
            if (typeof zoom === 'number') {
                const d = DESCRIPTORS.zoom
                items.push({ key: 'zoom', label: d.label.toUpperCase(), text: String(d.toDisplay(zoom)) + d.unit })
            }
            const exposure = this.fromPayload('exposure')
            if (typeof exposure === 'number') {
                const d = DESCRIPTORS.exposure
                items.push({ key: 'exposure', label: d.label.toUpperCase(), text: String(d.toDisplay(exposure)) + d.unit })
            }
            return items
        }
    },
    watch: {
        /**
         * R-FLT-29: a host that draws this picture in the scene
         * presentation has taken the toolbar — and the age reading inside
         * it — away, and still needs to show that age somewhere else (the
         * flight display's own footer label). `seconds`/`text` are
         * `staleFor`/`ageText` verbatim, the identical two facts the
         * toolbar's own `y-pic__age` already draws, so the two can never
         * disagree about what "stale" means. `immediate` so a picture that
         * is live for its entire mounted life still emits the `seconds: 0`
         * a host needs to draw "not stale" — `staleFor` would otherwise
         * never fire a change at all.
         */
        staleFor: {
            immediate: true,
            handler (value) {
                this.$emit('stale', { seconds: value, text: this.ageText })
            }
        },
        cameraRunState (value, before) {
            if (value !== before) { this.videoRequestPending = false; clearTimeout(this.videoRequestTimer) }
            if (['stopped', 'failed'].includes(value)) { clearTimeout(this.retryTimer); clearTimeout(this.stillsTimer); this.teardown(); this.reason = ''; this.blank() }
            else if (this.wantsLive && !this.signInRequired && ['stopped', 'failed'].includes(before)) this.requestLive()
        },
        cameras () { this.refreshThumbnails() },
        mode () { this.refreshThumbnails() },
        aim (now, before) {
            if (now?.generation !== before?.generation || now?.url !== before?.url || now?.imageDirection !== before?.imageDirection) this.onDragEnd()
            this.aimTransport?.refresh()
        },
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
            if (value && typeof value === 'object') { this.remember(value); return }
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
        },
        /** R-CMD-04: aim becoming unavailable mid-drag stops the aircraft
         * immediately, the identical second guard `YonderAimPad`'s own
         * `updateFromEvent` needs for a fault arriving between presses (see
         * this file's own top-of-file doc comment). */
        aimable (now) {
            if (!now) this.onDragEnd()
        },
        /**
         * **A still landed** (L-18, R-UI-05).
         *
         * A white flash over the whole picture and a centred banner saying
         * where it went — a deliberate confirmation that something happened
         * at the moment the key was pressed, on a control whose only other
         * evidence is a file appearing in a panel the operator may not have
         * open.
         *
         * Watched on the capture's own `at`, not on the object: the payload
         * is cached across messages (`sentExtra`), so the same still arrives
         * again with every poll and an identity watch would flash on each
         * one. A *new* `at` is a new photograph and nothing else is.
         */
        saved: {
            immediate: false,
            handler (v) {
                if (!v || v.at === this.flashAt) return
                this.flashAt = v.at
                // The capture's own `held`, through the words the shutter
                // key's line already uses — a still that landed on the
                // camera's card must not be announced as this board's. `to`
                // is honoured where a caller has already composed the words.
                this.savedTo = typeof v.to === 'string' && v.to !== ''
                    ? v.to
                    : heldWords(v.held === 'camera' ? 'camera' : 'board')
                this.flashing = true
                clearTimeout(this.flashTimer)
                this.flashTimer = setTimeout(() => { this.flashing = false }, FLASH_MS)
            }
        }
    },
    created () {
        this.$dataTracker(this.id)
        // Hydrate cached state before partial messages replace it; never replay a cached action.
        this.remember(this.command)
    },
    mounted () {
        this.thumbnailDemand = new ThumbnailDemand(undefined, state => {
            const current = this.deliveryState
            if (this.mode === 'stills' && !this.signInRequired && state.camera === cameraFor(this.streamPath)
                && (!current || current.camera !== state.camera || !Number.isFinite(current.at) || state.at >= current.at)) this.deliveryState = state
        })
        this.thumbnailTimer = setInterval(() => this.refreshThumbnails(), 5000)
        this.aimTransport = new AimTransport(() => this.aim, (_rate, reason) => {
            if (reason) this.onDragEnd()
            this.aimRefusal = reason
        })
        this.$socket.on?.('disconnect', this.aimDisconnect)
        this.tick = setInterval(() => { this.now = Date.now(); this.frameNow = performance.now() }, 1000)
        // The media clock, which is the only honest source for the age this
        // component draws. See the note on `lastFrameAt` above.
        if (this.$refs.video) {
            this.$refs.video.addEventListener('timeupdate', this.onTimeUpdate)
            this.$refs.video.addEventListener('loadedmetadata', this.onMetadata)
        }
        // The drag layer's own four non-pointer endings — see this file's
        // own doc comment on "all eight endings".
        this.onDragBlur = () => this.onDragEnd()
        this.onDragVisibility = () => { if (document.hidden) this.onDragEnd(); this.refreshThumbnails() }
        this.onDragPageHide = () => this.onDragEnd()
        window.addEventListener('blur', this.onDragBlur)
        document.addEventListener('visibilitychange', this.onDragVisibility)
        window.addEventListener('pagehide', this.onDragPageHide)
        window.addEventListener(AIM_RESPONSE_CHANGED, this.onResponseChange)
        this.requestLive()
        this.refreshThumbnails()
    },
    beforeUnmount () {
        clearTimeout(this.videoRequestTimer)
        clearInterval(this.thumbnailTimer)
        this.thumbnailDemand?.close()
        this.aimTransport?.close()
        this.$socket.off?.('disconnect', this.aimDisconnect)
        clearTimeout(this.flashTimer)
        clearInterval(this.tick)
        clearTimeout(this.retryTimer)
        clearTimeout(this.stillsTimer)
        clearTimeout(this.fallbackRetryTimer)
        if (this.$refs.video) {
            this.$refs.video.removeEventListener('timeupdate', this.onTimeUpdate)
            this.$refs.video.removeEventListener('loadedmetadata', this.onMetadata)
        }
        window.removeEventListener('blur', this.onDragBlur)
        document.removeEventListener('visibilitychange', this.onDragVisibility)
        window.removeEventListener('pagehide', this.onDragPageHide)
        window.removeEventListener(AIM_RESPONSE_CHANGED, this.onResponseChange)
        // A component torn down mid-hold must still stop the aircraft —
        // navigating away from the page is not a reason to keep slewing.
        this.onDragEnd()
        this.teardown()
    },
    methods: {
        onCameraSessionExpired () {
            clearTimeout(this.retryTimer); clearTimeout(this.stillsTimer); clearTimeout(this.fallbackRetryTimer)
            this.aimTransport?.stop(); this.onDragEnd(); this.thumbnailDemand?.close(); this.teardown(); this.blank()
        },
        pressVideoAction () {
            if (this.signInRequired || this.videoRequestPending || !this.videoControl.action) return
            const camera = cameraFor(this.streamPath)
            if (!camera) return
            this.videoRequestPending = true
            clearTimeout(this.videoRequestTimer)
            this.videoRequestTimer = setTimeout(() => { this.videoRequestPending = false }, 10000)
            this.$socket.emit('widget-action', this.id, { camera, payload: this.videoControl.action })
        },
        onResponseChange (e) {
            const { key, value } = e.detail || {}
            if (!Number.isFinite(value)) return
            if (key === EXPO_KEY && value >= 0 && value <= 100) this.responseExpo = value
            else if (key === SPEED_KEY && value >= 1 && value <= 120) this.responseSpeed = value
            else return
            this.onDragEnd()
        },
        selectedStill () {
            const camera = cameraFor(this.streamPath)
            return this.cameras.find(row => row.id === camera)?.thumbSrc || this.props.stillsUrl || ''
        },
        refreshThumbnails () {
            if (this.signInRequired) return
            const camera = cameraFor(this.streamPath)
            const rows = document.hidden ? [] : this.cameras.map(row => ({ id: row.id, want: row.id === camera ? (this.mode === 'live' ? 'video' : this.mode === 'stills' ? 'stills' : 'off') : 'off' }))
            if (!document.hidden && this.mode === 'stills' && camera && !rows.some(row => row.id === camera)) rows.push({ id: camera, want: 'stills' })
            this.thumbnailDemand?.set(rows)
            if (this.mode === 'stills') this.stillSrc = this.selectedStill()
        },
        remember (value) {
            if (!value || typeof value !== 'object') return
            if (typeof value.cost === 'string') this.sentCost = value.cost
            if (typeof value.path === 'string') this.sentPath = value.path
            for (const key of PAYLOAD_KEYS) if (key in value) this.sentExtra[key] = value[key]
        },
        aimDisconnect () { this.aimTransport?.stop(); this.onDragEnd() },
        /**
         * One field of this picture's own richer state (R-VID-18, R-UI-28):
         * the live message first, then the last message that set it, then a
         * configured default — see this file's own top-of-file doc comment
         * on why this is one generalised read rather than eight hand-written
         * `cost`-shaped pairs.
         */
        fromPayload (key) {
            const payload = this.command
            if (payload && typeof payload === 'object' && key in payload) return payload[key]
            if (key in this.sentExtra) return this.sentExtra[key]
            const report = this.props.report
            return report && typeof report === 'object' ? report[key] : undefined
        },
        /**
         * A frame reached the screen (R-VID-03).
         *
         * This is the whole of what stands the degrade down, and it clears the
         * attempt count and the reason with it: a picture that is *painting*
         * is the only evidence that the session came back. A handshake that
         * completes and delivers nothing keeps counting, which is what the
         * fall-back to stills is waiting to hear.
         */
        onTimeUpdate () {
            if (typeof this.$refs.video?.requestVideoFrameCallback !== 'function') this.onFrame()
        },
        onFrame () {
            if (this.mode !== 'live') return
            this.lastFrameAt = performance.now()
            this.frameNow = this.lastFrameAt
            this.playbackBlocked = false
            this.attempt = 0
            this.reason = ''
        },
        watchFrames () {
            const video = this.$refs.video
            if (typeof video?.requestVideoFrameCallback !== 'function') return
            const session = this.session
            const frame = () => {
                if (session !== this.session || this.mode !== 'live') return
                this.onFrame()
                this.frameCallback = video.requestVideoFrameCallback(frame)
            }
            this.frameCallback = video.requestVideoFrameCallback(frame)
        },
        async resumePlayback () {
            if (this.signInRequired) return
            const video = this.$refs.video, session = this.session
            if (!video || this.mode !== 'live') return
            video.muted = true
            try {
                await video.play()
                if (session === this.session) this.playbackBlocked = false
            } catch {
                if (session === this.session) this.playbackBlocked = true
            }
        },
        onPlaybackPause () {
            if (this.signInRequired) return
            if (this.mode === 'live' && this.pc?.connectionState === 'connected' && this.$refs.video?.srcObject) this.playbackBlocked = true
        },
        /**
         * The decoder's own report of the stream it just negotiated (defect
         * 1) — see this file's own top-of-file doc comment. Guarded against
         * a spurious zero reading, which would otherwise collapse the shape
         * to `NaN`/0 and hold it there.
         */
        onMetadata () {
            const v = this.$refs.video
            if (v && v.videoWidth && v.videoHeight) this.videoAspect = v.videoWidth / v.videoHeight
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
         *
         * **Every ending this component has funnels through here first**
         * (R-VID-07, R-VID-11, R-VID-19): `beforeUnmount` (the component is
         * destroyed), `setMode`/`toStills` (mode leaves `'live'`), and
         * `connect` itself (the peer connection is about to be replaced,
         * whether by the `streamPath` watcher or by a reconnect's own
         * backoff). `stopReporting()` belongs here rather than duplicated at
         * each of those call sites for the identical reason `session += 1`
         * already is: one seam, so a stale timer from a session that ended
         * any of those ways cannot go on posting against the one that
         * replaces it.
         */
        teardown () {
            this.deliveryState = null
            if (this.frameCallback !== null) this.$refs.video?.cancelVideoFrameCallback?.(this.frameCallback)
            this.frameCallback = null
            this.playbackBlocked = false
            this.thumbnailDemand?.set([])
            this.aimTransport?.stop()
            this.onDragEnd()
            // Anything still in flight belongs to nobody from here on.
            this.session += 1
            this.stopReporting()
            if (this.abort) { this.abort.abort(); this.abort = null }
            if (this.pc) { this.pc.close(); this.pc = null }
        },
        /**
         * Once a second while a live session is up, this browser's own
         * measurement of the path its picture is arriving on (R-VID-07,
         * R-VID-11, R-VID-19) — called only after a handshake has both
         * succeeded and answered with a viewer id (`connect`, below); an
         * older console that never sends `VIEWER_HEADER` gets no timer at
         * all, which is this component's own "report nothing rather than
         * regress the picture" rule.
         *
         * `session` is captured now rather than read fresh from `this` on
         * every tick, for the same reason `connect`'s own `mine()` is: the
         * closure is what lets `sendReport` tell a tick that still belongs
         * to this connection from one that has been superseded, without
         * caring whether `clearInterval` has actually run yet.
         */
        startReporting () {
            const session = this.session
            this.reportBaseline = null
            this.reportTimer = setInterval(() => { this.sendReport(session) }, REPORT_INTERVAL_MS)
        },
        /** The other half of `startReporting`, and where the delta baseline
         * is reset — see `teardown`'s own doc comment on why every ending
         * this component has arrives here. */
        stopReporting () {
            clearInterval(this.reportTimer)
            this.reportTimer = null
            this.reportBaseline = null
            this.decodeProgress = null
            this.viewerId = null
        },
        /** A connected WebRTC peer can keep receiving damaged RTP without
         * decoding another frame. ICE therefore never triggers retry. Use
         * decoder progress, not paint callbacks (suppressed offscreen), to
         * recover a visible stalled preview within a bounded interval (R-VID-14).
         */
        checkDecodeProgress (sample) {
            const video = this.$refs.video
            const rect = video?.getBoundingClientRect()
            const visible = rect && rect.width > 0 && rect.height > 0
                && rect.bottom > 0 && rect.top < window.innerHeight
                && rect.right > 0 && rect.left < window.innerWidth
            if (this.mode !== 'live' || document.hidden || !visible || this.playbackBlocked
                || this.pc?.connectionState !== 'connected' || !Number.isFinite(sample?.framesDecoded)) {
                this.decodeProgress = null
                return
            }
            const prior = this.decodeProgress
            if (!prior || sample.framesDecoded !== prior.frames) {
                this.decodeProgress = { frames: sample.framesDecoded, at: sample.at }
                return
            }
            if (sample.at - prior.at >= DECODE_STALL_MS && this.retryTimer === null) {
                this.reason = 'video stopped decoding; reconnecting'
                this.decodeProgress = null
                this.retry()
            }
        },
        /**
         * One tick: read `getStats()`, diff against the previous tick, and
         * post — or do nothing, silently, whenever there is nothing yet to
         * diff against or nothing this browser can measure.
         *
         * **A failed report is silent and never retries early.** Unlike
         * `connect()`'s own failures, nothing here is a fault in the
         * picture: `reason` and `retry()` are about whether a session is
         * up, and a session that is up but could not tell the device what
         * it measured this one time is still up. The next tick, one second
         * away, is this method's own retry.
         */
        async sendReport (session) {
            if (session !== this.session || !this.viewerId || !this.pc) return
            const pc = this.pc
            let raw
            try {
                raw = await pc.getStats()
            } catch {
                return
            }
            // The session this tick belongs to may have ended while
            // `getStats()` was in flight — the identical check `connect()`
            // makes after every await of its own, for the identical reason.
            if (session !== this.session) return
            const sample = sampleReport(raw)
            this.checkDecodeProgress(sample)
            const prev = this.reportBaseline
            // The baseline moves on every usable tick, whether or not this
            // particular one goes on to produce a report — so the *next*
            // tick always diffs against the most recent reading, never one
            // an unreportable tick in between left behind.
            if (sample) this.reportBaseline = sample
            if (!prev || !sample) return
            const body = reportBody(cameraFor(this.negotiated), prev, sample, this.lastFrameAt)
            if (!body) return
            // **What this browser is asking for, stated on every report.**
            //
            // Not decoration and not a duplicate of the statistic beside it:
            // `Viewers.report()` hands a measurement to the rate controller
            // only while that viewer's `want` is `video`, and a subscription
            // this device made on its own starts at `off`. A report that never
            // says what it is watching is therefore recorded against the
            // viewer — the page's own `mine` block updates, so it looks like it
            // arrived — and never reaches the controller, which goes on saying
            // it has had no fresh report. Adaptive was inert on a real board
            // for exactly that reason, with every part of it working.
            //
            // Restated every second rather than once at connect, because it is
            // the browser's standing answer and not an event: a daemon that
            // restarts, or a subscription swept after `IDLE_MS`, must not leave
            // a live picture reporting into nothing until the page is reloaded.
            body.want = this.mode === 'live' ? 'video' : this.mode === 'stills' ? 'stills' : 'off'
            if (this.cameras.length) body.stills = !document.hidden
            try {
                const response = await fetch(`/video/${this.negotiated}/report`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body)
                })
                if (session !== this.session) return
                if (response.status === 401) { expireCameraSession(); return }
                if (!response.ok) return
                const state = await response.json()
                if (session === this.session && state?.camera === cameraFor(this.negotiated)
                    && state.viewer === this.viewerId && state.overlay && typeof state.overlay === 'object') this.deliveryState = state
            } catch {
                // Silent, and no retry-storm: the next tick is one second
                // away regardless of whether this one reached the network.
            }
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
            if (this.signInRequired || ['stopped', 'failed'].includes(this.cameraRunState)) return
            clearTimeout(this.fallbackRetryTimer)
            this.attempt = 0
            this.blank()
            this.reason = ''
            this.stillSrc = ''
            clearTimeout(this.retryTimer)
            this.retryTimer = null
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
            this.stillSrc = this.selectedStill()
            clearTimeout(this.retryTimer)
            // Nothing is watching the session now, and a track arriving after
            // this would be live video under a badge reading 'stills'.
            this.teardown()
            this.blank()
            // Falling back is not an operator request to abandon live video.
            // Start a new bounded attempt, rather than leaving the page stuck
            // on stills until a reload. Explicit Stills/Off cancels this.
            const session = this.session
            clearTimeout(this.fallbackRetryTimer)
            this.fallbackRetryTimer = setTimeout(() => {
                if (this.wantsLive && this.mode === 'stills' && this.session === session) {
                    this.mode = 'live'
                    this.requestLive()
                }
            }, 5000)
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
            if (this.signInRequired || ['stopped', 'failed'].includes(this.cameraRunState)) return
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
                if (this.$refs.video) {
                    this.$refs.video.srcObject = e.streams[0]
                    this.watchFrames()
                    this.resumePlayback()
                }
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
                // Which viewer this session is (R-VID-07, R-VID-11,
                // R-VID-19) — captured off the handshake regardless of
                // whether it succeeded, because it costs nothing to read
                // and `startReporting()` below is what actually gates on it
                // being set. No header at all — an older console — leaves
                // it null, and this browser reports nothing rather than
                // treat a missing channel as a reason the picture is wrong.
                this.viewerId = answer.headers.get(VIEWER_HEADER)
                if (!answer.ok) {
                    const failure = previewFailure(answer.status)
                    this.reason = failure.message
                    if (failure.signIn) expireCameraSession()
                    else if (failure.retry) this.retry()
                    else { clearTimeout(this.stillsTimer); clearTimeout(this.fallbackRetryTimer); this.teardown() }
                    return
                }
                const sdp = await answer.text()
                if (!mine()) return
                await pc.setRemoteDescription({ type: 'answer', sdp })
                if (!mine()) return
                if (this.viewerId) this.startReporting()
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
            this.aimTransport?.stop()
            this.onDragEnd()
            // A picture nobody is asking for does not reconnect: an off view
            // that kept negotiating would be spending a cellular uplink on a
            // stream with nothing on screen indicating it.
            if (this.mode !== 'live' || this.signInRequired || ['stopped', 'failed'].includes(this.cameraRunState)) return
            const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
            this.attempt += 1
            clearTimeout(this.retryTimer)
            // No button. The operator asked for a live picture and never
            // withdrew the request.
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null
                this.connect()
            }, wait)
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
            if (this.signInRequired || !['live', 'stills', 'off'].includes(mode)) return
            this.wantsLive = mode === 'live'
            clearTimeout(this.fallbackRetryTimer)
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
                this.stillSrc = mode === 'stills' ? this.selectedStill() : ''
            }
            this.$socket.emit('widget-action', this.id, { payload: `mode:${mode}`, topic: this.props.label })
        },
        /** Every new emission this task adds leaves through here — one seam,
         * the same reasoning `YonderAim.vue`'s own `post()` gives for having
         * exactly one, and the reason neither carries a `topic`: the second
         * argument to `emit` already identifies this node to the flow. */
        post (payload) {
            this.$socket.emit('widget-action', this.id, { payload })
        },
        /**
         * A press on the thumb strip: treated exactly like *being told* a
         * camera by an incoming message (`told`, above), because a press
         * naming a camera and a message naming one are the same fact from
         * two different sources. The flow is also told, the same "so the
         * flow knows what the operator asked for" reasoning `setMode`
         * already gives for its own press.
         */
        /** The same word the rail's START sends, down the same switch, so
         *  there is one way a camera is started and not two. */
        pressStart () {
            if (this.videoControl.action === 'start') this.pressVideoAction()
        },
        onThumbGo (id) {
            this.aimTransport?.stop()
            this.onDragEnd()
            this.sentPath = id
            this.post({ path: id })
        },
        /**
         * The drag-to-slew layer (spec §6: "orb only") — see this file's own
         * top-of-file doc comment for why this mirrors `YonderAimPad` method-
         * for-method rather than sharing its implementation, and why the
         * rate math below never divides by a measured rect.
         */
        dragAt (e) {
            const dx = e.clientX - this.downX
            const dy = e.clientY - this.downY
            const d = Math.hypot(dx, dy)
            if (d <= DRAG_DEAD) return null
            const k = Math.min(1, (d - DRAG_DEAD) / DRAG_RANGE)
            const speed = responseMagnitude(k, this.responseExpo,
                Math.min(this.responseSpeed, rateLimit(this.aim?.maxRate ?? DRAG_MAX_RATE))) * (e.shiftKey ? 0.25 : 1)
            if (!hasWireMotion((dx / d) * speed, -(dy / d) * speed)) return null
            return {
                // Screen y grows downward; tilt does not, hence the sign flip
                // — the identical convention `YonderAimPad.at()` states.
                pan: (dx / d) * speed,
                tilt: -(dy / d) * speed
            }
        },
        dragDown (e) {
            // Inhibited: nothing happens at all, not even capture — the
            // identical resolution `YonderAimPad.down()` states for its own
            // first guard.
            if (!this.aimable) return
            // One active gesture at a time, the same reasoning
            // `YonderAimPad.down()` gives for its own identical guard.
            if (this.dragPointerId !== null) return
            if (e.button !== undefined && e.button !== 0) return
            this.dragPointerId = e.pointerId
            this.downX = e.clientX
            this.downY = e.clientY
            const rect = this.$refs.frame.getBoundingClientRect()
            this.originX = e.clientX - rect.left
            this.originY = e.clientY - rect.top
            try { this.$refs.frame?.setPointerCapture?.(e.pointerId) } catch { /* Leaving an uncaptured frame stops. */ }
            this.updateDrag(e)
        },
        dragMove (e) {
            if (this.dragPointerId === null) return
            if (e.pointerId !== undefined && e.pointerId !== this.dragPointerId) return
            this.updateDrag(e)
        },
        /** The one place a pointer event becomes a slew or a stop — see
         * `YonderAimPad.updateFromEvent`'s own doc comment for why `aimable`
         * is checked here too, not only in `dragDown`. */
        updateDrag (e) {
            if (!this.aimable) { this.endDragGesture(); return }
            const a = this.dragAt(e)
            if (!a) { this.endDragGesture(); return }
            if (this.dragGesture === null) this.dragGesture = newDragGestureId()
            // Cosmetic only, and never read by the rate math above: the
            // orb's on-screen position, which measuring zero under `jsdom`
            // leaves harmlessly parked at the frame's own top-left corner.
            const rect = this.$refs.frame ? this.$refs.frame.getBoundingClientRect() : { left: 0, top: 0 }
            const dx = e.clientX - this.downX, dy = e.clientY - this.downY
            const scale = Math.min(1, (DRAG_DEAD + DRAG_RANGE) / Math.hypot(dx, dy))
            this.orbX = this.downX - rect.left + dx * scale
            this.orbY = this.downY - rect.top + dy * scale
            this.dragSeq += 1
            if (this.aim?.url) this.aimTransport?.update({ pan: a.pan, tilt: a.tilt, gesture: this.dragGesture })
            else this.post({ slew: { pan: a.pan, tilt: a.tilt, seq: this.dragSeq, gesture: this.dragGesture } })
        },
        /** Ends the active gesture, if there is one — idempotent, and the
         * single place that idempotency lives, the identical shape
         * `YonderAimPad.endGesture`'s own doc comment states and justifies. */
        endDragGesture () {
            this.orbX = 0
            this.orbY = 0
            if (this.dragGesture === null) return
            const g = this.dragGesture
            this.dragGesture = null
            if (this.aim?.url) this.aimTransport?.stop()
            else this.post({ stop: { gesture: g } })
        },
        /** Every one of the eight endings reaches here — see this file's own
         * top-of-file doc comment. No `pointerId` guard of its own, for the
         * identical reason `YonderAimPad.onEnd`'s own doc comment gives:
         * provably redundant with `endDragGesture`'s own `dragGesture ===
         * null` check for every state this component can reach. */
        onDragLeave () {
            try { if (this.dragPointerId !== null && this.$refs.frame?.hasPointerCapture?.(this.dragPointerId)) return } catch { /* No capture: stop. */ }
            this.onDragEnd()
        },
        onDragEnd (event) {
            if (event?.pointerId !== undefined && this.dragPointerId !== null && event.pointerId !== this.dragPointerId) return
            const pointer = this.dragPointerId
            this.dragPointerId = null
            this.endDragGesture()
            try { if (pointer !== null && this.$refs.frame?.hasPointerCapture?.(pointer)) this.$refs.frame.releasePointerCapture(pointer) } catch { /* Already released. */ }
        }
    }
}
</script>

<style scoped>
.y-pic__aim-help { color:var(--yonder-label); font-size:11px; line-height:1.4; }
.y-pic__stick-origin { position:absolute; z-index:3; width:144px; height:144px; border:1px solid rgba(255,255,255,.65); border-radius:50%; transform:translate(-50%,-50%); pointer-events:none; box-shadow:0 0 0 1px rgba(0,0,0,.45); background:radial-gradient(circle,rgba(255,255,255,.8) 0 2px,rgba(0,0,0,.25) 3px 7px,transparent 8px); }
.y-pic__camera { max-width:24ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.y-pic__controls { display:flex; flex:1 0 100%; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.y-pic__view-modes { display:flex; align-items:center; gap:4px; font-size:12px; }
.y-pic__view-modes > span { margin-right:6px; }
.y-pic__controls button, .y-pic__action { padding:5px 9px; border:1px solid var(--yonder-divider); border-radius:3px; background:var(--yonder-pane); color:var(--yonder-value); font:inherit; font-size:12px; cursor:pointer; text-decoration:none; }
.y-pic__controls button[aria-pressed="true"] { border-color:var(--yonder-select); background:color-mix(in srgb,var(--yonder-select) 12%, transparent); }
.y-pic__controls button:disabled { opacity:.55; cursor:default; }
.y-pic__controls :focus-visible { outline:2px solid var(--yonder-select); outline-offset:2px; }

.y-pic__toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
    padding: 7px 12px; overflow: auto;
    background: var(--yonder-pane, #0a0e13); color: var(--yonder-value, #fff);
    border-bottom: 1px solid var(--yonder-divider, #2b333c);
}
.y-pic__capture-host { position: sticky; bottom: 0; z-index: 6; align-self: end; }
.y-pic__capture-host:empty { display: none; }
.y-pic__toolbar .y-pic__hud, .y-pic__toolbar .y-pic__state,
.y-pic__toolbar .y-pic__rec, .y-pic__toolbar .y-pic__foot, .y-pic__toolbar .y-pic__osd {
    position: static; inset: auto; max-width: 100%; margin: 0; background: transparent;
}
.y-pic__toolbar .y-pic__state { flex: 1 1 260px; }
.y-pic__toolbar .y-pic__rec { margin-left: auto; }
.y-pic__toolbar .y-pic__cost { color: var(--yonder-value, #fff); }
/* R-UI-29: the handle has its own rail, never covering preview controls.
   Use available workspace width, including embedded/narrow layouts. */
:global(#nrdb-page-page-camera) { position: relative; container-type: inline-size; container-name: camera-workspace; }
:global(#nrdb-page-page-camera #nrdb-ui-group-group-cam-picture) { grid-column: 1 / -1 !important; grid-row: 1 !important; min-width: 0; }
:global(#nrdb-page-page-camera:has(.y-aimpanel[data-aim-state="open"]) #nrdb-ui-group-group-cam-picture),
:global(#nrdb-page-page-camera:has(.y-aimpanel[data-aim-state="closed"]) #nrdb-ui-group-group-cam-picture) { margin-right: 64px; }
:global(#nrdb-page-page-camera #nrdb-ui-group-group-cam-aim) { grid-row: 1 !important; grid-column: 1 / -1 !important; justify-self: end; align-self: start; width: min(340px, 100%); z-index: 5; }
:global(#nrdb-page-page-camera #nrdb-ui-group-group-cam-aim:has([data-aim-state="absent"])) { display: none !important; }
:global(#nrdb-page-page-camera #nrdb-ui-group-group-cam-aim:has([data-aim-state="closed"])) { width: 56px; background: transparent; border: 0; }
:global(#nrdb-page-page-camera #nrdb-ui-group-group-cam-aim .nrdb-ui-group-content) { padding: 0; }
@container camera-workspace (min-width: 900px) {
    :global(#nrdb-page-page-camera:has(.y-aimpanel[data-aim-state="open"]) #nrdb-ui-group-group-cam-picture) { margin-right: 352px; }
}

/* **The widget's whole slot**, and a grid so the picture and the strip
   under it divide it explicitly: one flexible row for the picture, one
   `auto` row for the strip. `minmax(0, 1fr)` in both axes rather than `1fr`,
   because a `1fr` track has an automatic minimum of its content and would
   simply grow past the slot again — which is the entire defect below. */
.y-pic {
    position: relative;
    height: 100%;
    min-height: 0;
    display: grid;
    /* Reserve thumbnail space before frames arrive; additional camera rows
       remain visible instead of being clipped by a fixed-height strip. */
    grid-template-rows: auto minmax(0, 1fr) minmax(34px, auto) minmax(80px, max-content);
    grid-template-columns: minmax(0, 1fr);
}
/* **Takes the shape of the video it is showing, and never more room than it
   was given** (defect 1 — see this file's own top-of-file doc comment).
   Three shapes of this have now been wrong, in three different ways:

   - `aspect-ratio: 16/9` on a box the *page* sized. The widget's height is a
     whole number of grid rows and its width a fraction of the viewport, so
     the two agreed at exactly one window size.
   - `height: 100%`, filling the given box. That fixed the overflow and let
     the *page* impose an aspect ratio the camera never agreed to: a camera
     that is not 16:9 was quietly letterboxed or cropped inside a box built
     for one that is, and an operator could not tell a badly-shaped picture
     from a badly-aimed one.
   - `aspect-ratio: videoAspect` with `width: 100%`. The shape became the
     camera's own — which is right, and is kept — but the height was still
     derived from a width nothing had checked against the slot, so the box
     stood 543 px tall in the 408 px seven rows buy (633 px at 1440), with
     the reason for a missing picture among the pixels that escaped.

   **Both constraints, together.** Dashboard gives this widget a grid area of
   exactly `60h - 12` px (`grid-template-rows: repeat(h, var(--widget-row-height))`
   plus `var(--widget-gap)` between them), so the slot's height is a definite
   number the box can be measured against — and `.y-pic__fit` is declared a
   size container so it can be. The width is then *the lesser* of the room
   across and the room down, and `aspect-ratio` turns whichever won into the
   height: the picture is the camera's own shape, at the largest size that
   fits, with the leftover as empty panel rather than as escaped picture.
   That is `object-fit: contain`'s arithmetic, which CSS performs for a
   replaced element and not for a box with overlays in it.

   `width: 100%` is declared first and deliberately kept: a browser without
   container queries drops the `min()` line at parse time — `cqh` is not a
   unit it knows — and falls back to that, where `max-height` still holds the
   box inside its slot.

   **A fourth version, in the grid rather than the width math** (R-FLT-29's
   `scene` presentation, below): dropping the toolbar, capture host, notices
   and thumbnails leaves three of `.y-pic`'s own four grid rows with nothing
   in them, but `grid-template-rows` above still reserves their minimums —
   34px, 80px — regardless of whether anything occupies them. That is this
   same defect in a different unit: room subtracted from the row the frame
   sizes against, unconnected to anything actually on screen. `.y-pic--scene`
   fixes it the same way the fourth version of any of this component's own
   sizing bugs should read as familiar rather than surprising: collapse the
   row list to the one flexible track alone, and — because a picture filling
   a flight instrument's background has no leftover to spend on empty panel
   either — take `.y-pic__fit` and `.y-pic__frame` out of the container-query
   arithmetic entirely, `position: absolute; inset: 0` against `.y-pic`
   itself, `object-fit: cover` doing the cropping `aspect-ratio` and `cqh` no
   longer need to. */
.y-pic__fit {
    min-width: 0;
    min-height: 0;
    container-type: size;
    display: flex;
    align-items: center;
    justify-content: center;
}
.y-pic__frame {
    position: relative;
    background: var(--yonder-display, #04060a);
    overflow: hidden;
    width: 100%;
    width: min(100%, calc(100cqh * var(--y-pic-aspect, 1.7778)));
    max-width: 100%;
    max-height: 100%;
}
.y-pic__frame.is-aiming { cursor: crosshair; touch-action: none; }
/* Camera is the dedicated viewing page: its video owns the column width.
   One content-sized Dashboard row lets the aspect ratio determine its height;
   the compact supporting rows stay below it without changing the image size.
   Other compositions, including Cockpit, keep their configured widget slots. */
:global(#nrdb-page-page-camera .nrdb-ui-yonder-picture) {
    display: block !important;
    grid-row-end: span 1 !important;
    height: auto !important;
}
#nrdb-page-page-camera .y-pic {
    height: auto;
    grid-template-rows: auto auto auto minmax(34px, auto) minmax(80px, max-content);
}
#nrdb-page-page-camera .y-pic__fit {
    container-type: normal;
    display: block;
}
#nrdb-page-page-camera .y-pic__frame {
    width: 100%;
    max-height: none;
}
/* **Every overlay below is given an explicit `z-index`** (defect 2 — this
   file's own top-of-file doc comment). A hardware-decoded `<video>` can
   composite in a layer of its own that ignores DOM order, so nothing here
   is left to rely on painting later than its siblings by accident. */
.y-pic__video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: filter 1s linear; z-index: 1; }
/* R-FLT-29's scene presentation — see the fourth-version paragraph in
   `.y-pic__frame`'s own comment above for why the grid row collapses and
   `.y-pic__fit`/`.y-pic__frame` leave the container-query sizing entirely.
   A plain `1fr`, not `minmax(0, 1fr)`: the one thing that could still grow
   this row past its slot — `.y-pic__fit` sizing to its own content — cannot
   happen once `.y-pic__fit` is taken out of flow below, so there is nothing
   left for the `minmax()` floor to guard against. */
.y-pic--scene { grid-template-rows: 1fr; }
.y-pic--scene .y-pic__fit,
.y-pic--scene .y-pic__frame {
    position: absolute;
    /* Longhand, not the `inset` shorthand this file uses elsewhere
       (`.y-pic__video`, `.y-pic__hatch`, `.y-pic__flash`): jsdom's CSS
       engine does not expand `inset` into `top`/`right`/`bottom`/`left`,
       and `camera-scene.component.test.ts` reads exactly those four
       through `getComputedStyle`, being unable to measure a box directly. */
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
}
.y-pic--scene .y-pic__video { object-fit: cover; }
/* R-UI-20 in the scene: the reason, and the resume control, inside the
   frame — there is nowhere else for them, since `.y-pic--scene` collapses
   the grid to the one track the frame fills. Above the hatch and the
   stopped message, at the foot of the picture where the PFD's own footer
   is not, and only ever present when the template says something is
   actually wrong. */
.y-pic--scene .y-pic__scene-notice {
    position: absolute;
    inset: 4px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    text-align: center;
    overflow: hidden;
    pointer-events: none;
}
/* The cockpit's own unavailable convention, reused rather than reinvented
   (R-UI-20, the operator's ruling of 2026-09-12). The source is
   `cockpit/instruments/InstrumentGauge.vue`: when a reading is not valid it
   marks its root `instrument-unavailable`, draws `.missing-cross` — a two-
   stroke X in `#ef5a53`, `stroke-width: 2.5`, no fill — corner to corner
   across the gauge face, and puts `DATA UNAVAILABLE` beneath it in
   `#c3d4dd`. That style block is `scoped`, so the values are restated here
   rather than shared: **if the gauge's cross changes colour, this must move
   with it.**

   `preserveAspectRatio="none"` with `vector-effect: non-scaling-stroke` is
   what makes one square path draw a true corner-to-corner cross in a 16:9
   box without the stroke going oval with it. The label sits at the foot,
   clear of the cross, exactly where the gauge puts its own detail line. */
.y-pic--scene .y-pic__unavailable {
    position: absolute;
    inset: 0;
    /* `inset: 0` plus padding overflows the frame without this. */
    box-sizing: border-box;
    z-index: 4;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 5px;
    gap: 2px;
    pointer-events: none;
}
/* **The cross takes its height from the flex line, never from its own
   intrinsic ratio.** An `<svg>` carrying a viewBox is a replaced element with
   an intrinsic 1:1 ratio, so any sizing that leaves one axis indefinite draws
   it square: `inset` alone made it 186px tall in a 76px frame here, and a
   percentage height that did not resolve on the Flight page made it 131px
   tall in a 48px one. A zero flex basis with `flex-grow` gives the height
   outright, so there is no axis left for the ratio to fill in, and the cross
   simply gets shorter as the window does. `preserveAspectRatio="none"` plus
   `vector-effect: non-scaling-stroke` is what keeps one square path drawing a
   true corner-to-corner X of even thickness in a 16:9 box. */
.y-pic--scene .y-pic__missing {
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    align-self: stretch;
}
.y-pic--scene .y-pic__missing path {
    stroke: #ef5a53;
    stroke-width: 2.5;
    fill: none;
    vector-effect: non-scaling-stroke;
}
/* Beneath the cross, where the gauge puts its own detail line — not over it.
   The type is `.y-pic__stopped-l`, this component's existing label on this
   exact surface, because `--yonder-display` is cream in the day palette and
   the gauge's own `#c3d4dd` is for a face that never goes light. It may wrap
   rather than overflow at a hand-shrunk window size; at every size that ships
   it is the one line the ruling asked for. */
.y-pic--scene .y-pic__missing-l {
    flex: none;
    max-width: 100%;
    font-size: 9px;
    letter-spacing: 0.1em;
    line-height: 1.2;
    background: var(--yonder-display, #04060a);
    padding: 0 3px;
    border-radius: 2px;
}

/* No truncation here, deliberately: the host only sets `reasonLine` on the
   box that can show the line whole (see the prop's own doc comment), so a
   clip would mean the host got that wrong and should be visible as a gate
   failure rather than hidden by CSS. */
.y-pic--scene .y-pic__reason {
    font-size: 11px;
    padding: 3px 5px;
}
.y-pic--scene .y-pic__resume { pointer-events: auto; flex: none; }
/* The hatch is the third of four signals, and the one that cannot be mistaken
   for a dark scene or a badly exposed shot. Above the video, below every
   reading drawn on top of it: it must wash over the picture, never obscure
   a count or a badge. */
.y-pic__hatch {
    position: absolute; inset: 0; z-index: 2; pointer-events: none;
    background: repeating-linear-gradient(45deg,
        transparent 0 14px,
        color-mix(in srgb, var(--yonder-bad, #ff4034) 22%, transparent) 14px 16px);
}
.y-pic__hud { position: absolute; top: 8px; left: 8px; z-index: 5; display: flex; gap: 8px; align-items: baseline; pointer-events: none; }
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
/* `YonderStateOverlay`'s own root (`.y-ov`) receives this class as a Vue
   fallthrough attribute — positioned here rather than inside that
   component, which draws only what it is given and decides nothing about
   where it sits on a page (its own doc comment). */
.y-pic__state { position: absolute; top: 34px; left: 8px; z-index: 5; max-width: calc(100% - 16px); pointer-events: none; }
.y-pic__rec {
    position: absolute; top: 8px; right: 8px; z-index: 5;
    display: flex; align-items: center; gap: 6px;
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 11px; letter-spacing: 0.06em;
    padding: 3px 8px; border-radius: 2px;
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    border: 1px solid var(--yonder-bad, #ff4034);
    color: var(--yonder-bad, #ff4034);
    pointer-events: none;
}
.y-pic__rec-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--yonder-bad, #ff4034); display: inline-block; }
/* L-18, the blueprint's own figures (`gallery/DraftPicture.vue`): a white
   wash over the whole picture and a centred banner. `pointer-events: none`
   on both, because the drag-to-slew layer is underneath and a confirmation
   that swallowed a slew for a second would be a control that stopped working
   every time a photograph was taken. */
.y-pic__flash {
    position: absolute;
    inset: 0;
    z-index: 7;
    background: #ffffff;
    opacity: 0.55;
    pointer-events: none;
}
.y-pic__saved-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--yonder-select, #2ad4f0);
    display: inline-block;
}
/* `left`/`right` both set, rather than a shrink-to-fit box growing from
   `left` alone — a narrow picture (defect 1 means there is no fixed width
   to assume any more) left four readings on one unbroken line wide enough
   to run straight into `.y-pic__osd`'s own right-anchored box, sharing
   almost the same bottom edge. `flex-wrap` on the real per-reading elements
   below (not on bare text nodes, which a wrapping flex container cannot
   size individually) lets PAN/TILT/ZOOM/SHUTTER fold onto a second line
   instead of overlapping a neighbour that was never sharing a line with
   them on a wider picture. */
.y-pic__foot {
    /* Clears `.y-pic__osd`'s own right-anchored box — a horizontal split, not
       a vertical one, because it holds however many lines either box wraps
       to, where a vertical-only guess let a wrapped line land inside the OSD
       box's own height.

       **136px, not the 104px this first carried.** Review measured the OSD's
       real footprint at about 118px across several frame widths, not the 90px
       this had assumed, leaving a ~14px shortfall that a two- or three-digit
       zoom reading would close. Measured rather than estimated, with room
       left over. */
    position: absolute; left: 8px; right: 136px; bottom: 34px; z-index: 5;
    display: flex; flex-wrap: wrap; column-gap: 12px; row-gap: 2px;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 11.5px; font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #ffffff);
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    padding: 4px 8px; border-radius: 2px;
    pointer-events: none;
}
.y-pic__foot-item { white-space: nowrap; }
.y-pic__foot-k {
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 10px; letter-spacing: 0.1em;
    color: var(--yonder-label, #7f8a95);
    margin-right: 5px;
}
.y-pic__osd {
    position: absolute; right: 8px; bottom: 8px; z-index: 5;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 11.5px; font-variant-numeric: tabular-nums; line-height: 1.5;
    color: var(--yonder-value, #ffffff);
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    padding: 4px 8px; border-radius: 2px;
    text-align: right;
    pointer-events: none;
}
.y-pic__orb {
    position: absolute; z-index: 5;
    width: 28px; height: 28px; margin-left: -14px; margin-top: -14px;
    border-radius: 50%;
    border: 2px solid var(--yonder-select, #2ad4f0);
    background: color-mix(in srgb, var(--yonder-select, #2ad4f0) 18%, transparent);
    pointer-events: none;
}
.y-pic__stopped {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
}
.y-pic__stopped-l {
    font-family: var(--yonder-font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--yonder-dim, #7b8794);
}
.y-pic__start {
    font-family: var(--yonder-font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--yonder-act, #38bdf8);
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 8px 18px;
    cursor: pointer;
}
.y-pic__start:hover { background: rgba(56, 189, 248, 0.08); }

.y-pic__reason, .y-pic__off {
    position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 5;
    font-family: var(--yonder-font, system-ui, sans-serif); font-size: 12px;
    color: var(--yonder-label, #7f8a95);
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    padding: 4px 6px; border-radius: 2px;
    pointer-events: none;
}
.tone-neutral { color: var(--yonder-neutral, #7d7869); }
.tone-waiting { color: var(--yonder-waiting, #ffcf28); }
.tone-good    { color: var(--yonder-good, #35d06a); }
.tone-bad     { color: var(--yonder-bad, #ff4034); }
/* The strip sits *beneath* the picture, not on top of it — see this file's
   own top-of-file doc comment on why it is a normal-flow sibling of
   `.y-pic__frame` rather than one more absolutely-positioned overlay. */
.y-pic__notices, .y-pic__thumbnails { min-width: 0; min-height: 0; overflow: auto; }
.y-pic__resume { padding: 4px 10px; margin: 2px 0; border: 1px solid currentColor; border-radius: 3px; color: var(--yonder-select, #2ad4f0); background: transparent; font: inherit; cursor: pointer; }
.y-pic__thumbnails { overflow: visible; }
.y-pic__strip { margin-top: 8px; }

.y-pic__reason { color: var(--yonder-waiting, #ffcf28); }
.y-pic__saved { color: var(--yonder-good, #6ddd97); }
.y-pic__reason, .y-pic__saved {
    position: static;
    inset: auto;
    transform: none;
    width: auto;
    max-width: 100%;
    padding: 7px 0;
    margin: 0;
    background: transparent;
    border: 0;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.4;
}
</style>
