<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-aimpanel" :class="{ 'y-aimpanel--collapsible': collapsible }" :data-aim-state="collapsible ? drawerState : null">
        <!-- An absent capability owns no edge handle. The camera workspace
             leaves this empty mount point in place so its layout can respond
             without mounting or remounting the picture receiver. -->
        <div v-if="!report" class="y-aimpanel__empty">Waiting for this camera's report.</div>
        <div v-else-if="!collapsible && aimState === 'not-offered'" class="y-aimpanel__fact">
            <span class="y-aimpanel__fact-l">Aim</span>
            <span class="y-aimpanel__fact-v">{{ reason || 'this camera has none' }}</span>
        </div>
        <template v-else-if="!collapsible || aimOffered">
            <button
                v-if="collapsible"
                type="button"
                class="y-aimpanel__handle"
                :aria-expanded="String(drawerOpen)"
                :aria-controls="drawerId"
                :title="drawerOpen ? 'Hide Aim controls' : 'Show Aim controls'"
                @click="toggleDrawer"
            ><span>Aim</span><i aria-hidden="true">{{ drawerOpen ? '›' : '‹' }}</i></button>
            <component
                :is="collapsible ? 'section' : 'div'"
                v-show="!collapsible || drawerOpen"
                :id="collapsible ? drawerId : undefined"
                :class="collapsible ? 'y-aimpanel__drawer' : undefined"
                :aria-label="collapsible ? 'Aim controls' : undefined"
            >
        <YonderColumn legend="Aim" :qualifier="badgeText" :tone="badgeTone">
            <!--
              **Said once, at the top, for the whole panel.**

              `effectiveReason` is one fact about this camera — *it advertises
              pan and tilt but there is no motor behind either* — and it used to
              be handed to the pad and to both position gauges as well, each of
              which drew it in full. Four copies of one sentence, 155 px of
              prose in a 228 px panel, overlapping the dial and the gauges it
              was explaining. The operator saw it as an overlap before anyone
              saw it as a repetition.

              The children still take `dead`/`state`, so they are drawn as
              controls that cannot be worked; what they no longer do is each
              restate why.
            -->
            <div v-if="effectiveReason || aimError || report.motionNotice" class="y-aimpanel__reason">{{ aimError || effectiveReason || report.motionNotice }}</div>
            <div v-if="!effectiveReason && report.directionalRefusals?.length" class="y-aimpanel__reason">{{ report.directionalRefusals.join(' · ') }}</div>

            <p v-if="signInRequired" class="y-aimpanel__reason"><a :href="signInHref">Sign in</a> to use camera controls.</p>
            <YonderAimPad
                ref="aimPad"
                :axes="PAD_AXES"
                :max-rate="report.maxRate ?? 30"
                :at-limit="atLimit"
                :inhibited="padInhibited"
                :note="effectiveReason ? '' : padInhibited"
                @slew="onSlew"
                @stop="onStop"
            />

            <div v-if="aimState === 'present'" class="y-aimpanel__rate">
                <span class="y-aimpanel__rate-l">Commanded rate</span>
                <span class="y-aimpanel__rate-v">{{ rateShown }}<i>°/s</i></span>
            </div>

            <div class="y-aimpanel__reported">{{ report.positionFrame === 'handle' ? 'Position relative to handle' : report.positionFrame === 'world' ? 'Camera attitude in the world' : 'Reported position' }}</div>
            <dl v-if="!hasBounds" class="y-aimpanel__position">
                <div><dt>Pan</dt><dd>{{ pan === null ? '—' : pan.toFixed(1) + '°' }}</dd></div>
                <div><dt>Tilt</dt><dd>{{ tilt === null ? '—' : tilt.toFixed(1) + '°' }}</dd></div>
            </dl>
            <template v-else>
                <YonderPositionGauge label="Pan" unit="°" :value="pan" :min="panBounds.lo" :max="panBounds.hi" :bounds-known="hasBounds" :dead="aimState !== 'present' || pan === null" :reason="pan === null ? 'Not reported by this camera.' : gaugeReason" />
                <YonderPositionGauge label="Tilt" unit="°" :value="tilt" :min="tiltBounds.lo" :max="tiltBounds.hi" :bounds-known="hasBounds" :dead="aimState !== 'present' || tilt === null" :reason="tilt === null ? 'Not reported by this camera.' : gaugeReason" />
            </template>

            <div v-if="modeControlState === 'not-offered'" class="y-aimpanel__mode">{{ modeSentence }}</div>
            <YonderSegmented
                label="Gimbal mode"
                :value="mode"
                :options="modes"
                :state="modeControlState"
                :reason="report.modeInhibited || ''"
                @change="onModeChange"
            />

            <button type="button" class="y-aimpanel__recentre" :disabled="recentreDisabled" :title="report.recentreInhibited || ''" @click="pressRecentre">{{ report.recentreLabel || 'Recenter gimbal' }}</button>
            <p v-if="report.modeHelp" class="y-aimpanel__mode-help">{{ report.modeHelp }}</p>
            <div v-if="report.recentreInhibited" class="y-aimpanel__reason">{{ report.recentreInhibited }}</div>
            <YonderAimPresets v-if="report.presets && report.url" :presets="report.presets" :endpoint="presetEndpoint" :can-move="presetReady"
                :move-reason="presetBlockReason" :active-slot="activePreset" :movement-message="presetMessage" @recall="recallPreset" @stop="aimDisconnect" />
        </YonderColumn>
            </component>
        </template>
    </div>
</template>

<script>
import { cameraSessionMixin } from './camera-session.ts'
import YonderAimPad from './YonderAimPad.vue'
import YonderAimPresets from './YonderAimPresets.vue'
import YonderPositionGauge from './YonderPositionGauge.vue'
import YonderSegmented from './YonderSegmented.vue'
import YonderColumn from './YonderColumn.vue'
import { AimTransport } from './aim-transport.ts'
import { SPEED_KEY, savedNumber } from './aim-response.ts'

const DRAWER_PREFERENCE_PREFIX = 'yonder.aim.drawer.'

function drawerPreference (cameraKey) {
    try {
        const saved = window.localStorage.getItem(DRAWER_PREFERENCE_PREFIX + encodeURIComponent(cameraKey))
        return saved === null ? true : saved === 'open'
    } catch (_) {
        // Storage can be unavailable in a private or policy-managed browser.
        // The usable, default-open control is preferable to failing to draw it.
        return true
    }
}

function saveDrawerPreference (cameraKey, open) {
    try {
        window.localStorage.setItem(DRAWER_PREFERENCE_PREFIX + encodeURIComponent(cameraKey), open ? 'open' : 'closed')
    } catch (_) {
        // Preference storage is an enhancement, never a reason to lose Aim.
    }
}

/**
 * `ui-yonder-aim` — the gimbal panel as a node of its own (R-UI-28,
 * R-CAM-11), so the Cockpit (M5) can carry the picture and this panel with
 * no camera deck beside them. **This node depends on nothing `ui-yonder-deck`
 * draws** — no shared store entry, no sibling widget, no adapter function the
 * two files both call into. `YonderDeck.vue`'s own `buildAim()` composes
 * `YonderAimPad` directly today for exactly the same reason this file does;
 * the two are deliberately two call sites of the pad, not one calling the
 * other, because a Cockpit page that pulled in even part of the deck to get
 * its aim panel would have re-created the coupling this task exists to cut.
 *
 * **The payload is this node's own shape**, assembled server-side for this
 * panel alone — not `YonderDeck`'s own `capabilities.aim` (which nests a
 * pitch/yaw range inside one capability value, the shape a whole camera
 * report already carries). Composed panels are still allowed to differ in
 * what they are fed; what they must not do is share code to read it, which
 * is the actual content of "depends on nothing the deck draws":
 *
 * ```
 * { state, reason, pan, tilt,
 *   bounds: { pan: [lo, hi], tilt: [lo, hi] } | null,
 *   atLimit: { pitch, yaw }, mode, modes: string[], inhibited: string | null }
 * ```
 *
 * **It composes rather than reimplements.** `YonderAimPad` (Task 20) already
 * owns the hard part — rate rather than position, one gesture id per drag,
 * exactly one stop for each of the eight ways a gesture ends, and (its own
 * review's subtler finding) a press refused while inhibited must not start
 * slewing if the inhibition lifts while the pointer is still held. Every
 * `slew`/`stop` this panel receives is relayed to the socket exactly as the
 * pad computed it (`onSlew`/`onStop` below), never re-derived — `seq` is
 * lifetime-monotonic from the pad's own counter and is never recomputed
 * here, and `stop` carries `gesture` and nothing else, by the pad's own
 * design (coordinator resolution 3): this deliberately does *not* follow
 * `YonderDeck.buildAim()`'s own choice to enrich its stop relay with
 * `pan: 0, tilt: 0` — the coordinator's resolution for this task says
 * "carries `gesture` and no `seq`", stated as a warning against adding
 * fields the pad's own event does not carry, not merely against adding
 * `seq` specifically. `YonderPositionGauge` (Task 19) is composed the same
 * way, once per axis, for the reported position against its own bounds.
 *
 * **Must not hold its own copy of `inhibited`** (coordinator resolution 6).
 * `padInhibited` below is a computed, not a value ever assigned into
 * `data()` — always a fresh read of `aimState`/`reason`/`inhibited`, so the
 * pad's own `watch: { inhibited }` (which is what actually stops an
 * in-flight gesture the instant an inhibition arrives, and what the pad's
 * own review added so a lifted inhibition cannot resume slewing without a
 * fresh press) keeps working exactly as Task 20 built it. A local copy
 * updated imperatively would risk exactly the staleness that defect was.
 *
 * **`state`/`reason` and `inhibited` are two different facts, not one
 * dressed up as two.** `aimState` (named to avoid colliding with this
 * widget's own standard `state` prop — Dashboard's per-node object, unused
 * here) is R-UI-20's four-state capability vocabulary: `not-offered` draws
 * one fact row and nothing else; `present` is fully live; `advertised`
 * keeps every control — pad, both gauges, the mode control, Recentre — drawn
 * and marked, in the caution tone, carrying `reason` (the ELP bench camera:
 * "advertises pan and tilt but there is no motor behind either"); `gated`
 * does the same in the neutral tone (R-UI-21). `inhibited` is orthogonal: a
 * *temporary* guard on an otherwise-present capability (§8.7 — unknown
 * bounds, unknown mode, stale attitude), which disables the same controls
 * without claiming the device does not have aim at all. `effectiveReason`
 * picks whichever of the two currently applies — never both, since a
 * capability that is not `present` has nothing left for a live guard to be
 * temporarily inhibiting.
 *
 * **The dead state and the struck axis both stay drawn** (coordinator
 * resolution 7, R-UI-20). `PAD_AXES` hardcodes `roll: 'advertised'` — this
 * node's own payload carries no `axes` field at all (there is no report
 * channel for roll yet on any camera this project supports), the same fact
 * `YonderDeck.buildAim()` answers by hardcoding the identical object. When a
 * gimbal with a roll motor exists, both call sites gain a real source
 * together; until then, the pad still draws roll struck through rather than
 * silently two-axis, because a hidden axis reads as "this page forgot
 * roll", not "this camera cannot".
 *
 * **The badge reuses `YonderColumn`'s own qualifier, not a new part.**
 * `YonderColumn`'s own doc comment gives "rate control" as one of its two
 * worked examples of a qualifier string — this is that example, made real:
 * `select` tone (this control is live) while `present`, `waiting` tone (a
 * fault, R-CAM-14) while `advertised`, and `gated` falls through to
 * `YonderColumn`'s own unrecognised-tone fallback, the plain label colour —
 * exactly the neutral R-UI-21 asks for, with no third tone name invented
 * here to get it. The two badge strings are written in the panel's own
 * capitals (`RATE CONTROL` / `NOT ANSWERING`) rather than left to an ambient
 * `text-transform`, the same reasoning `YonderPlacard`'s own `.y-plc__u`
 * states for a unit: a value that must read exactly one way is written that
 * way, not derived from a stylesheet rule a future change could alter.
 *
 * **The rate block is its own reading, not the pad's.** `YonderAimPad`
 * draws only the dial (its own doc comment disclaims the blueprint's
 * "Commanded rate" row as "a later task's composition, not this file's") —
 * this is that later task. `commandedPan`/`commandedTilt` are a display
 * cache fed by relaying the pad's own `slew`/`stop` events, not a second
 * copy of anything the pad decides; shown only while `present` (coordinator
 * resolution: "the rate block only when present"), because there is
 * nothing a magnitude reading could mean while the device is not answering
 * at all — the pad and the position gauges stay drawn dead instead, per
 * R-UI-20, rather than this block pretending to a number.
 *
 * **The mode sentence states the current mode in a full sentence** rather
 * than a bare label, so it reads differently from the segmented control's
 * own button caption beneath it — deliberately inventing no per-mode
 * description (`Follow`, `Tilt lock`, `FPV` are the device's own words,
 * `modes` verbatim off the payload, never expanded the way this library
 * never expands a menu id's own meaning elsewhere either). Drawn only when
 * `mode` is set, independent of `aimState`, since it is a reading rather
 * than a control — the same reasoning that keeps the pad's puck position
 * showing regardless of state.
 *
 * **`Recentre` obeys the shutter's own rule** (coordinator resolution 5): it
 * emits once per press, and a second press while one is pending emits
 * nothing. There is no acknowledgement channel in this payload the way
 * `YonderShutter`'s own `pending` prop expects a caller to supply one from —
 * a fire-and-forget command to an aircraft with no round trip modelled yet.
 * The nearest honest signal this node has for "seen since" is the next
 * report: `recentrePending` is local, set on press, and cleared by the
 * `watch` on `report` below, the same reasoning `YonderDeck`'s own `report`
 * computed gives for treating the live report as this whole page's source
 * of truth. It is enforced twice, like every fire-once press in this
 * library (`YonderShutter`, `YonderSegmented`, `YonderSetBar` each document
 * why): the `:disabled` binding stops an ordinary press, and `pressRecentre`'s
 * own guard stops a dispatched click that reaches a disabled button's
 * listener in a real browser even though `.click()` does not.
 */

/**
 * Roll has no motor on any camera this project supports yet, and this
 * node's own payload carries no `axes` field to say otherwise — see this
 * component's own doc comment on why this mirrors `YonderDeck.buildAim()`'s
 * identical, separately-hardcoded object rather than importing one from it.
 */
const PAD_AXES = { pan: 'present', tilt: 'present', roll: 'not-offered' }

/** A payload `bounds` axis (`[lo, hi]` or missing) to the pair
 * `YonderPositionGauge` needs, falling back to the blueprint's own default
 * range for that axis (§7's Aim table: pan ±180°, tilt ±90°) rather than an
 * arbitrary 0..0 that would draw a track with nowhere for the pointer to
 * go. */
function boundsOf (bounds, axis, lo, hi) {
    const pair = bounds && Array.isArray(bounds[axis]) ? bounds[axis] : null
    return {
        lo: pair && typeof pair[0] === 'number' ? pair[0] : lo,
        hi: pair && typeof pair[1] === 'number' ? pair[1] : hi
    }
}

export default {
    name: 'YonderAim',
    mixins: [cameraSessionMixin],
    inject: ['$socket', '$dataTracker'],
    components: { YonderAimPad, YonderAimPresets, YonderPositionGauge, YonderSegmented, YonderColumn },
    emits: ['drawer-change'],
    props: {
        id: { type: String, required: true },
        /** A stable camera identity supplied by the composition. `id` is a
         * Dashboard widget id, so it is only the fallback for older callers. */
        cameraKey: { type: String, default: '' },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data: () => ({
        PAD_AXES,
        /** A display cache of the pad's own last relayed rate — fed by
         * `onSlew`/`onStop`, never re-derived from `inhibited` or `aimState`.
         * See this component's own doc comment on "the rate block". */
        commandedPan: 0,
        commandedTilt: 0,
        /** See this component's own doc comment on `Recentre`. */
        aimTransport: null,
        aimError: null,
        activePreset: null,
        presetMessage: '',
        recentrePending: false,
        drawerOpen: true
    }),
    computed: {
        /** The Camera workspace opts in; standalone panels, including Cockpit,
         * retain their full Aim presentation. */
        collapsible () { return this.props?.collapsible === true },
        presetEndpoint () { return this.report?.url?.replace(/\/aim$/, '/presets') || '' },
        presetBlockReason () {
            if (this.signInRequired) return 'Sign in to use saved positions.'
            if (this.report?.positionFrame !== 'handle') return 'Waiting for position feedback relative to the handle.'
            if (this.report?.mode !== 'FPV') return 'Choose FPV mode to save and recall positions.'
            return this.inhibited || (this.aimState !== 'present' ? 'The gimbal is not responding.' : '')
        },
        presetReady () { return !this.presetBlockReason },
        /** The whole report, live in preference to configured — the same
         * rule every other widget in this package states for its own
         * narrower slice (`YonderFacts`'s own comment on `facts` says it
         * first; `YonderDeck`'s own `report` says it for a whole payload,
         * the shape this reuses verbatim). Defensive against `$store` being
         * entirely absent, which is exactly the case R-UI-28's own test
         * mounts: no deck, no shared store, only this node's own payload. */
        report () {
            const live = this.$store && this.$store.state && this.$store.state.data
                ? (this.$store.state.data.messages && this.$store.state.data.messages[this.id]
                    ? this.$store.state.data.messages[this.id].payload
                    : undefined)
                : undefined
            if (live && typeof live === 'object') return live
            const fallback = this.props.report
            return fallback && typeof fallback === 'object' ? fallback : null
        },
        /** R-UI-20's four-state capability vocabulary, named `aimState`
         * rather than `state` because `state` is already this widget's own
         * standard (and here unused) Dashboard prop — see this component's
         * own doc comment. Fails closed to `not-offered` before the first
         * report and for anything this file does not recognise; every
         * "is this fully live" check below reads `aimState === 'present'`
         * rather than `aimState !== 'not-offered'`, so an unrecognised
         * state never falls open into a live control. */
        aimState () {
            return (this.report && this.report.state) || 'not-offered'
        },
        /** A camera that has no aim capability gets no empty side panel or
         * handle. `advertised` and `gated` still offer Aim, even though their
         * controls remain inoperative as their existing state requires. */
        aimOffered () {
            return Boolean(this.report) && this.aimState !== 'not-offered'
        },
        /** The stable browser preference belongs to the camera, never to a
         * transient selected-card position or Dashboard widget instance. */
        drawerCameraKey () {
            return this.cameraKey || this.report?.camera || this.report?.cameraKey || this.report?.cameraId || this.id
        },
        drawerState () {
            if (!this.collapsible) return null
            if (!this.aimOffered) return 'absent'
            return this.drawerOpen ? 'open' : 'closed'
        },
        drawerId () {
            return `aim-drawer-${this.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
        },
        reason () {
            return (this.report && this.report.reason) || ''
        },
        pan () {
            return this.report && typeof this.report.pan === 'number' ? this.report.pan : null
        },
        tilt () {
            return this.report && typeof this.report.tilt === 'number' ? this.report.tilt : null
        },
        bounds () {
            return (this.report && this.report.bounds) || null
        },
        hasBounds () {
            return Boolean(this.bounds)
        },
        panBounds () {
            return boundsOf(this.bounds, 'pan', -180, 180)
        },
        tiltBounds () {
            return boundsOf(this.bounds, 'tilt', -90, 90)
        },
        atLimit () {
            return (this.report && this.report.atLimit) || {}
        },
        mode () {
            return (this.report && this.report.mode) || ''
        },
        modes () {
            return this.report && Array.isArray(this.report.modes) ? this.report.modes : []
        },
        /** The daemon's own guard reason (§8.7) — a temporary "not right
         * now" on an otherwise-present capability, orthogonal to `aimState`.
         * See this component's own doc comment on why these are two facts. */
        inhibited () {
            return (this.report && this.report.inhibited) || null
        },
        /** Whichever single reason currently applies. Never both: a
         * capability that is not `present` has nothing left for a live
         * guard to be temporarily inhibiting on top of. */
        effectiveReason () {
            if (this.aimState !== 'present') return this.reason || ''
            return this.inhibited || ''
        },
        /** Always a fresh, live projection of props — never assigned into
         * `data()` — so the pad's own `watch: { inhibited }` keeps reacting
         * exactly as Task 20 built it (coordinator resolution 6). */
        padInhibited () {
            if (this.signInRequired) return 'Sign in required'
            // Truthy so the pad refuses a press, but **short**: a camera that
            // is not answering at all is the panel's fact and its head says it
            // in full. The pad used to repeat that whole sentence, and so did
            // both gauges and the mode control — four copies of it, more prose
            // than the panel was tall, drawn over the dial it explained.
            if (this.aimState !== 'present') return 'not answering'
            return this.inhibited || null
        },

        /**
         * The reason a *position* cannot be shown, which is the only kind
         * these gauges and the mode control should carry.
         *
         * An inhibition is about the reading — *position has not been
         * established yet* — so it belongs on the thing that would have shown
         * it. A camera that is not answering at all is not about any one
         * reading; that is said once, at the head of the panel.
         */
        gaugeReason () {
            return this.aimState === 'present' ? (this.inhibited || '') : ''
        },
        badgeText () {
            return this.aimState === 'present' ? 'RATE CONTROL' : 'NOT ANSWERING'
        },
        /** `YonderColumn`'s own tone lookup recognises `select`/`waiting`
         * and falls back to the plain label colour for anything else —
         * `gated` reaching that fallback is R-UI-21's own neutral tone,
         * with no third tone name invented here to get it. */
        badgeTone () {
            if (this.aimState === 'present') return 'select'
            if (this.aimState === 'advertised') return 'waiting'
            return ''
        },
        /** `not-offered` when the device offers no choice at all — the same
         * silence `YonderSegmented` already draws for that state, so an
         * empty `modes` list never renders a labelled control with nothing
         * inside its own group. Otherwise mirrors `aimState`.
         *
         * **A live capability under a temporary guard reads `gated`, not
         * `advertised`.** This said `advertised` and review caught it: in
         * this codebase's own vocabulary `advertised` means a fault — the
         * device accepts the command and does not deliver it — and it draws
         * in the caution tone. `inhibited` is not that. Everywhere else on
         * this same panel it is drawn neutral, and the amber here put two
         * different severity signals on one screen for one condition;
         * measured in the running gallery, the panel's reason computed to
         * the neutral colour while this control and its reason computed to
         * the caution one. `gated` is the state `YonderSegmented` already
         * has for exactly this — not broken, not available right now — and
         * R-UI-21 says why: drawing it in caution would tell an operator
         * something is broken when nothing is. §8.7's guard still covers
         * rate, mode and Recentre together; that is about *what* is
         * inhibited, not about how severe it looks. */
        modeControlState () {
            if (!this.modes.length) return 'not-offered'
            if (this.aimState !== 'present') return this.aimState
            if (this.signInRequired || this.inhibited || this.report?.modeInhibited || this.activePreset !== null) return 'gated'
            return 'present'
        },
        /** A full sentence, not a bare label — see this component's own
         * doc comment on why. */
        modeSentence () {
            return this.mode ? `Gimbal mode: ${this.mode}.` : ''
        },
        rateShown () {
            return Math.hypot(this.commandedPan, this.commandedTilt).toFixed(0)
        },
        /** Recentre is a command to an aircraft, guarded the same way the
         * shutter's own `pending` guard is, twice over (see this
         * component's own doc comment): `aimState !== 'present'` (the
         * device does not answer aim at all), `inhibited` (a live, temporary
         * guard — §8.7 covers Recentre under the identical guard as rate and
         * mode), or `recentrePending` (this press has not yet been
         * followed by a fresh report). */
        recentreDisabled () {
            return this.signInRequired || this.aimState !== 'present' || Boolean(this.inhibited) || Boolean(this.report?.recentreInhibited) || this.recentrePending || this.activePreset !== null
        }
    },
    watch: {
        drawerCameraKey (now, before) {
            if (this.collapsible && now !== before) this.drawerOpen = drawerPreference(now)
        },
        /** The nearest honest "seen since" signal this payload has for a
         * fire-and-forget Recentre press — see this component's own doc
         * comment. Fires on every fresh report, which is deliberate: a
         * player who presses Recentre and immediately loses the report
         * feed (page torn down, camera unplugged) simply keeps the guard
         * up, which is the safe direction to fail in. */
        report (now, before) {
            if (now?.generation !== before?.generation || now?.url !== before?.url || now?.imageDirection !== before?.imageDirection) this.$refs.aimPad?.onEnd()
            this.recentrePending = false
            this.aimTransport?.refresh()
        }
    },
    created () {
        if (this.collapsible) this.drawerOpen = drawerPreference(this.drawerCameraKey)
        this.$dataTracker(this.id)
        this.aimTransport = new AimTransport(() => this.report, (rate, reason) => { this.commandedPan = rate.pan; this.commandedTilt = rate.tilt; this.aimError = reason }, undefined, state => {
            this.activePreset = state?.state === 'moving' ? state.slot : null
            this.presetMessage = state ? `${state.state === 'moving' ? 'Moving to' : 'Reached'} ${state.name || `preset ${state.slot}`}.` : ''
        })
        this.$socket.on?.('disconnect', this.aimDisconnect)
    },
    beforeUnmount () { this.aimTransport?.close(); this.$socket.off?.('disconnect', this.aimDisconnect) },
    methods: {
        setDrawerOpen (open) {
            if (!this.collapsible || !this.aimOffered || this.drawerOpen === open) return
            // Hiding a live pad ends its active gesture. `onEnd()` is
            // idempotent, so this relays a stop only when movement is active.
            if (!open) this.$refs.aimPad?.onEnd()
            this.drawerOpen = open
            saveDrawerPreference(this.drawerCameraKey, open)
            this.$emit('drawer-change', { cameraKey: this.drawerCameraKey, open })
        },
        toggleDrawer () { this.setDrawerOpen(!this.drawerOpen) },
        recallPreset ({slot,revision}) {
            if (!this.presetReady) return
            this.$refs.aimPad?.onEnd()
            this.aimTransport.recall(slot,revision,Math.min(60,savedNumber(SPEED_KEY,60,1,120)))
        },
        onCameraSessionExpired () { this.aimDisconnect() },
        aimDisconnect () { this.aimTransport?.stop(); this.$refs.aimPad?.onEnd() },
        /** Every message this node posts leaves through here — one seam,
         * the same reasoning `YonderDeck`'s own `post()` gives for having
         * exactly one. */
        post (payload) {
            if (this.signInRequired) return
            this.$socket.emit('widget-action', this.id, { payload })
        },
        /** Relayed verbatim (coordinator resolution 3) — `seq` is the
         * pad's own lifetime-monotonic counter, never recomputed here. */
        onSlew (e) {
            if (this.signInRequired) return
            if (this.report?.url) { this.aimTransport.update(e); return }
            this.commandedPan = e.pan
            this.commandedTilt = e.tilt
            this.post({ slew: { pan: e.pan, tilt: e.tilt, seq: e.seq, gesture: e.gesture } })
        },
        /** `stop` carries `gesture` and nothing else, by the pad's own
         * design — see this component's own doc comment on why this
         * deliberately does not follow `YonderDeck.buildAim()`'s own choice
         * to add `pan: 0, tilt: 0` to its stop relay. */
        onStop (e) {
            if (this.report?.url) { this.aimTransport.stop(); return }
            this.commandedPan = 0
            this.commandedTilt = 0
            this.post({ stop: { gesture: e.gesture } })
        },
        onModeChange (m) {
            if (this.activePreset !== null) return
            if (this.report?.url) { void this.aimTransport.action({ op: 'mode', mode: this.modes.indexOf(m) }); return }
            this.post({ mode: m })
        },
        pressRecentre () {
            // Two independent guards, the same shape `YonderShutter`'s own
            // `pending` documents: `:disabled` stops an ordinary press,
            // this stops a dispatched one a disabled attribute alone does
            // not reach in a real browser.
            if (this.recentreDisabled) return
            this.recentrePending = true
            if (this.report?.url) { void this.aimTransport.action({ op: 'recentre' }).finally(() => { this.recentrePending = false }); return }
            this.post({ recentre: true })
        }
    }
}
</script>

<style scoped>
.y-aimpanel { container-type: inline-size; }
.y-aimpanel__mode { color: var(--yonder-value, #cdd5dc); }
.y-aimpanel__mode-help { margin:8px 0 0; font-size:11px; line-height:1.45; color:var(--yonder-label, #7f8a95); }
.y-aimpanel__position { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 10px; }
.y-aimpanel__position div { display: flex; justify-content: space-between; gap: 8px; }
.y-aimpanel__position dt { color: var(--yonder-label, #7f8a95); font-size: 11px; }
.y-aimpanel__position dd { margin: 0; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--yonder-value, #fff); }
.y-aimpanel { font-family: var(--yonder-font, system-ui, sans-serif); }
.y-aimpanel--collapsible {
    font-family: var(--yonder-font, system-ui, sans-serif);
    display: flex;
    align-items: stretch;
    min-width: 0;
    position: relative;
}
.y-aimpanel__fact { display: flex; gap: 10px; align-items: baseline; padding: 4px 16px; font-size: 13px; }
.y-aimpanel__fact-l { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--yonder-label, #7f8a95); min-width: 90px; }
.y-aimpanel__fact-v { color: var(--yonder-neutral, #7d7869); }
.y-aimpanel__empty {
    padding: 14px 16px;
    color: var(--yonder-label, #7f8a95);
    font-size: 12px;
}
.y-aimpanel__handle {
    order: 2;
    align-self: stretch;
    margin-left: auto;
    min-width: 44px;
    min-height: 44px;
    padding: 8px 6px;
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 0 3px 3px 0;
    background: var(--yonder-pane, #0c1218);
    color: var(--yonder-value, #fff);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .1em;
    text-transform: uppercase;
    cursor: pointer;
}
.y-aimpanel__handle:hover,
.y-aimpanel__handle:focus-visible {
    border-color: var(--yonder-select, #2ad4f0);
    color: var(--yonder-select, #2ad4f0);
    outline: none;
}
.y-aimpanel__handle i { display: block; margin-top: 5px; font-size: 16px; font-style: normal; line-height: 1; }
.y-aimpanel__drawer { order: 1; min-width: 0; flex: 1; padding: 0 4px; }

/* A narrow screen keeps the receiver at its normal width. The drawer sits
   over the picture workspace until the operator closes it; it never narrows
   the video column or causes that receiver to be recreated. */
@container camera-workspace (max-width: 899px) {
    .y-aimpanel__handle { margin-left: auto; }
    .y-aimpanel[data-aim-state='open'] .y-aimpanel__drawer {
        position: absolute;
        z-index: 20;
        right: 44px;
        top: 0;
        width: min(280px, calc(100cqw - 76px));
        box-sizing: border-box;
        max-height: min(calc(100dvh - 140px), 42rem);
        overflow: auto;
        padding: 12px;
        border: 1px solid var(--yonder-divider, #2b333c);
        border-radius: 3px 0 0 3px;
        background: var(--yonder-pane, #0c1218);
        box-shadow: -10px 0 24px rgba(0, 0, 0, .28);
    }
}

/* Always the neutral tone, deliberately, rather than a second tone lookup
   keyed on aimState. The badge beside this line (`badgeTone`) already
   carries "how serious is this" at a glance — select, waiting or the
   neutral fallback — so this sentence only has to be legible, not to
   re-encode the same severity a second time in a second place. */
.y-aimpanel__reason {
    font-size: 11px;
    line-height: 1.4;
    margin-bottom: 10px;
    color: var(--yonder-neutral, #7d7869);
}

.y-aimpanel__rate {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
}
.y-aimpanel__rate-l {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}
.y-aimpanel__rate-v {
    font-size: 20px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #ffffff);
}
.y-aimpanel__rate-v i {
    font-style: normal;
    font-weight: 400;
    font-size: 11px;
    text-transform: none;
    margin-left: 4px;
    color: var(--yonder-label, #7f8a95);
}

.y-aimpanel__reported,
.y-aimpanel__modeline {
    font-size: 12px;
    color: var(--yonder-value, #ffffff);
    margin-bottom: 6px;
}

.y-aimpanel__recentre {
    margin-top: 4px;
    min-width: 8rem;
    min-height: 34px;
    padding: 7px 14px;
    border-radius: 3px;
    border: 1px solid var(--yonder-divider, #2b333c);
    background: transparent;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--yonder-value, #ffffff);
    cursor: pointer;
}
.y-aimpanel__recentre:hover:not(:disabled) { border-color: var(--yonder-select, #2ad4f0); color: var(--yonder-select, #2ad4f0); }
.y-aimpanel__recentre:disabled { cursor: not-allowed; opacity: 0.5; }
</style>
