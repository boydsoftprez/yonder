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
              restate why. **The pad stopped in Task 49** — the first
              photograph of this panel with a gimbal answering showed it saying
              the head's own sentence again, 40 px below it (K-63) — and
              `padNote` is where that is decided.

              **`gaugeReason` is the part of this that is still true and
              should not be**, and it is recorded rather than quietly fixed:
              it is non-empty in exactly the states where this head is already
              drawing the same sentence, so it is a third and fourth copy,
              latent because nothing on the bench draws a dead gauge or a mode
              control at the same time as an inhibition. Removing it overturns
              a documented decision and runs into R-UI-21's own requirement
              that a gated control name what has charge of it, so it is the
              operator's — K-63's own "what is not closed" says so in full.
            -->
            <div v-if="effectiveReason" class="y-aimpanel__reason">{{ effectiveReason }}</div>

            <YonderAimPad
                :axes="PAD_AXES"
                :at-limit="atLimit"
                :inhibited="padInhibited"
                :note="padNote"
                @slew="onSlew"
                @stop="onStop"
            />

            <!-- L-33: the gauges are a *reading*, and the blueprint says so
                 above them. Without it the two rows read as controls sitting
                 loose under the dial. -->
            <div class="y-aimpanel__sub">Reported position</div>
            <YonderPositionGauge label="Pan" unit="°" :value="pan" :min="panBounds.lo" :max="panBounds.hi" :dead="!hasBounds" :reason="gaugeReason" />
            <YonderPositionGauge label="Tilt" unit="°" :value="tilt" :min="tiltBounds.lo" :max="tiltBounds.hi" :dead="!hasBounds" :reason="gaugeReason" />

            <!-- L-36: below the gauges, and against its bounds. Above them it
                 shared a line with the annunciator drawn beneath this panel
                 and the badge was painted over the words (K-63). -->
            <div v-if="aimState === 'present'" class="y-aimpanel__rate">
                <div class="y-aimpanel__sub">Commanded rate</div>
                <div class="y-aimpanel__rate-v">{{ rateShown }}<i>°/s</i></div>
                <div class="y-aimpanel__rate-b"><span>0</span><i /><span>{{ MAX_RATE }} °/s</span></div>
            </div>

            <!-- L-37 and R-UI-20: the modes the device states, and where it
                 states none, the fact where the control would have been —
                 never a labelled box with nothing in it, and never three
                 modes this gimbal never claimed. -->
            <YonderSegmented
                v-if="modes.length"
                label="Gimbal mode"
                :value="mode"
                :options="modes"
                :state="modeControlState"
                :reason="gaugeReason"
                @change="onModeChange"
            />
            <div v-else class="y-aimpanel__nomode">
                <span class="y-aimpanel__nomode-l">Gimbal mode</span>
                <span class="y-aimpanel__nomode-v">{{ modeAbsence }}</span>
            </div>

            <!-- L-38, L-39: what the mode *does*, under the control. -->
            <div v-if="modeSentence" class="y-aimpanel__modeline">{{ modeSentence }}</div>

            <button type="button" class="y-aimpanel__recentre" :disabled="recentreDisabled" @click="pressRecentre">Recentre gimbal</button>
        </YonderColumn>
    </div>
</template>

<script>
import YonderAimPad, { MAX_RATE } from './YonderAimPad.vue'
import YonderPositionGauge from './YonderPositionGauge.vue'
import YonderSegmented from './YonderSegmented.vue'
import YonderColumn from './YonderColumn.vue'

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
 * **The block is drawn below the gauges and against its bounds** (L-36), and
 * the ceiling is `YonderAimPad`'s own exported `MAX_RATE`, imported rather
 * than written down again. **That is the rate this pad commands at the rim,
 * and it is deliberately not a claim about the gimbal**: this node's payload
 * carries no maximum rate at all — `aimPanel()` in `yonder-core` answers
 * `state`, `reason`, the two readings, the envelope, `atLimit`, `mode`,
 * `modes` and `inhibited`, and nothing about how fast the device can slew —
 * so the only honest ceiling this panel has is the one it can ask for. The
 * blueprint's own draft holds the same number for the same reason, in the
 * same one place. If a gimbal ever states its own maximum, that is a field
 * on the payload and this is where it lands.
 *
 * **The mode sentence says what the mode does** (L-38), under the control
 * (L-39) — see `MODE_SENTENCES` above, which also records why this file
 * previously refused to write one and what changed.
 *
 * **Where the device states no modes, the fact goes where the control
 * would have been** (`modeAbsence`, R-UI-20). Not an empty group, and not
 * the blueprint's three modes drawn on a gimbal that never claimed them.
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

/**
 * What each mode *does*, in the operator's words — L-38, keyed on the
 * device's own word for it, lowercased so `follow` and `Follow` are one mode.
 *
 * **This file used to refuse to write these**, and said so at length: the
 * modes are the device's words, and expanding one into a description is
 * inventing a meaning the device never sent. The blueprint overrules that,
 * and rule 7 is why — `aim.pocket2.png` draws `Pan and tilt follow the
 * handle.` under the control, in those words, and the sentence that shipped
 * instead (`Gimbal mode: follow.`) restates the label above it and tells an
 * operator nothing they could not already read.
 *
 * The refusal survives where it was actually right: **a mode with no sentence
 * here gets none**, rather than a generated one. These three are the
 * blueprint's own, written down once; a gimbal that answers a fourth word has
 * that word drawn as its mode and no claim made about what it does, because
 * nobody has looked at that gimbal yet. R-UI-20 is satisfied either way — the
 * mode itself is never missing, only the gloss.
 */
const MODE_SENTENCES = {
    follow: 'Pan and tilt follow the handle.',
    'tilt lock': 'Tilt holds where it is. Pan follows the handle.',
    fpv: 'Pan, tilt and roll follow the aircraft.'
}

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
        /** The pad's own rim rate, so the bounds row under the commanded
         * rate reads the same number the pad commands. See `rateShown`. */
        MAX_RATE,
        /** A display cache of the pad's own last relayed rate — fed by
         * `onSlew`/`onStop`, never re-derived from `inhibited` or `aimState`.
         * See this component's own doc comment on "the rate block". */
        commandedPan: 0,
        commandedTilt: 0,
        /** See this component's own doc comment on `Recentre`. */
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
            return this.report && typeof this.report.pan === 'number' ? this.report.pan : 0
        },
        tilt () {
            return this.report && typeof this.report.tilt === 'number' ? this.report.tilt : 0
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
         * **The sentence the pad says — and never the one this panel's head
         * already says.** K-63's second part: with a gimbal answering
         * `present` under a guard, `effectiveReason` *is* `inhibited`, and the
         * pad drew that same sentence again under the dial. One fact, twice,
         * 40 px apart.
         *
         * Which one goes is settled by ownership rather than by comparison
         * (the brief's own instruction, and the right rule anyway): this file
         * already states, above, that the reason is "said once, at the top,
         * for the whole panel", so the top keeps it and the pad's copy goes.
         * `padInhibited` is untouched — the guard still refuses the press, it
         * simply no longer repeats why.
         *
         * While the state is anything other than `present` the two are
         * different sentences by construction, not by luck: the head carries
         * the device's own full reason and the pad says the short `not
         * answering`, which is the arrangement Task 23 already chose and
         * `aim.component.test.ts` already asserts. So the pad is silenced in
         * exactly one state, and it is the one where the two would collide.
         */
        padNote () {
            return this.aimState === 'present' ? '' : 'not answering'
        },

        /**
         * The reason a *position* cannot be shown, which is the only kind
         * these gauges and the mode control should carry.
         *
         * An inhibition is about the reading — *position has not been
         * established yet* — so it belongs on the thing that would have shown
         * it. A camera that is not answering at all is not about any one
         * reading; that is said once, at the head of the panel.
         *
         * **Read that against `effectiveReason` before touching either.**
         * This is non-empty exactly when `aimState === 'present'` and
         * `inhibited` is set — which is exactly when `effectiveReason`
         * resolves to that same string — so whenever a child actually draws
         * this, the head above it has already said it. That is the same
         * defect `padNote` closes for the pad (K-63), one component further
         * along, and it is left standing deliberately: closing it means
         * overturning the decision this comment states, and deleting it
         * outright would leave a dead gauge saying nothing about why it is
         * dead, which is R-UI-20's own concern. Nothing photographs it today
         * — the gate's fixture answers a known envelope, so neither gauge is
         * dead, and `modes: []`, so there is no control to carry a reason —
         * but this package's own gallery does, in `Aim panel — inhibited`.
         * **Owner: the operator**, put to them 2026-09-08; K-63's own "what
         * is not closed" carries both sides.
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
        /** Mirrors `aimState`, except that a live capability under a
         * temporary guard reads `gated`.
         *
         * **It no longer answers `not-offered` for an empty `modes`.** That
         * branch existed to keep `YonderSegmented` from drawing a labelled
         * box with nothing in it, and it worked — but it worked by making the
         * control *silently vanish*, which is the other half of R-UI-20 and
         * is what the first photograph of this panel with a gimbal on it
         * actually showed: no control, no fact, nothing where the blueprint
         * draws three modes. The template decides that now, in the open —
         * `v-if="modes.length"` draws the control, `v-else` draws the fact
         * where it would have been — and `YonderSegmented` keeps its own,
         * separate guarantee that an empty `options` draws nothing, so no
         * other caller can make the empty box either. Two guards, each
         * covering ground the other does not: removing the template's
         * `v-if` loses the sentence, removing the component's loses the
         * promise it makes to every other caller.
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
            if (this.aimState !== 'present') return this.aimState
            if (this.inhibited) return 'gated'
            return 'present'
        },
        /** The device's own word for the mode, normalised for the lookup
         * below: `Tilt lock`, `tilt lock` and `TILT LOCK` are one mode. */
        modeKey () {
            return String(this.mode || '').trim().toLowerCase()
        },
        /** What this mode does, in the operator's words, under the control
         * (L-38, L-39) — `MODE_SENTENCES` above says why this file writes
         * one, and why a mode it has no sentence for gets none rather than
         * a generated one. */
        modeSentence () {
            return MODE_SENTENCES[this.modeKey] || ''
        },
        /**
         * The fact drawn where the mode control would have been, when the
         * device states no modes to choose from (R-UI-20; K-63's fourth
         * part).
         *
         * It says what was *reported*, never what exists: `modes: []` is a
         * gimbal that has not listed its modes, not a gimbal that has one.
         * Today it is `aimPanel`'s own honest answer — §8.7's mode
         * enumeration (`0x44`) is unbuilt, so nothing has ever asked — and
         * drawing the blueprint's `Follow │ Tilt lock │ FPV` here anyway
         * would be this console inventing a device's capabilities, which is
         * the one thing R-UI-20 exists to stop.
         */
        modeAbsence () {
            const said = 'this gimbal has not said what it can be set to'
            return this.mode ? `${this.mode} — and ${said}` : said
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
            return this.aimState !== 'present' || Boolean(this.inhibited) || this.recentrePending
        }
    },
    watch: {
        /** The nearest honest "seen since" signal this payload has for a
         * fire-and-forget Recentre press — see this component's own doc
         * comment. Fires on every fresh report, which is deliberate: a
         * player who presses Recentre and immediately loses the report
         * feed (page torn down, camera unplugged) simply keeps the guard
         * up, which is the safe direction to fail in. */
        report () {
            this.recentrePending = false
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        /** Every message this node posts leaves through here — one seam,
         * the same reasoning `YonderDeck`'s own `post()` gives for having
         * exactly one. */
        post (payload) {
            this.$socket.emit('widget-action', this.id, { payload })
        },
        /** Relayed verbatim (coordinator resolution 3) — `seq` is the
         * pad's own lifetime-monotonic counter, never recomputed here. */
        onSlew (e) {
            this.commandedPan = e.pan
            this.commandedTilt = e.tilt
            this.post({ slew: { pan: e.pan, tilt: e.tilt, seq: e.seq, gesture: e.gesture } })
        },
        /** `stop` carries `gesture` and nothing else, by the pad's own
         * design — see this component's own doc comment on why this
         * deliberately does not follow `YonderDeck.buildAim()`'s own choice
         * to add `pan: 0, tilt: 0` to its stop relay. */
        onStop (e) {
            this.commandedPan = 0
            this.commandedTilt = 0
            this.post({ stop: { gesture: e.gesture } })
        },
        onModeChange (m) {
            this.post({ mode: m })
        },
        pressRecentre () {
            // Two independent guards, the same shape `YonderShutter`'s own
            // `pending` documents: `:disabled` stops an ordinary press,
            // this stops a dispatched one a disabled attribute alone does
            // not reach in a real browser.
            if (this.recentreDisabled) return
            this.recentrePending = true
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

/* The sub-heading over a block of readings — `Reported position`,
   `Commanded rate`. Not invented here: these are the blueprint's own
   `.d-blk__h` values (`gallery/DraftAimDial.vue`, read not modified), which
   is where both headings are drawn in `aim.pocket2.png`. Deliberately not
   `YonderColumn`'s own head or the deck's `.y-deck__aim-h` — those are the
   uppercase, letter-spaced legend of a whole group, and this is a label
   *inside* one, drawn in the render at the same weight and case as the mode
   sentence below it. */
.y-aimpanel__sub {
    display: block;
    font-size: 12px;
    color: var(--yonder-label, #7f8a95);
    margin: 12px 0 8px;
}
/* The first one heads the gauges directly under the dial, which brings its
   own 8px gap — the render puts one space there, not two. */
.y-aimpanel__sub:first-of-type { margin-top: 4px; }

/* Below the gauges, and drawn against its bounds (L-36). It used to be a
   one-line label-and-value above them, which put it on the same line as the
   annunciator this panel sits above and had the badge painted over the
   words. */
.y-aimpanel__rate {
    margin-bottom: 10px;
}
.y-aimpanel__rate-v {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
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
/* `0 — 30 °/s`: the floor, a divider tick, and the ceiling. The same
   `space-between` across the panel's own width that `YonderPositionGauge`'s
   `.y-pg__bounds` uses two rows above it, and no `max-width`, so the three
   bounds rows share one right edge exactly as they do in the render. */
.y-aimpanel__rate-b {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 2px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-aimpanel__rate-b i {
    width: 18px;
    height: 1px;
    background: var(--yonder-divider, #2b333c);
}

/* The fact drawn where the mode control would have been.

   **Deliberately not `.y-aimpanel__fact`**, which is the whole panel's own
   one-line collapse (`Aim · this camera has none`) and carries the panel's
   own 16px side padding — inside `YonderColumn` that indents twice, and its
   90px label column squeezed this sentence into four narrow lines.

   The label is `YonderSegmented`'s own `.y-seg__label`, value for value,
   copied rather than shared because a scoped style cannot be. Copied
   *deliberately*: this block stands in for that control, in the same row of
   the same panel, and an operator who sees `GIMBAL MODE` on one camera and
   `Gimbal mode` on the next reads two different things. The blueprint draws
   this heading in the panel's own sentence-case block style
   (`.y-aimpanel__sub`) and every other segmented control in this console —
   MODE, BITRATE, RESOLUTION — is uppercase in its own approved render; the
   two renders disagree about one shared component, and that is the
   operator's to settle, not this file's. Until they do, the two states of
   this row match each other.

   The sentence takes `.y-seg__why`'s own gated tone and width: neutral,
   because nothing here is broken. */
.y-aimpanel__nomode { margin-bottom: 13px; max-width: 230px; }
.y-aimpanel__nomode-l {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 5px;
}
.y-aimpanel__nomode-v {
    display: block;
    font-size: 11px;
    line-height: 1.4;
    color: var(--yonder-neutral, #7d7869);
}

/* Under the control, not over it (L-39) — it explains the thing above it. */
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
