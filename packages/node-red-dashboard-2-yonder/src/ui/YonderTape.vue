<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-tape" :class="'tone-' + r.tone" :style="{ height: props.height + 'px' }">
        <span class="y-tape__scale">
            <i class="y-tape__fill" :style="{ height: pct(r.fraction) }" />
            <i v-for="tick in ticks" :key="'t' + tick" class="y-tape__tick" :style="{ top: pct(1 - tick) }" />
            <i v-if="r.cautionAt !== undefined" class="y-tape__mark caution" :style="{ top: pct(1 - r.cautionAt) }" />
            <i v-if="r.limitAt !== undefined" class="y-tape__mark limit" :style="{ top: pct(1 - r.limitAt) }" />
        </span>

        <template v-if="known">
            <i class="y-tape__bug" :style="{ top: pct(1 - r.fraction) }" />
            <span class="y-tape__box" :style="{ top: pct(1 - r.fraction) }">{{ shown }}</span>
        </template>

        <span class="y-tape__key">
            <span v-for="mark in marks" :key="mark.at" :class="mark.kind" :style="{ top: pct(1 - mark.at) }">
                {{ mark.text }}
            </span>
        </span>
    </div>
</template>

<script>
import { reading } from 'yonder-core/presentation'

/**
 * The tape (R-UI-09, ADR-0009).
 *
 * A vertical scale with a fill, a bug at the current value and a boxed
 * reading. The same `Reading` a gauge draws, in the idiom for a quantity that
 * is watched rather than read once — chosen by what the data is, not by taste.
 *
 * Everything is measured from the bottom, because a scale is: `top` is
 * `1 - fraction` throughout, and that inversion lives here rather than in
 * `reading()`, which describes a value and not a direction.
 */
/**
 * The store is reached through `$store`, not through vuex's `mapState`.
 *
 * `vuex` has to be external — bundling it would give these components a second
 * store, and they would read an empty one on a page where everything else
 * worked. But Dashboard does not put a `Vuex` global on the page either, so a
 * UMD external for it resolves to `undefined` and the first property access
 * throws before anything renders. Dashboard *does* install the store as
 * `$store`, which is the supported way in, needs no import, and cannot become
 * a second copy of anything.
 */
export default {
    name: 'YonderTape',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        value () {
            const payload = this.$store?.state?.data?.messages?.[this.id]?.payload
            if (typeof payload === 'number') return payload
            // `Number(null)` is 0 and `Number('')` is 0, and 0 is a perfectly
            // good reading — so a board with no thermal sensor drew 0.0 °C,
            // which says "cold" rather than "not there". facts.ts is explicit
            // that absent is null and never zero; this is the other end of
            // that rule, and it was wrong here until a capture showed it.
            if (payload === null || payload === undefined || payload === '') return Number.NaN
            return Number(payload)
        },
        r () {
            return reading(this.value, {
                min: this.props.min ?? 0,
                max: this.props.max ?? 100,
                caution: this.props.caution,
                limit: this.props.limit
            })
        },
        known () {
            return Number.isFinite(this.r.value)
        },
        shown () {
            const places = Number.isFinite(this.props.precision) ? this.props.precision : 1
            return this.r.value.toFixed(places)
        },
        /** Evenly spaced divisions, as fractions of the scale. */
        ticks () {
            const n = Math.max(2, Math.min(12, this.props.divisions ?? 5))
            return Array.from({ length: n + 1 }, (_, i) => i / n)
        },
        /**
         * The labels beside the scale: the ceiling, then whichever bands are
         * configured. A band nobody set gets no label rather than a zero, for
         * the same reason `reading()` calls such a value neutral.
         */
        marks () {
            const out = [{ at: 1, text: this.top, kind: 'plain' }]
            if (this.r.limitAt !== undefined) {
                out.push({ at: this.r.limitAt, text: this.limitText, kind: 'limit' })
            }
            if (this.r.cautionAt !== undefined) {
                out.push({ at: this.r.cautionAt, text: this.r.caution + ' CAUTION', kind: 'caution' })
            }
            out.push({ at: 0, text: (this.props.min ?? 0) + ' ' + (this.props.unit ?? ''), kind: 'plain' })
            return out
        },
        top () {
            return (this.props.max ?? 100) + ' MAX'
        },
        limitText () {
            return this.r.limit + ' ' + (this.props.limitLabel || 'LIMIT')
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        pct (fraction) {
            return (fraction * 100) + '%'
        }
    }
}
</script>

<style scoped>
.y-tape {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 8px;
    font-family: var(--yonder-font);
}

.y-tape__scale {
    position: relative;
    width: 20px;
    flex: none;
    background: var(--yonder-pane, #090d12);
    border: 1px solid var(--yonder-divider, #2b333c);
    overflow: hidden;
}

.y-tape__fill { position: absolute; left: 0; right: 0; bottom: 0; display: block; }
.tone-good .y-tape__fill { background: var(--yonder-good, #35d06a); }
.tone-waiting .y-tape__fill { background: var(--yonder-waiting, #ffcf28); }
.tone-bad .y-tape__fill { background: var(--yonder-bad, #ff4034); }
.tone-neutral .y-tape__fill { background: var(--yonder-neutral, #7d7869); }

.y-tape__tick { position: absolute; left: 0; width: 6px; height: 1px; background: var(--yonder-label, #7f8a95); }
.y-tape__mark { position: absolute; left: 0; right: 0; display: block; }
.y-tape__mark.caution { height: 1px; background: var(--yonder-waiting, #ffcf28); }
.y-tape__mark.limit { height: 2px; background: var(--yonder-bad, #ff4034); }

.y-tape__bug {
    position: absolute;
    left: 0;
    width: 20px;
    height: 2px;
    background: var(--yonder-select, #2ad4f0);
    z-index: 1;
}

.y-tape__box {
    position: absolute;
    left: 26px;
    transform: translateY(-50%);
    background: #000;
    border: 1px solid var(--yonder-select, #2ad4f0);
    padding: 2px 7px;
    font-family: var(--yonder-font-mono);
    font-size: 0.9375rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #fff);
    white-space: nowrap;
    z-index: 2;
}

/* A pointer at the box, so the reading is tied to its place on the scale. */
.y-tape__box::before {
    content: "";
    position: absolute;
    left: -6px;
    top: 50%;
    transform: translateY(-50%);
    width: 0;
    height: 0;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 6px solid var(--yonder-select, #2ad4f0);
}

.y-tape__key { position: relative; flex: 1; min-width: 74px; margin-left: 64px; }

.y-tape__key span {
    position: absolute;
    left: 0;
    transform: translateY(-50%);
    font-family: var(--yonder-font-mono);
    font-size: 0.5rem;
    letter-spacing: 0.12em;
    white-space: nowrap;
    color: var(--yonder-label, #7f8a95);
}
.y-tape__key .caution { color: var(--yonder-waiting, #ffcf28); }
.y-tape__key .limit { color: var(--yonder-bad, #ff4034); }
</style>
