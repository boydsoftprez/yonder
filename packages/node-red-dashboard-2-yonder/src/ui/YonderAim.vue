<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-aimpanel">
        <div v-if="!report" class="y-aimpanel__empty">Waiting for this camera's report.</div>
        <div v-else-if="aimState === 'not-offered'" class="y-aimpanel__fact">
            <span class="y-aimpanel__fact-l">Aim</span>
            <span class="y-aimpanel__fact-v">{{ reason || 'this camera has none' }}</span>
        </div>
        <YonderColumn v-else legend="Aim" :qualifier="badgeText" :tone="badgeTone">
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

            <YonderAimPad
                ref="aimPad"
                :axes="PAD_AXES"
                :max-rate="report.maxRate ?? 30"
                :at-limit="atLimit"
                :inhibited="padInhibited"
                @slew="onSlew"
                @stop="onStop"
            />

            <div v-if="aimState === 'present'" class="y-aimpanel__rate">
                <span class="y-aimpanel__rate-l">Commanded rate</span>
                <span class="y-aimpanel__rate-v">{{ rateShown }}<i>°/s</i></span>
            </div>

            <div class="y-aimpanel__reported">Reported position</div>
            <YonderPositionGauge label="Pan" unit="°" :value="pan" :min="panBounds.lo" :max="panBounds.hi" :bounds-known="hasBounds" :dead="aimState !== 'present' || pan === null" :reason="gaugeReason" />
            <YonderPositionGauge label="Tilt" unit="°" :value="tilt" :min="tiltBounds.lo" :max="tiltBounds.hi" :bounds-known="hasBounds" :dead="aimState !== 'present' || tilt === null" :reason="gaugeReason" />

            <div v-if="mode" class="y-aimpanel__modeline">{{ modeSentence }}</div>
            <YonderSegmented
                label="Gimbal mode"
                :value="mode"
                :options="modes"
                :state="modeControlState"
                :reason="report.modeInhibited || gaugeReason"
                @change="onModeChange"
            />

            <button type="button" class="y-aimpanel__recentre" :disabled="recentreDisabled" :title="report.recentreInhibited || ''" @click="pressRecentre">Recentre gimbal</button>
            <div v-if="report.recentreInhibited" class="y-aimpanel__reason">{{ report.recentreInhibited }}</div>
        </YonderColumn>
    </div>
</template>

<script>
import YonderAimPad from './YonderAimPad.vue'
import YonderPositionGauge from './YonderPositionGauge.vue'
import YonderSegmented from './YonderSegmented.vue'
import YonderColumn from './YonderColumn.vue'
import { AimTransport } from './aim-transport.ts'

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
const PAD_AXES = { pan: 'present', tilt: 'present', roll: 'advertised' }

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
    inject: ['$socket', '$dataTracker'],
    components: { YonderAimPad, YonderPositionGauge, YonderSegmented, YonderColumn },
    props: {
        id: { type: String, required: true },
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
        recentrePending: false
    }),
    computed: {
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
            if (this.inhibited || this.report?.modeInhibited) return 'gated'
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
            return this.aimState !== 'present' || Boolean(this.inhibited) || Boolean(this.report?.recentreInhibited) || this.recentrePending
        }
    },
    watch: {
        /** The nearest honest "seen since" signal this payload has for a
         * fire-and-forget Recentre press — see this component's own doc
         * comment. Fires on every fresh report, which is deliberate: a
         * player who presses Recentre and immediately loses the report
         * feed (page torn down, camera unplugged) simply keeps the guard
         * up, which is the safe direction to fail in. */
        report (now, before) {
            if (now?.generation !== before?.generation || now?.url !== before?.url) this.$refs.aimPad?.onEnd()
            this.recentrePending = false
            this.aimTransport?.refresh()
        }
    },
    created () {
        this.$dataTracker(this.id)
        this.aimTransport = new AimTransport(() => this.report, (rate, reason) => { this.commandedPan = rate.pan; this.commandedTilt = rate.tilt; this.aimError = reason })
        this.$socket.on?.('disconnect', this.aimDisconnect)
    },
    beforeUnmount () { this.aimTransport?.close(); this.$socket.off?.('disconnect', this.aimDisconnect) },
    methods: {
        aimDisconnect () { this.aimTransport?.stop(); this.$refs.aimPad?.onEnd() },
        /** Every message this node posts leaves through here — one seam,
         * the same reasoning `YonderDeck`'s own `post()` gives for having
         * exactly one. */
        post (payload) {
            this.$socket.emit('widget-action', this.id, { payload })
        },
        /** Relayed verbatim (coordinator resolution 3) — `seq` is the
         * pad's own lifetime-monotonic counter, never recomputed here. */
        onSlew (e) {
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
.y-aimpanel {
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-aimpanel__empty {
    padding: 14px 16px;
    color: var(--yonder-label, #7f8a95);
    font-size: 12px;
}
.y-aimpanel__fact {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 4px 16px;
    font-size: 13px;
}
.y-aimpanel__fact-l {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    min-width: 90px;
}
.y-aimpanel__fact-v { color: var(--yonder-neutral, #7d7869); }

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
