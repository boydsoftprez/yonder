<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-aim">
        <svg ref="dial" class="y-aim__dial" :class="{ 'is-pushing': pushing, 'is-inhibited': !!inhibited }"
             :width="DIAL_SIZE" :height="DIAL_SIZE" viewBox="0 0 118 118"
             @pointerdown="down" @pointermove="move"
             @pointerup="onEnd" @pointercancel="onEnd" @pointerleave="onEnd" @lostpointercapture="onEnd">
            <circle class="y-aim__ring" cx="59" cy="59" r="54" />
            <!-- crosshair, stopping short of the puck -->
            <g class="y-aim__cross">
                <path d="M59 8v37 M59 73v38 M8 59h37 M73 59h38" />
            </g>
            <g class="y-aim__labels" font-size="7.5" font-family="ui-sans-serif,system-ui" letter-spacing=".8" text-anchor="middle">
                <text x="59" y="24">TILT +</text><text x="59" y="89">PAN</text>
                <text x="22" y="62">&#8722;</text><text x="96" y="62">+</text>
            </g>
            <!-- an axis that will not answer stays on the pad, struck and labelled -->
            <g v-if="rollStruck" class="y-aim__struck">
                <path class="y-aim__struck-arc" d="M 26 96 A 49 49 0 0 0 92 96" />
                <text class="y-aim__struck-label" x="59" y="116" text-anchor="middle" font-size="7.5"
                      letter-spacing=".8" font-family="ui-sans-serif,system-ui">ROLL &#8212;</text>
            </g>
            <!-- the puck: where the operator is pushing, or the centre at rest -->
            <circle class="y-aim__puck-halo" :cx="px" :cy="py" r="11" />
            <circle class="y-aim__puck-core" :cx="px" :cy="py" r="6.5" />
        </svg>

        <div v-if="limited" class="y-aim__limit"><i class="y-aim__limit-dot" />At the limit</div>
        <div v-if="saying" class="y-aim__reason">{{ saying }}</div>
    </div>
</template>

<script>
/**
 * The aim pad — a gimbal's pan and tilt, slewed at a rate for as long as an
 * operator holds the pad (R-CAM-11). This is the only control in this whole
 * library where a press becomes movement on an aircraft, and R-CMD-04 —
 * Yonder relays commands and never originates them — governs everything
 * below: a press is an instruction to move at a rate for as long as it is
 * held, and the instant the operator stops, the aircraft must stop.
 *
 * Ported from the blueprint's `DraftAimDial.vue`
 * (`docs/console/design/instrument-library/gallery/`, read but not
 * modified, per instruction): the dial's geometry, the crosshair, the
 * labels, the struck-roll treatment and the haloed puck are its own,
 * carried over exactly — the operator compared two designs and chose this
 * one deliberately, and the struck-axis treatment is his. What changed is
 * the same thing that changes in every ported component in this library:
 * class names (`y-aim*`, not the draft's `d-*`), colours moved from a
 * resolved-palette `c` prop into this file's own `<style scoped>` reading
 * `var(--yonder-*, fallback)` the way every other part here already does —
 * and the state machine beneath the drag, which the draft did not get
 * right and this task exists to fix (see "exactly one stop" below). This
 * component draws only the pad itself — the "Reported position" and
 * "Commanded rate" rows the draft also drew are `YonderPositionGauge`'s own
 * territory (extracted in Task 19 for exactly this reuse) and a later
 * task's composition, not this file's.
 *
 * **Rate, never a position** (coordinator resolution 2). `slew` carries
 * `pan`/`tilt` in degrees per second, bounded by `MAX_RATE` regardless of
 * how far outside the rim the pointer goes — an absolute pointing command
 * is not exposed by this page at all. `aimpad.component.test.ts`'s own
 * "never a position" test is written to fail on an implementation that
 * emits an unbounded or non-saturating value, not merely one that emits
 * nothing.
 *
 * **`seq` increments on every slew emitted, for the life of this mounted
 * component — it does not reset at the start of a new gesture.**
 * `gesture` is a fresh id minted only when a drag leaves the dead zone,
 * held constant for every `slew`/`stop` until that gesture ends (coordinator
 * resolution 3). The daemon uses the pair to discard a stale or duplicated
 * command: `gesture` says which continuous drag a command belongs to,
 * `seq` says which order they happened in within it.
 *
 * **The dead zone ends the gesture** (coordinator resolution 4).
 * `updateFromEvent` calls `endGesture()` whenever `at()` reports the
 * pointer inside the dead zone, which emits exactly one `stop` if a gesture
 * was active and clears it; leaving the dead zone afterward — still
 * holding the same physical pointer — mints a **new** gesture id rather
 * than resuming the old one, because an operator who paused at centre and
 * pushed again has made a second instruction, not continued the first.
 * This is a deliberate departure from the blueprint's own `apply()`, which
 * silently resets its visuals and emits nothing at all when the pointer
 * returns to centre mid-drag — leaving the aircraft sending its last
 * commanded rate forever, exactly the runaway-gimbal failure R-CMD-04
 * exists to prevent.
 *
 * **Exactly one stop, for all eight endings, including the four that are
 * not pointer events at all** (coordinator resolution 5). `pointerup`,
 * `pointercancel`, `pointerleave` and `lostpointercapture` all reach the
 * same `onEnd()`, as do window `blur`, `visibilitychange` to hidden and
 * `pagehide` (attached in `mounted()`/removed in `beforeUnmount()`, the
 * same lifecycle `YonderHoldKey` already uses for its own `visibilitychange`
 * listener). `onEnd()` itself is trivial — reset `pointerId` and call
 * `endGesture()` — and idempotency lives in exactly one place,
 * `endGesture()`'s own `gesture === null` guard, not duplicated in
 * `onEnd()` too: a second guard there would have been provably redundant
 * with this one for every state this component can reach (confirmed before
 * writing it this way, not assumed), which is the exact shape of defect
 * the shutter task's own mutation testing found two tasks ago — a pair of
 * protections where neither was individually load-bearing. One guard,
 * proven necessary and sufficient by the overlapping-pair tests in
 * `aimpad.component.test.ts`.
 *
 * **Inhibited emits nothing and says why** (coordinator resolution 6).
 * `down()` refuses the press outright while `inhibited` is set — no
 * capture, no gesture, nothing. A second, different guard sits in
 * `updateFromEvent()` for a case `down()`'s own guard cannot reach: the
 * deck can set `inhibited` *while a gesture is already under way* (a fault
 * arriving mid-drag), and the `watch` below calls `endGesture()`
 * immediately rather than waiting for the operator's own release — but the
 * physical pointer can still be down and still moving, and without this
 * second check a `move()` past the dead zone would mint a fresh gesture
 * and resume slewing under a control the deck just disabled. Both guards
 * are independently tested (`aimpad.component.test.ts`'s "emits nothing
 * while inhibited" exercises the first; "cannot resume slewing after
 * becoming inhibited" exercises the second) — they are not a duplicate
 * pair, because each covers ground the other does not reach.
 *
 * **Saying why is a separate prop from refusing** (`note`, added closing
 * K-63). The guard is `inhibited` and never moves; what is drawn under the
 * dial is `note`, which defaults to the inhibition's own words and which a
 * caller that already says that sentence at the head of its own panel sets
 * to `''`. `YonderAim` does exactly that, because the two together drew one
 * sentence twice in the first photograph anything ever took of this pad with
 * a gimbal on the other end of it.
 *
 * **A struck axis is one the device advertises and will not answer**
 * (coordinator resolution 7) — drawn struck through on the pad itself,
 * never hidden, the same reasoning `YonderPositionGauge`'s own dead-axis
 * treatment gives: a control that vanishes leaves an operator unable to
 * tell *this camera cannot* from *this page failed*. Only `roll` ever
 * draws this way — the pad is a two-axis stick and has no gesture for a
 * third — and an `axes` object that simply omits `roll` fails closed to
 * struck, the same "not known is not assumed safe" rule R-CMD-04 states
 * for a command applied here to a reading.
 *
 * **`jsdom` has no pointer capture and measures nothing** (coordinator
 * resolution 8) — see `DIAL_SIZE`'s own comment below, and
 * `aimpad.component.test.ts`'s top-of-file comment for the third trap,
 * `@vue/test-utils`' own `trigger()` refusing a coordinate.
 */

/** The SVG viewBox's own centre — `viewBox="0 0 118 118"`. */
const CENTER = 59
/** The viewBox's own width/height, in SVG user units. */
const VIEWBOX = 118
/**
 * The dial's rendered size, in CSS pixels — bound into the template's own
 * `:width`/`:height` and used by `at()` below, never a measurement of the
 * rendered element.
 *
 * `jsdom` performs no layout at all: `getBoundingClientRect()` on the dial
 * returns a real `DOMRect`, not `undefined`, with `width` and `height` (and
 * `left`/`top`) reading zero — confirmed directly against this project's
 * own installed jsdom before writing a single test against it, the same
 * check `YonderSetBar`'s own `TRACK_WIDTH` comment describes for its track.
 * Converting a press with `(e.clientX - rect.left) / rect.width` is
 * therefore `x / 0` under every test in this file, which collapses every
 * press to whichever the clamp resolves an out-of-domain number to — the
 * exact "passes only because everything measures zero" failure the brief
 * warns against.
 *
 * The fix is the one this whole library already uses: the width the
 * geometry math assumes is this constant, the same number the dial's own
 * `:width`/`:height` render from, so the two can never drift apart and the
 * conversion is exact under `jsdom` and in a real browser alike. Only the
 * dial's own on-page *position* (`rect.left`/`rect.top`) still comes from
 * `getBoundingClientRect()` — a genuine layout fact no constant could stand
 * in for — and it reads zero here too, which is harmless: nothing in
 * `aimpad.component.test.ts` wraps the dial in an offset container, so a
 * press computed for SVG-space `(x, y)` lands at exactly that many CSS
 * pixels from the dial's own left/top edge either way.
 */
const DIAL_SIZE = 132
/** The dashed centre: no command inside it (the dead zone). */
const DEAD = 15
/** The rim: full rate at the edge of the inner ring. */
const RIM = 44
/**
 * Degrees per second at the rim — **exported**, because it is the upper bound
 * of the only rate this pad can command and a panel that draws that rate
 * against its bounds (`YonderAim`'s own commanded-rate block, the blueprint's
 * `0 … 30 °/s`) must read it from here rather than write `30` down a second
 * time. The blueprint's own draft holds it the same way — one `MAX_RATE`,
 * rendered into the bounds row it also drives.
 */
export const MAX_RATE = 30

/**
 * A fresh id for a new gesture — module-scoped so two mounted pads (and,
 * within one, two separate drags) never collide. Two drags must never
 * share a gesture id, and a single drag must never change it: this is
 * called exactly once per gesture, from `updateFromEvent()`, only when no
 * gesture is currently active.
 */
let gestureCounter = 0
function newGestureId () {
    gestureCounter += 1
    return 'aim-' + gestureCounter
}

export default {
    name: 'YonderAimPad',
    props: {
        /** Per-axis capability state. Only `roll`'s absence from
         * `'present'` is drawn (struck) — the pad has no gesture for a
         * third axis at all. */
        axes: { type: Object, default: () => ({ pan: 'present', tilt: 'present', roll: 'present' }) },
        /** Live, continuously-reported facts from the device — never a
         * recorded envelope (the range finder this plan removed). */
        atLimit: { type: Object, default: () => ({}) },
        /** A general inhibition reason, or `null`. The deck supplies
         * whatever is true; this component states no opinion on why.
         *
         * **This is the guard, not the sentence.** It refuses the press; what
         * is *drawn* beneath the dial is `note` below, which defaults to this
         * string and can be silenced without loosening the guard. */
        inhibited: { type: String, default: null },
        /**
         * What this pad says for itself, beneath the dial — `null` (the
         * default) means "whatever `inhibited` says", which is right for a
         * caller with nowhere else to put it (`YonderDeck`'s own aim block
         * draws a heading and this pad and nothing else).
         *
         * A caller whose own head already states that same fact passes `''`
         * instead, and the pad stays refused and says nothing:
         * `YonderAim.vue` does, because it drew the identical sentence twice —
         * once under its legend and once under this dial — which is the half
         * of K-63 an operator reads as being told one thing twice.
         * The suppression is structural, decided by *which* panel owns the
         * sentence, and deliberately never a runtime comparison of the two
         * strings: two sentences that happen to match today are not the same
         * fact, and one that stopped matching would silently start drawing
         * twice again.
         */
        note: { type: String, default: null }
    },
    emits: ['slew', 'stop'],
    data: () => ({
        gesture: null,
        seq: 0,
        px: CENTER,
        py: CENTER,
        pointerId: null,
        DIAL_SIZE
    }),
    computed: {
        /** A gesture is active exactly while the pointer is outside the
         * dead zone — not merely while it is physically held, so the puck
         * sits at rest even under a finger resting at dead centre. */
        pushing () {
            return this.gesture !== null
        },
        /** Fails closed: an `axes` object that omits `roll` entirely reads
         * as struck, not present (see the component's own doc comment). */
        rollStruck () {
            return this.axes?.roll !== 'present'
        },
        limited () {
            return Boolean(this.atLimit?.pitch || this.atLimit?.yaw)
        },
        /** The sentence drawn beneath the dial. See `note`'s own comment: an
         * unset `note` falls back to the inhibition's own words, `''` draws
         * nothing at all, and neither changes what the guard does. */
        saying () {
            return this.note === null ? (this.inhibited || '') : this.note
        }
    },
    watch: {
        /** R-CMD-04: an inhibition that arrives mid-gesture stops the
         * aircraft immediately, not on the operator's next release. */
        inhibited (now) {
            if (now) this.endGesture()
        }
    },
    mounted () {
        this.onBlur = () => this.onEnd()
        this.onVisibility = () => { if (document.hidden) this.onEnd() }
        this.onPageHide = () => this.onEnd()
        window.addEventListener('blur', this.onBlur)
        document.addEventListener('visibilitychange', this.onVisibility)
        window.addEventListener('pagehide', this.onPageHide)
    },
    beforeUnmount () {
        window.removeEventListener('blur', this.onBlur)
        document.removeEventListener('visibilitychange', this.onVisibility)
        window.removeEventListener('pagehide', this.onPageHide)
        // A component torn down mid-hold must still stop the aircraft —
        // navigating away from the page is not a reason to keep slewing.
        this.onEnd()
    },
    methods: {
        /** A pointer event's client coordinates, converted to this pad's
         * own geometry. `null` inside the dead zone. See `DIAL_SIZE`'s own
         * comment for why the size used here is that constant and never a
         * measurement of the dial. */
        at (e) {
            const rect = this.$refs.dial.getBoundingClientRect()
            const x = ((e.clientX - rect.left) / DIAL_SIZE) * VIEWBOX - CENTER
            const y = ((e.clientY - rect.top) / DIAL_SIZE) * VIEWBOX - CENTER
            const d = Math.hypot(x, y)
            if (d <= DEAD) return null
            const k = Math.min(1, (d - DEAD) / (RIM - DEAD))
            const ux = x / d
            const uy = y / d
            return {
                x: CENTER + ux * Math.min(d, RIM),
                y: CENTER + uy * Math.min(d, RIM),
                // Screen y grows downward; tilt does not, hence the sign flip.
                panRate: ux * k * MAX_RATE,
                tiltRate: -uy * k * MAX_RATE
            }
        },
        down (e) {
            // Inhibited: nothing happens at all, not even capture (resolution 6).
            if (this.inhibited) return
            // A second, concurrent pointer is ignored outright — this pad
            // tracks one active gesture at a time, and letting a second
            // pointerdown overwrite `pointerId` would orphan the first
            // pointer's own eventual release.
            if (this.pointerId !== null) return
            this.pointerId = e.pointerId
            this.$refs.dial.setPointerCapture?.(e.pointerId)
            this.updateFromEvent(e)
        },
        move (e) {
            if (this.pointerId === null) return
            if (e.pointerId !== undefined && e.pointerId !== this.pointerId) return
            this.updateFromEvent(e)
        },
        /** The one place a pointer event becomes a slew or a stop. Reached
         * from both `down()` and `move()` — see the component's own doc
         * comment on why `inhibited` is checked here too, not only in
         * `down()`. */
        updateFromEvent (e) {
            if (this.inhibited) { this.endGesture(); return }
            const a = this.at(e)
            if (!a) { this.endGesture(); return }
            if (this.gesture === null) this.gesture = newGestureId()
            this.px = a.x
            this.py = a.y
            this.seq += 1
            this.$emit('slew', { pan: a.panRate, tilt: a.tiltRate, seq: this.seq, gesture: this.gesture })
        },
        /** Ends the active gesture, if there is one — idempotent, and the
         * single place that idempotency lives (see the component's own doc
         * comment on why `onEnd()` does not duplicate this check). Resets
         * the puck to centre unconditionally, which is harmless when it is
         * already there. */
        endGesture () {
            this.px = CENTER
            this.py = CENTER
            if (this.gesture === null) return
            const g = this.gesture
            this.gesture = null
            this.$emit('stop', { gesture: g })
        },
        /** Every one of the eight endings reaches here — the four pointer
         * events bound in the template, and the three window/document
         * listeners `mounted()` attaches. No `pointerId` guard of its own:
         * one was written, then mutation-tested and found provably
         * redundant with `endGesture()`'s own `gesture === null` check for
         * every state this component can reach (removing it left all 37 of
         * `aimpad.component.test.ts`'s tests green, "emits nothing at all
         * when nothing was ever pressed" included) — exactly the shape of
         * defect the shutter task's own mutation testing found two tasks
         * ago, a pair of protections where neither was individually
         * load-bearing. Resetting `pointerId` unconditionally is still
         * real work, not a guard: it is what lets a later, genuinely new
         * press through `down()`'s own re-entrancy guard. */
        onEnd () {
            this.pointerId = null
            this.endGesture()
        }
    }
}
</script>

<style scoped>
.y-aim {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-aim__dial {
    cursor: grab;
    touch-action: none;
}
.y-aim__dial.is-pushing { cursor: grabbing; }
.y-aim__dial.is-inhibited { cursor: not-allowed; }

.y-aim__ring { fill: none; stroke: var(--yonder-divider, #2b333c); stroke-width: 1; }
.y-aim__cross { stroke: var(--yonder-divider, #2b333c); stroke-width: 1; fill: none; }
.y-aim__labels { fill: var(--yonder-label, #7f8a95); }

/* An axis that will not answer stays on the pad, struck through — never
   hidden (coordinator resolution 7; the struck-axis treatment is his). */
.y-aim__struck-arc {
    fill: none;
    stroke: var(--yonder-waiting, #ffcf28);
    stroke-opacity: .5;
    stroke-width: 2.5;
    stroke-dasharray: 3 4;
}
.y-aim__struck-label { fill: var(--yonder-waiting, #ffcf28); }

.y-aim__puck-halo {
    fill: none;
    stroke: var(--yonder-select, #2ad4f0);
    stroke-width: 1;
    stroke-dasharray: 2.5 2.5;
}
.y-aim__puck-core {
    fill: var(--yonder-select, #2ad4f0);
    stroke: var(--yonder-display, #04060a);
    stroke-width: 1.5;
}

.y-aim__limit {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    letter-spacing: .12em;
    text-transform: uppercase;
    padding: 3px 7px;
    border-radius: 2px;
    border: 1px solid var(--yonder-waiting, #ffcf28);
    color: var(--yonder-waiting, #ffcf28);
}
.y-aim__limit-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--yonder-waiting, #ffcf28);
    display: inline-block;
}

/* Not a fault (R-UI-21's own reasoning, applied to a general inhibition
   rather than a specific gate) — the neutral tone, the same one
   YonderPositionGauge's own dead-axis reason and every gated control in
   this library already use for "not available right now, not broken". */
.y-aim__reason {
    font-size: 11px;
    line-height: 1.4;
    max-width: 200px;
    color: var(--yonder-neutral, #7d7869);
}
</style>
