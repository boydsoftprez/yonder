<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-gauge" :class="'tone-' + r.tone">
        <span class="y-gauge__label">{{ props.label }}</span>

        <span class="y-gauge__track" :style="{ width: props.track + 'px' }">
            <i class="y-gauge__fill" :style="{ width: pct(r.fraction) }" />
            <i v-if="known" class="y-gauge__ptr" :style="{ left: pct(r.fraction) }" />
            <i v-if="r.limitAt !== undefined" class="y-gauge__redline" :style="{ left: pct(r.limitAt) }" />
            <span class="y-gauge__bands" aria-hidden="true">
                <i class="band good" :style="bandStyle(0, r.cautionAt ?? r.limitAt ?? 1)" />
                <i v-if="r.cautionAt !== undefined" class="band waiting"
                   :style="bandStyle(r.cautionAt, r.limitAt ?? 1)" />
                <i v-if="r.limitAt !== undefined" class="band bad" :style="bandStyle(r.limitAt, 1)" />
            </span>
        </span>

        <span class="y-gauge__value">
            <template v-if="known">{{ shown }}</template><template v-else>&mdash;&mdash;</template>
            <i v-if="props.unit">{{ props.unit }}</i>
        </span>
    </div>
</template>

<script>
import { mapState } from 'vuex'
import { reading } from 'yonder-core/presentation'

/**
 * The engine bar (R-UI-09, ADR-0009).
 *
 * Draws what it is told and decides nothing. Which band a value falls into is
 * `reading()`'s answer, imported from `yonder-core` and tested there, so a
 * threshold means the same on this component, in a node, and anywhere else it
 * is asked — one rule rather than one per surface.
 *
 * The track has a fixed width and never stretches to its column. That is the
 * single layout rule this object exists to keep: a bar that fills its
 * container is the slab this design language replaced.
 */
export default {
    name: 'YonderGauge',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        ...mapState('data', ['messages']),
        value () {
            const payload = this.messages?.[this.id]?.payload
            return typeof payload === 'number' ? payload : Number(payload)
        },
        r () {
            return reading(this.value, {
                min: this.props.min ?? 0,
                max: this.props.max ?? 100,
                caution: this.props.caution,
                limit: this.props.limit
            })
        },
        /** A value we do not have is drawn as absent, never as zero (R-UI-05). */
        known () {
            return Number.isFinite(this.r.value)
        },
        shown () {
            const places = Number.isFinite(this.props.precision) ? this.props.precision : 1
            return this.r.value.toFixed(places)
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        pct (fraction) {
            return (fraction * 100) + '%'
        },
        bandStyle (from, to) {
            return { left: this.pct(from), width: this.pct(Math.max(0, to - from)) }
        }
    }
}
</script>

<style scoped>
.y-gauge {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 8px;
    /* Tall enough for the band strip that hangs below the track. */
    min-height: 26px;
    font-family: var(--yonder-font);
}

.y-gauge__label {
    font-family: var(--yonder-font-mono);
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    text-align: right;
    white-space: nowrap;
}

/* Fixed width, set from the node's configuration. See the note above. */
.y-gauge__track {
    position: relative;
    height: 10px;
    flex: none;
    background: var(--yonder-track, #161b21);
    border: 1px solid var(--yonder-divider, #2b333c);
}

.y-gauge__fill { position: absolute; inset: 0 auto 0 0; display: block; }
.tone-good .y-gauge__fill { background: var(--yonder-good, #35d06a); }
.tone-waiting .y-gauge__fill { background: var(--yonder-waiting, #ffcf28); }
.tone-bad .y-gauge__fill { background: var(--yonder-bad, #ff4034); }
.tone-neutral .y-gauge__fill { background: var(--yonder-neutral, #7d7869); }

/* The bands sit under the track rather than washing across it: a colour laid
   over the fill turns both to mud, which is legible as neither. */
.y-gauge__bands { position: absolute; left: 0; right: 0; bottom: -5px; height: 3px; }
.y-gauge__bands .band { position: absolute; top: 0; bottom: 0; display: block; }
.y-gauge__bands .good { background: var(--yonder-good, #35d06a); }
.y-gauge__bands .waiting { background: var(--yonder-waiting, #ffcf28); }
.y-gauge__bands .bad { background: var(--yonder-bad, #ff4034); }

.y-gauge__ptr {
    position: absolute;
    top: -3px;
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 6px solid var(--yonder-value, #fff);
    transform: translateX(-4px);
    filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.9));
}

.y-gauge__redline {
    position: absolute;
    top: -2px;
    height: 14px;
    width: 2px;
    background: var(--yonder-bad, #ff4034);
}

.y-gauge__value {
    font-family: var(--yonder-font-mono);
    font-size: 0.8125rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
    min-width: 4.5em;
    color: var(--yonder-value, #fff);
}
.tone-waiting .y-gauge__value { color: var(--yonder-waiting, #ffcf28); }
.tone-bad .y-gauge__value { color: var(--yonder-bad, #ff4034); }
.tone-good .y-gauge__value { color: var(--yonder-good, #35d06a); }
.tone-neutral .y-gauge__value { color: var(--yonder-label, #7f8a95); }

.y-gauge__value i {
    font-style: normal;
    font-size: 0.5625rem;
    color: var(--yonder-label, #7f8a95);
    margin-left: 2px;
}
</style>
