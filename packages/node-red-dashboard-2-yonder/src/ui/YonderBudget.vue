<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-budget">
        <div class="y-budget__head">
            <span class="y-budget__label">{{ props.label }}</span>
            <span class="y-budget__total">{{ mbps(total) }} of {{ mbps(capacity) }} Mb/s</span>
        </div>
        <div class="y-budget__track">
            <div
                v-for="(seg, i) in segments"
                :key="seg.label + i"
                class="y-budget__seg"
                :class="{ over: startsPast(i) }"
                :style="{ width: pct(seg.kbps), left: pct(before(i)) }"
                :title="seg.label + ' — ' + mbps(seg.kbps) + ' Mb/s'"
            ></div>
            <div class="y-budget__mark" :style="{ left: pct(capacity) }"></div>
        </div>
        <div class="y-budget__legend">
            <span v-for="(seg, i) in segments" :key="'l' + i" class="y-budget__key">
                {{ seg.label }} {{ mbps(seg.kbps) }} Mb/s
            </span>
        </div>
    </div>
</template>

<script>
/**
 * What is leaving, against what the path can carry (R-VID-11, R-UI-09).
 *
 * A bounded quantity cannot be a bare figure, so this is one track with a
 * segment per output and a mark at the measured capacity. Anything past the
 * mark is hatched in the fault tone, which is the only drawing of
 * oversubscription an operator can read at a glance.
 *
 * A **readout, not an input.** With a slider you cannot tell whether the bar
 * shows what you asked for or what you are getting.
 */
export default {
    name: 'YonderBudget',
    inject: ['$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    created () { this.$dataTracker(this.id) },
    computed: {
        /**
         * **What arrived, in preference to what was configured.**
         *
         * A track written into the flows would state the bitrates somebody
         * typed there once, and the first operator to change a camera's
         * bitrate or add an output would be reading a picture of the old
         * configuration. `uplinkBudget()` in yonder-core builds these from the
         * configuration in force and the daemon sends them on
         * `payload.budget`; the configured pair stays as the fallback, so the
         * track draws something honest before the first message arrives rather
         * than looking like it failed.
         *
         * Through `$store` rather than vuex's `mapState`, for the reason
         * YonderDataBar records.
         */
        budget () {
            const live = this.$store?.state?.data?.messages?.[this.id]?.payload?.budget
            return live && typeof live === 'object' ? live : {}
        },
        segments () {
            return Array.isArray(this.budget.segments) ? this.budget.segments : (this.props.segments || [])
        },
        capacity () {
            const live = this.budget.capacityKbps
            return typeof live === 'number' ? live : (this.props.capacityKbps || 0)
        },
        total () { return this.segments.reduce((n, s) => n + (s.kbps || 0), 0) },
        // The track is scaled to whichever is larger, so an oversubscribed
        // uplink still fits on screen and the mark moves left instead of the
        // bar running off the end.
        scale () { return Math.max(this.total, this.capacity) || 1 }
    },
    methods: {
        mbps (kbps) { return ((kbps || 0) / 1000).toFixed(1) },
        pct (kbps) { return `${Math.min(100, (100 * (kbps || 0)) / this.scale).toFixed(2)}%` },
        before (i) { return this.segments.slice(0, i).reduce((n, s) => n + (s.kbps || 0), 0) },
        startsPast (i) { return this.before(i) >= (this.capacity || Infinity) }
    }
}
</script>

<style scoped>
.y-budget { font-family: var(--yonder-font, system-ui, sans-serif); }
.y-budget__head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.y-budget__label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--yonder-label, #7f8a95); }
/* Never uppercased: Mb/s rendered as MB/S says megabytes. */
.y-budget__total { font-family: var(--yonder-font-mono, ui-monospace, monospace); font-size: 12px; text-transform: none; color: var(--yonder-value, #fff); }
.y-budget__track {
    position: relative; height: 14px;
    /* ADR-0009: a track has a fixed maximum and never stretches to fill. */
    max-width: 420px;
    background: var(--yonder-track, #161b21);
    border: 1px solid var(--yonder-divider, #2b333c);
}
.y-budget__seg { position: absolute; top: 0; bottom: 0; background: var(--yonder-select, #2ad4f0); opacity: 0.75; border-right: 1px solid var(--yonder-display, #04060a); }
.y-budget__seg.over {
    background: repeating-linear-gradient(45deg,
        var(--yonder-bad, #ff4034) 0 5px, transparent 5px 10px);
}
.y-budget__mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--yonder-value, #fff); }
.y-budget__legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; font-family: var(--yonder-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--yonder-label, #7f8a95); text-transform: none; }
</style>
