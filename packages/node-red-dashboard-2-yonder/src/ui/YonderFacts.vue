<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-facts">
        <div v-if="props.title" class="y-facts__title">{{ props.title }}</div>
        <div v-for="fact in props.facts" :key="fact.label" class="y-facts__row" :class="'is-' + fact.state">
            <span class="y-facts__label">{{ fact.label }}</span>
            <span class="y-facts__state">{{ fact.state === 'advertised' ? 'not answering' : 'this camera has none' }}</span>
            <span v-if="fact.reason" class="y-facts__reason">{{ fact.reason }}</span>
        </div>
    </div>
</template>

<script>
/**
 * What this camera cannot do, stated where the control would have been
 * (R-UI-15).
 *
 * **The two states look different, and that is the whole component.**
 * `not-offered` is a fact in the neutral tone — the camera does not have it,
 * nothing is wrong, and the row exists only so nobody goes looking.
 * `advertised` is a *fault* in the caution tone, carrying its reason: the
 * device lists the capability, accepts the command, and does nothing.
 * Something is misreporting itself and a firmware or kernel change may make it
 * work.
 *
 * Drawing them the same would be the failure this exists to prevent — and the
 * advertised state is the one most likely to be got wrong in code, because on
 * the wire it is indistinguishable from success.
 */
export default {
    name: 'YonderFacts',
    inject: ['$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    created () { this.$dataTracker(this.id) }
}
</script>

<style scoped>
.y-facts { font-family: var(--yonder-font, system-ui, sans-serif); font-size: 12px; }
.y-facts__title {
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--yonder-label, #7f8a95); margin-bottom: 6px;
}
.y-facts__row { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; }
.y-facts__label { min-width: 90px; color: var(--yonder-value, #fff); }
.y-facts__row.is-not-offered .y-facts__state { color: var(--yonder-neutral, #7d7869); }
.y-facts__row.is-advertised { border-left: 3px solid var(--yonder-waiting, #ffcf28); padding-left: 7px; }
.y-facts__row.is-advertised .y-facts__state { color: var(--yonder-waiting, #ffcf28); font-weight: 600; }
.y-facts__reason { color: var(--yonder-label, #7f8a95); font-style: italic; }
</style>
