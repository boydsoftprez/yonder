<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div v-if="state !== 'not-offered'" class="y-sb" :class="['is-' + state, { 'is-readonly': readonly }]">
        <div class="y-sb__top">
            <span v-if="label" class="y-sb__label">{{ label }}</span>
            <span class="y-sb__val">{{ shown }}<template v-if="unit">{{ ' ' }}<i class="y-sb__u">{{ unit }}</i></template></span>
        </div>
        <div ref="trk" class="y-sb__trk" :style="{ width: TRACK_WIDTH + 'px' }"
             @pointerdown="down" @pointermove="move" @pointerup="up"
             @pointercancel="up" @pointerleave="up">
            <i v-if="showActual" class="y-sb__act" :style="{ left: pct(actual) }" />
            <i v-if="showCommanded" class="y-sb__cmd" :style="{ left: pct(commanded) }" />
            <i v-if="grabAt !== null" class="y-sb__req" data-grab
               :aria-label="grabAriaLabel" :style="{ left: pct(grabAt) }" />
        </div>
        <div v-if="fine" class="y-sb__fine">{{ fine }}</div>
        <div v-if="hasRequested" class="y-sb__note">Staged change</div>
        <div v-if="reason" class="y-sb__why" :class="toneClass">{{ reason }}</div>
    </div>
</template>

<script>
/**
 * A bounded continuous value an operator drags to choose — bitrate, shutter
 * time, gain — in all four capability states (R-CTL-11 … R-CTL-14, R-CFG-03).
 *
 * Ported from the blueprint's corrected `DraftSetBar.vue`
 * (`docs/console/design/instrument-library/gallery/`, read but not
 * modified, per instruction): the track geometry, the mark shapes and the
 * snap/clamp arithmetic are its own, carried over in spirit. Changed, as
 * `YonderPicker` and `YonderSegmented` already changed from their own
 * drafts: class names (`y-sb*`, not the draft's `d-*`) and the prop name
 * for the pending draft, which this library calls `requested` — the same
 * word the rest of this component's own props use for a value that has been
 * asked for and not yet delivered — where the draft called it `pending`.
 *
 * **Exactly one mark may look draggable, and it is `requested`.** This is
 * the one instrument in the library whose design the operator has already
 * corrected in person: the blueprint's first cut filled the track to the
 * device's own value and closed it with a tick — the shape of a slider —
 * while the pending value was drawn as a hollow ring beside it — the shape
 * of a thumb. Two things that looked grabbable; only one of them was. He
 * read it as two handles inside a minute of using it, and he was reading it
 * fairly. The fix keeps `actual` and `commanded` off the track entirely —
 * they are readings, drawn as carets *below* it, `pointer-events: none`,
 * with no fill standing in for either — and the one thing left sitting on
 * the track, solid, is `requested`. That mark is present whenever the bar
 * is interactive at all, sitting at `requested` once a draft exists and at
 * `actual` before one does, so the bar always has exactly one draggable
 * thing — never none, never two — and a press anywhere always drafts a
 * `requested` value rather than only being able to move one that already
 * exists.
 *
 * **The four states follow `YonderPicker` and `YonderSegmented`, not the
 * blueprint's own untouched draft.** The draft was corrected for the
 * two-handles defect specifically and was never re-audited against the
 * capability-state vocabulary the other two parts already share, so where
 * the two disagreed this file follows the two reviewed parts: `present`
 * works; `not-offered` renders nothing at all (no wrapper — root `v-if`);
 * `advertised` is a fault (R-CTL-11…14) — the control stays, disabled, in
 * the caution tone, carrying the reason, and — because the device's own
 * reading is still real under a fault, unlike under `gated` — the actual
 * and commanded marks still draw, so an operator can see the value stuck at
 * its old setting rather than losing the evidence that would show it;
 * `gated` is not a fault (R-UI-21) — another control has charge, the value
 * is not meaningfully known while it does, so the readout goes to a double
 * em dash and neither reading mark draws, disabled, in the neutral tone,
 * naming the control that has it. The tone is a lookup, not a ternary, for
 * the reason `YonderFacts`, `YonderPicker` and `YonderSegmented` all give
 * for using one: a state this file does not know about yet must not
 * silently draw in whichever tone a ternary happened to fall back to.
 *
 * **`readonly` is not a fifth state — it is orthogonal to all four.** A
 * camera whose bitrate is Adaptive still has a `present` control in every
 * sense that matters to `state` (the capability is real, the device is
 * reachable); what is different is that nothing an operator does with this
 * particular bar would be honoured, because the encoder is steering itself
 * off the measured link (§6, "In Adaptive the bar is a readout, `GOING
 * OUT`"). Folding that into `state: 'gated'` would say another *control*
 * has charge, which is false — nothing has charge, because there is
 * nothing left to charge: the value is a live readout, not a request
 * waiting on a gate to open. So it is its own boolean, and it removes the
 * one draggable mark entirely rather than merely disabling it, for the same
 * reason `gated` and `advertised` never draw a stray handle: a control that
 * cannot act must not go on offering to.
 *
 * **Never wear a control's costume while merely disabled, either** — the
 * defect `YonderPicker` and `YonderSegmented` were each fixed for in review:
 * a disabled state that kept the wash marking a live selection. This
 * component never had that particular wash (there is no persistent
 * "selected" class here the way `.on` is one there), but the analogous
 * risk — a gated or advertised bar whose value text stayed in the live
 * `--yonder-value` white rather than going to its own state's tone — is
 * guarded the same way theirs is: every state that is not `present` resets
 * `.y-sb__val`'s colour explicitly rather than leaving it to inherit.
 */
const TONE_CLASS = {
    advertised: 'why-advertised',
    gated: 'why-gated'
}

/**
 * The track's own width, in pixels — fixed, per §6 ("Fixed width. It never
 * stretches to its column"), and bound into the template from here rather
 * than written a second time as a bare pixel value in `<style>`, exactly the
 * technique `YonderGauge`'s own `:style="{ width: props.track + 'px' }'"`
 * already uses for its track. Sharing that technique is what this file
 * shares with `YonderGauge` — not a literal import, since Gauge's width is
 * a per-node configuration value and this bar's is not, but the same rule:
 * one JS-owned number drives both the rendered pixels and the geometry
 * math, so the two can never drift apart.
 *
 * That sharing is also what answers the coordinator's own resolution 4.
 * `jsdom` performs no layout at all, so `getBoundingClientRect()` on the
 * track returns a real `DOMRect` with every field — `width` very much
 * included — reading zero (confirmed directly against this repository's own
 * jsdom before writing a single test against it). A press converted from
 * `(clientX - rect.left) / rect.width` is therefore `x / 0` under test,
 * which is `Infinity` or `NaN` depending on the numerator, and clamping
 * that into range collapses every press to whichever bound the clamp
 * resolves an out-of-domain number to — the exact "passes only because
 * everything measures zero" failure the brief warns against, and the
 * reason the blueprint's own `from()` (which falls back to fraction 0 when
 * `rect.width <= 0`) would make this component's "clamps to the device's
 * bounds" test read `min` where the test expects `max`.
 *
 * The fix is not to stub `getBoundingClientRect` in every test — that would
 * work, but it would mean this component's real, shipped geometry depends
 * on a DOM measurement this file cannot see fail. Instead the width the
 * math uses is this constant, never `rect.width`, so the conversion is
 * exact under `jsdom` and in a real browser alike; only the track's
 * *position* (`rect.left`) still comes from `getBoundingClientRect()`,
 * because a page position is genuinely a layout fact no constant could
 * stand in for — it reads zero in this project's own jsdom too, which is
 * harmless here since nothing wraps the track in a test and a press at
 * `clientX: 40` is exactly 40px into the track either way.
 */
const TRACK_WIDTH = 220

/**
 * A precise decimal string, where `Number.prototype.toFixed` is not one.
 *
 * `(3.05).toFixed(1)` reads `"3.0"` in every JS engine this project has
 * checked, not `"3.1"` — 3.05 has no exact binary floating-point
 * representation, the nearest double is fractionally *below* 3.05, and
 * `toFixed` rounds the stored bits rather than the decimal an operator
 * typed. This is not a corner this file can leave for later: it is the
 * coordinator's own second worked example for "formats the device's value
 * to its precision", verbatim, so a plain `actual.toFixed(precision)` would
 * fail that test outright, on the coordinator's own number, before any
 * mutation is involved. Nudging by `Number.EPSILON` before rounding to the
 * requested number of decimal places pulls the stored value back onto the
 * side the operator's own decimal intended, and confirmed separately
 * against the classic `(1.005).toFixed(2)` case, which has the identical
 * cause.
 */
function fixed (value, precision) {
    // **The nudge follows the sign, and that is not a detail.** Adding
    // `Number.EPSILON` outright only ever pushes upward, which happens to fix
    // the positive half-boundary cases and silently breaks the negative ones:
    // `(-4.995).toFixed(2)` is already right at `-5.00`, and an unsigned
    // nudge turns it into `-4.99`. Caught in review, which measured it —
    // 268 positive cases corrected and none broken, against 289 negative
    // cases broken and none corrected. Dormant only because nothing shipped
    // draws a negative fraction yet, and this component already takes
    // negative ranges: the gimbal's pan is min -648000. Nudge away from zero.
    const factor = 10 ** precision
    const nudged = value + Math.sign(value) * Number.EPSILON * Math.abs(value || 1)
    return (Math.round(nudged * factor) / factor).toFixed(precision)
}

export default {
    name: 'YonderSetBar',
    props: {
        label: { type: String, default: '' },
        unit: { type: String, default: '' },
        min: { type: Number, default: 0 },
        max: { type: Number, default: 100 },
        step: { type: Number, default: 1 },
        precision: { type: Number, default: 0 },
        /** What the device says it is now. */
        actual: { type: Number, default: 0 },
        /** What was asked for and has not arrived. `null` when they agree. */
        commanded: { type: Number, default: null },
        /** A draft not yet applied (§7). `null` when there is none. */
        requested: { type: Number, default: null },
        state: { type: String, default: 'present' },
        reason: { type: String, default: '' },
        fine: { type: String, default: '' },
        /** Real, reachable, and not settable right now — a live readout
         * rather than a control with nothing charging it (see above). */
        readonly: { type: Boolean, default: false }
    },
    emits: ['set'],
    data: () => ({ dragging: false, captureFailed: false, dragAt: null, TRACK_WIDTH }),
    watch: {
        // Let go of the drag's own position the moment the device answers:
        // holding it after that would draw a value nothing on the board has.
        actual () { this.dragAt = null },
        requested () { this.dragAt = null },
    },
    computed: {
        hasRequested () {
            return this.requested !== null && this.requested !== undefined
        },
        /** Unknown while gated — another control's own reading, not this
         * one's to restate as a number it cannot vouch for. */
        shown () {
            if (this.state === 'gated') return '——'
            return fixed(this.actual, this.precision)
        },
        /** Both readings go dark only under `gated`: the fault state
         * (`advertised`) still has a device answering honestly, and losing
         * the evidence would hide exactly the thing an operator needs to
         * see — the value stuck at its old setting. */
        showActual () {
            return this.state !== 'gated'
        },
        showCommanded () {
            return this.state !== 'gated' && this.commanded !== null && this.commanded !== undefined &&
                Math.abs(this.commanded - this.actual) > this.step / 2
        },
        /**
         * The one grabbable mark. Present only while the bar can act on a
         * press at all — `present` and not `readonly` — and sitting at the
         * requested value once a draft exists, at the device's own actual
         * value otherwise, so this is never absent and never doubled while
         * the bar is interactive.
         */
        /**
         * **Where the mark is drawn, and why the drag's own position wins.**
         *
         * `actual` and `requested` both come from outside: a press is sent to
         * the device, the device answers, and the answer comes back as a prop.
         * Drawn from those alone the mark cannot move until that round trip
         * completes — over a mesh link that is a visible lag on every pixel of
         * a drag, and what it reads as is a control that ignores you. The
         * operator's words for it were *I can't move it at all*.
         *
         * So while a drag is in flight the mark is drawn where the pointer is,
         * and `dragAt` is let go the moment a fresh value arrives from the
         * device — which is the only thing that should be trusted once it has.
         */
        grabAt () {
            if (this.state !== 'present' || this.readonly) return null
            if (this.dragAt !== null) return this.dragAt
            return this.hasRequested ? this.requested : this.actual
        },
        grabAriaLabel () {
            const lead = this.label ? this.label + ', ' : ''
            return this.hasRequested ? `${lead}requested value` : `${lead}set value`
        },
        toneClass () {
            return TONE_CLASS[this.state] || ''
        }
    },
    methods: {
        pct (v) {
            if (v === null || v === undefined) return '0%'
            const span = this.max - this.min
            if (span <= 0) return '0%'
            const f = Math.max(0, Math.min(1, (v - this.min) / span))
            return (f * 100) + '%'
        },
        /** A press or drag position, converted to a snapped, clamped value.
         * See `TRACK_WIDTH`'s own comment for why the width used here is
         * that constant and never a measurement of the track itself. */
        from (e) {
            const left = this.$refs.trk.getBoundingClientRect().left
            const f = Math.max(0, Math.min(1, (e.clientX - left) / TRACK_WIDTH))
            const raw = this.min + f * (this.max - this.min)
            // The device's own step, not a step this file invents — the
            // same rule R-CTL-11…14 already state for the model behind it.
            const snapped = Math.round((raw - this.min) / this.step) * this.step + this.min
            return Math.max(this.min, Math.min(this.max, snapped))
        },
        down (e) {
            if (this.state !== 'present' || this.readonly) return
            this.dragging = true
            this.dragAt = this.from(e)
            /**
             * **The press is emitted whatever pointer capture does.**
             *
             * `setPointerCapture` throws `NotFoundError` for a pointer id the
             * browser no longer considers active, and it threw *before* the
             * emit — so a press that hit that case set nothing at all, and the
             * bar read as a control that would not move. `?.` guards the
             * method being absent, which is the jsdom case; it does not guard
             * the method throwing, which is the browser case, and every test
             * here runs in jsdom.
             *
             * Capture is a convenience — it keeps the drag alive when the
             * pointer leaves the track. Losing it costs a drag that stops at
             * the edge. Losing the press costs the control.
             */
            try {
                this.$refs.trk.setPointerCapture?.(e.pointerId)
            } catch {
                this.captureFailed = true
            }
            this.$emit('set', this.from(e))
        },
        move (e) {
            if (!this.dragging) return
            this.dragAt = this.from(e)
            this.$emit('set', this.dragAt)
        },
        up () {
            this.dragging = false
        }
    }
}
</script>

<style scoped>
.y-sb { margin-bottom: 13px; font-family: var(--yonder-font, system-ui, sans-serif); }
.y-sb__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.y-sb__label {
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}
.y-sb__val {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #ffffff);
}
/* A token carrying a unit is never uppercased: `MB/S` would say megabytes,
   not `Mb/s` (CLAUDE.md, project-wide; `YonderReadout` is where this rule
   is first stated and tested, and it applies here unchanged). Declared
   explicitly rather than trusted to absence, so it wins regardless of what
   an ancestor rule declares. */
.y-sb__u {
    font-style: normal;
    font-weight: 400;
    font-size: 11px;
    text-transform: none;
    color: var(--yonder-label, #7f8a95);
}
/* Width comes from `:style`, bound to the same `TRACK_WIDTH` the pointer
   geometry uses (see that constant's own comment) — never a second, bare
   pixel value here that could quietly drift from it. */
.y-sb__trk {
    position: relative;
    height: 10px;
    margin: 9px 0 4px;
    border-radius: 2px;
    background: var(--yonder-track, #161b21);
    cursor: pointer;
    touch-action: none;
    /* **The press target is bigger than the bar, deliberately.** A
       transparent border grows the hit area to about 232×22 while
       `background-clip` keeps the painted bar at its 220×10, so the thing an
       operator hits is not the thing they see. The blueprint had this and
       dropping it was a silent regression review caught: a notebook is the
       primary surface here but a tablet is a real one, and a 10-pixel-tall
       press target is a miss waiting to happen. `content-box` so the border
       does not eat the width the pointer geometry assumes. */
    border: 6px solid transparent;
    box-sizing: content-box;
    background-clip: padding-box;
}
.y-sb__trk:hover { outline: 1px solid color-mix(in srgb, var(--yonder-select, #2ad4f0) 40%, transparent); }
/* The readings: below the track, `pointer-events: none`, never a filled
   extent from zero — the whole point of this component's own correction.
   `actual` renders in the live value colour; `commanded` in the waiting
   tone, matching what `YonderAnnunciator`'s own vocabulary already uses for
   "asked for and not yet true". */
.y-sb__act {
    position: absolute;
    top: 11px;
    width: 0;
    height: 0;
    margin-left: -4px;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-bottom: 5px solid var(--yonder-value, #ffffff);
    pointer-events: none;
}
.y-sb__cmd {
    position: absolute;
    top: 11px;
    width: 0;
    height: 0;
    margin-left: -5px;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 6px solid var(--yonder-waiting, #ffcf28);
    pointer-events: none;
}
/* The one mark this bar ever lets a press move: solid, on the track, large
   enough to read as a handle beside the carets that are not one. */
.y-sb__req {
    position: absolute;
    top: -3px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    border: 2px solid var(--yonder-display, #04060a);
    background: var(--yonder-select, #2ad4f0);
    pointer-events: none;
    box-shadow: 0 0 0 1px var(--yonder-select, #2ad4f0);
}
.y-sb__note { font-size: 10.5px; margin-top: 4px; color: var(--yonder-select, #2ad4f0); }
.y-sb__fine {
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--yonder-label, #7f8a95);
    font-variant-numeric: tabular-nums;
}
.y-sb__why { font-size: 11px; margin-top: 4px; line-height: 1.4; max-width: 230px; }
.why-advertised { color: var(--yonder-waiting, #ffcf28); }
.why-gated { color: var(--yonder-neutral, #7d7869); }

/* `gated` takes the neutral tone throughout, matching `YonderPicker` and
   `YonderSegmented` rather than the blueprint's own untouched draft (which
   used `--yonder-label` for this) — two parts already agree on
   `--yonder-neutral` for "another control has charge, not a fault", and a
   third one disagreeing is worse than either choice (resolution 6). Value
   colour is reset explicitly here, not left to inherit — the analogue of
   the wash defect both of those parts were fixed for in review. */
.is-gated .y-sb__trk { background: transparent; border: 1px dashed var(--yonder-divider, #2b333c); cursor: not-allowed; pointer-events: none; }
.is-gated .y-sb__trk:hover { outline: none; }
.is-gated .y-sb__val { color: var(--yonder-neutral, #7d7869); font-weight: 400; }

/* `advertised` is a fault, in the caution tone — matching `YonderPicker`'s
   own `is-advertised` rule, which recolours its whole shown value amber
   rather than leaving it white. The device's reading is still real here
   (unlike `gated`), so it stays on the track; only the tone changes, to
   say plainly that the number is stuck rather than that it is unknown. */
.is-advertised .y-sb__trk { background: color-mix(in srgb, var(--yonder-waiting, #ffcf28) 18%, transparent); cursor: not-allowed; pointer-events: none; }
.is-advertised .y-sb__trk:hover { outline: none; }
.is-advertised .y-sb__val { color: var(--yonder-waiting, #ffcf28); }

/* `readonly` is not one of the four states (see the component doc comment)
   and carries no tone of its own — a live readout is not a fault and not
   gated by another control, so the value keeps its ordinary colour. Only
   the track stops inviting a press, the same "not-allowed" cursor the
   other two non-interactive tracks use. */
.is-readonly .y-sb__trk { cursor: not-allowed; pointer-events: none; }
.is-readonly .y-sb__trk:hover { outline: none; }
</style>
