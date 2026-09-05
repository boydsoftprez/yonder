<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-pg" :class="{ 'is-dead': dead }">
        <div class="y-pg__top">
            <span v-if="label" class="y-pg__label">{{ label }}</span>
            <span class="y-pg__val">{{ shown }}<template v-if="!dead && unit">{{ ' ' }}<i class="y-pg__u">{{ unit }}</i></template></span>
        </div>
        <div class="y-pg__trk" :style="{ width: TRACK_WIDTH + 'px' }">
            <i v-if="showZero" class="y-pg__zero" :style="{ left: pxAt(0) }" />
            <i v-if="!dead" class="y-pg__ptr" :style="{ left: pxAt(value) }" />
        </div>
        <div class="y-pg__bounds">
            <span>{{ boundText(min) }}</span>
            <span>{{ boundText(max) }}</span>
        </div>
        <div v-if="dead && reason" class="y-pg__reason">{{ reason }}</div>
    </div>
</template>

<script>
/**
 * Pan or tilt against its bounds (R-UI-09) — the "reported position" rows
 * from the blueprint's `DraftAimDial.vue`
 * (`docs/console/design/instrument-library/gallery/`), pulled out into
 * their own reusable part so the aim pad (Task 20) composes one of these
 * per axis rather than a template that draws the row twice inline.
 *
 * **The pointer sits at `(value - min) / (max - min)` of the track — the
 * coordinator's own resolution, verbatim — and the track is a fixed width,
 * never stretched to its column** (R-UI-08, ADR-0009), the same rule
 * `YonderGauge` and `YonderSetBar` already hold for their own tracks.
 *
 * **`jsdom` measures nothing, so the geometry has to come from a constant
 * the component also renders from — exactly as `YonderSetBar` and
 * `YonderGauge` do, and for the identical reason.** `YonderSetBar`'s own
 * `TRACK_WIDTH` comment explains it at length: `getBoundingClientRect()`
 * returns a real `DOMRect` under `jsdom`, with `width` reading zero, so a
 * component that measured its own track before positioning anything on it
 * would place every mark at fraction 0 under test and nobody would notice,
 * because the arithmetic never runs against a real number. This part has
 * no drag and no click — nothing ever converts a pixel coordinate back
 * into a value, so the *reverse* half of that trap (the half `YonderSetBar`
 * actually has to guard against) does not apply here at all — but the
 * *forward* direction still matters for the same reason `YonderGauge`'s
 * own track does: the rendered width has to be one number, used both for
 * the track's own `:style` and for the pointer's `left`, so the two can
 * never drift apart, and so a test can assert the pointer's exact pixel
 * position against that same constant instead of re-measuring a track that
 * `jsdom` cannot lay out.
 *
 * **A dead axis reads a single em dash, not a number, and draws no
 * pointer** — the coordinator's own resolution, verbatim, other half.
 * Deliberately *one* dash, not `YonderSetBar`'s own double `——`: that
 * component's double dash is its own convention for "a device reading this
 * bar could otherwise show, temporarily withheld" (its `gated` state);
 * this one is a single, plain "no number" for an axis that answers with no
 * reading whatsoever, not a case that could be confused with it. The tone
 * is the same neutral this library already uses for "not a fault, not
 * available right now" (`YonderPicker`, `YonderSegmented`, `YonderSetBar`
 * all reach for `--yonder-neutral` in their own `gated` state, coordinator
 * resolution 8) rather than the caution tone — an axis this component is
 * simply not told an answer for is not automatically a fault, and the
 * caller who *does* know why (§7's own "no answer on the third axis")
 * supplies `reason` to say so.
 *
 * **The zero mark is a reference tick, not a claim about the reading**: it
 * draws whenever the bounds actually straddle zero (pan and tilt both do;
 * a hypothetical axis that does not is not asked to fake one), at its own
 * fraction of the track rather than a hardcoded midpoint — the blueprint's
 * own dial fixed it at 50%, which only happens to be correct because pan
 * and tilt are both symmetric ranges, and a generic part reused for a
 * range that is not would draw it in the wrong place if it kept that
 * shortcut.
 */
const TRACK_WIDTH = 96

export default {
    name: 'YonderPositionGauge',
    props: {
        label: { type: String, default: '' },
        value: { type: Number, default: 0 },
        min: { type: Number, default: -180 },
        max: { type: Number, default: 180 },
        unit: { type: String, default: '' },
        precision: { type: Number, default: 1 },
        /** True when this axis answers with no reading at all (§7). */
        dead: { type: Boolean, default: false },
        reason: { type: String, default: '' }
    },
    data: () => ({ TRACK_WIDTH }),
    computed: {
        span () {
            return this.max - this.min
        },
        showZero () {
            return this.span > 0 && this.min <= 0 && this.max >= 0
        },
        shown () {
            if (this.dead) return '—'
            const p = Number.isFinite(this.precision) ? this.precision : 1
            return this.value.toFixed(p)
        }
    },
    methods: {
        /** A value's fraction of the track, clamped — bounds beneath, never
         * a pointer drawn past them. */
        fraction (v) {
            if (this.span <= 0) return 0
            return Math.max(0, Math.min(1, (v - this.min) / this.span))
        },
        /** The one place a fraction becomes a pixel — always against
         * `TRACK_WIDTH`, the same constant the track's own `:style` uses,
         * never a re-measurement of the rendered element (see this
         * component's own doc comment on why). */
        pxAt (v) {
            return (this.fraction(v) * TRACK_WIDTH) + 'px'
        },
        boundText (v) {
            return this.unit ? `${v}${this.unit}` : String(v)
        }
    }
}
</script>

<style scoped>
.y-pg { font-family: var(--yonder-font, system-ui, sans-serif); margin-bottom: 8px; }
.y-pg__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 3px 0; }
.y-pg__label {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}
.y-pg__val {
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #ffffff);
}
/* A token carrying a unit is never uppercased (CLAUDE.md, project-wide;
   stated first on `YonderReadout`). `°` has no case to speak of, but the
   rule is declared here on principle rather than relying on this
   component's only current caller to never pass one that does. */
.y-pg__u { font-style: normal; font-weight: 400; font-size: 0.85em; text-transform: none; color: var(--yonder-label, #7f8a95); }
.y-pg__trk {
    position: relative;
    height: 6px;
    margin: 5px 0 4px;
    border-radius: 1px;
    background: var(--yonder-track, #161b21);
}
.y-pg__zero { position: absolute; top: -2px; width: 1px; height: 10px; background: var(--yonder-divider, #2b333c); }
.y-pg__ptr { position: absolute; top: -3px; width: 2px; height: 12px; margin-left: -1px; background: var(--yonder-value, #ffffff); }
.y-pg__bounds {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-pg__reason { font-size: 11px; margin-top: 3px; line-height: 1.4; color: var(--yonder-neutral, #7d7869); }
/* Dead: not a fault (R-UI-21's own reasoning, applied to an axis rather
   than a control) — the neutral tone throughout, dashed track, no pointer.
   `.y-pg__val` is reset explicitly rather than left to inherit, the same
   defect `YonderPicker`, `YonderSegmented` and `YonderSetBar` were each
   fixed for in review (coordinator resolution 8): a disabled or dead state
   that keeps a live reading's own colour reads as a working axis with an
   odd dash in it, not as an axis with nothing to report. */
.is-dead .y-pg__trk { background: transparent; border: 1px dashed var(--yonder-divider, #2b333c); }
.is-dead .y-pg__val { color: var(--yonder-neutral, #7d7869); font-weight: 400; }
</style>
