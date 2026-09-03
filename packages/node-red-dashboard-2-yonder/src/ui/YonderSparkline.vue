<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-spark" :style="{ height: props.chartHeight + 'px' }">
        <span v-if="props.label" class="y-spark__label">{{ props.label }}</span>

        <span class="y-spark__chart">
            <svg v-if="known" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline class="rx" :points="rxPoints" />
                <polyline class="tx" :points="txPoints" />
                <circle class="rx" :cx="lastX" :cy="rxLastY" r="2.6" />
                <circle class="tx" :cx="lastX" :cy="txLastY" r="2.6" />
            </svg>
            <span v-else class="y-spark__empty">not enough data yet</span>
        </span>

        <span class="y-spark__key">
            <span class="rx"><i />RX</span>
            <span class="tx"><i />TX</span>
        </span>
    </div>
</template>

<script>

/**
 * The sparkline (R-NET-10, R-UI-13).
 *
 * Two lines, receive and transmit, over the sampler's own rolling window —
 * drawn as an inline SVG `<polyline>` rather than a chart library or a
 * raster image, so it scales to any display and follows the palette the way
 * every other instrument in this set does (R-UI-13).
 *
 * **Distinguishable without colour alone.** RX is solid, TX is dashed
 * (`stroke-dasharray` in the stylesheet below); colour is a second cue on
 * top of that, not the only one. A legend beneath the chart repeats both
 * cues at a glance, and a dot at the current end of each line does the same
 * job the tape's bug does — marking *now* on a trace that otherwise only
 * shows history.
 *
 * **Degrades honestly.** A single reading has no shape — a line through one
 * point is a point, and a line drawn through it and nothing else would claim
 * a trend that was never measured. Fewer than two points draws nothing and
 * says so, the same rule `known` enforces on a gauge or a tape for a value
 * that has not arrived yet.
 *
 * The vertical scale is shared between RX and TX rather than each getting
 * its own: they are the same unit, and a shared scale is what makes "which
 * direction is busier" a fact the shape of the chart can answer.
 *
 * `props.chartHeight`, never `props.height` — see `sparkline.ts`. Dashboard
 * reads `.height` off this same config object as the widget's *grid row
 * count*, so a prop by that name is not read here, it is overwritten there.
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
    name: 'YonderSparkline',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        series () {
            const payload = this.$store?.state?.data?.messages?.[this.id]?.payload
            const series = payload && typeof payload === 'object' ? payload.series : null
            const rx = Array.isArray(series?.rx) ? series.rx.filter((n) => typeof n === 'number' && Number.isFinite(n)) : []
            const tx = Array.isArray(series?.tx) ? series.tx.filter((n) => typeof n === 'number' && Number.isFinite(n)) : []
            // Both series come from the same sampler history and are always
            // the same length; the shorter length is used defensively so one
            // malformed array cannot draw the other past its own end.
            const count = Math.min(rx.length, tx.length)
            return { rx: rx.slice(0, count), tx: tx.slice(0, count) }
        },
        /** A single reading has no shape, so it draws as absent rather than a point or a flat line. */
        known () {
            return this.series.rx.length >= 2
        },
        scaleMax () {
            const all = this.series.rx.concat(this.series.tx)
            const peak = all.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
            // A floor of 1 rather than 0: every reading is then plotted at
            // the baseline instead of dividing by zero, which is the honest
            // picture when the link has truly carried nothing.
            return peak > 0 ? peak : 1
        },
        lastX () {
            return this.known ? 300 : 0
        },
        rxLastY () {
            return this.yFor(this.series.rx[this.series.rx.length - 1])
        },
        txLastY () {
            return this.yFor(this.series.tx[this.series.tx.length - 1])
        },
        rxPoints () {
            return this.pointsFor(this.series.rx)
        },
        txPoints () {
            return this.pointsFor(this.series.tx)
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        /** Chart-area y for a value, inverted: SVG y grows downward and a rate does not. */
        yFor (value) {
            const top = 8
            const bottom = 92
            const fraction = Math.max(0, Math.min(1, value / this.scaleMax))
            return bottom - fraction * (bottom - top)
        },
        pointsFor (values) {
            const last = values.length - 1
            return values.map((v, i) => `${last === 0 ? 0 : (i / last) * 300},${this.yFor(v)}`).join(' ')
        }
    }
}
</script>

<style scoped>
.y-spark {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--yonder-font);
}

.y-spark * { box-sizing: border-box; }

.y-spark__label {
    flex: none;
    font-family: var(--yonder-font-mono);
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    white-space: nowrap;
}

.y-spark__chart {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    background: var(--yonder-pane, #090d12);
    border: 1px solid var(--yonder-divider, #2b333c);
}

.y-spark__chart svg {
    display: block;
    width: 100%;
    height: 100%;
}

/* RX solid, TX dashed - the two are distinguishable with colour turned off. */
polyline {
    fill: none;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
}
polyline.rx { stroke: var(--yonder-value, #fff); }
polyline.tx { stroke: var(--yonder-select, #2ad4f0); stroke-dasharray: 5 4; }

circle.rx { fill: var(--yonder-value, #fff); }
circle.tx { fill: var(--yonder-select, #2ad4f0); }

.y-spark__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-family: var(--yonder-font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    color: var(--yonder-label, #7f8a95);
}

/*
 * One row, not two stacked - a legend that only ever needs one line's worth
 * of height fits any configured chart height without the arithmetic of
 * stacked line boxes, which is not a height this file can promise: a real
 * font's line-height is the browser's number, not this stylesheet's.
 */
.y-spark__key {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    font-family: var(--yonder-font-mono);
    font-size: 0.5625rem;
    line-height: 1;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--yonder-label, #7f8a95);
}

.y-spark__key span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }

.y-spark__key i { display: inline-block; width: 12px; height: 0; border-top-width: 2px; border-top-style: solid; }
.y-spark__key .rx i { border-top-color: var(--yonder-value, #fff); }
.y-spark__key .tx i { border-top-color: var(--yonder-select, #2ad4f0); border-top-style: dashed; }
</style>
