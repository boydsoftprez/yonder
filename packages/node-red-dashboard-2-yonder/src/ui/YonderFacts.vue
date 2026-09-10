<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-facts">
        <div v-if="props.title" class="y-facts__title">{{ props.title }}</div>
        <div v-for="fact in facts" :key="fact.label" class="y-facts__row" :class="'is-' + fact.state">
            <span class="y-facts__label">{{ fact.label }}</span>
            <span class="y-facts__state">{{ words(fact.state) }}</span>
            <span v-if="fact.reason" class="y-facts__reason">{{ fact.reason }}</span>
        </div>
    </div>
</template>

<script>
/**
 * What this camera cannot do, stated where the control would have been
 * (R-UI-20).
 *
 * **Four states, and each has to look different — that is the whole
 * component.** `not-offered` is a fact in the neutral tone — the camera does
 * not have it, nothing is wrong, and the row exists only so nobody goes
 * looking. `advertised` is a *fault* in the caution tone, carrying its
 * reason: the device lists the capability, accepts the command, and does
 * nothing. Something is misreporting itself and a firmware or kernel change
 * may make it work.
 *
 * `gated` (R-UI-21) reads as neutral as `not-offered` — the same colour, and
 * no caution border — because another control having charge of this one is
 * not a fault: the bench camera's own `auto_exposure` holds its shutter
 * exactly as documented. `reason` carries the responsible control's name, in
 * an operator's own words rather than a V4L2 identifier.
 *
 * `undrawn` is the last: the camera *has* it and this page does not draw it.
 * Nothing is wrong with the device and nothing is wrong with the probe — the
 * console has not been built that far — and saying so is the difference
 * between a page an operator can trust and one that quietly under-reports
 * their camera. It was the gap that let the bench's own camera answer zoom,
 * focus, exposure and white balance as present while the page said nothing
 * about any of them.
 *
 * Drawing any two of them the same would be the failure this exists to
 * prevent — and `advertised` is the one most likely to be got wrong in code,
 * because on the wire it is indistinguishable from success.
 */
/**
 * The words for each state.
 *
 * **A lookup with a real fall-back, not a ternary.** This was
 * `state === 'advertised' ? … : …`, so *every* state that was not advertised
 * read "this camera has none" — and a state added to `capability.ts` later
 * would have had the console asserting a camera lacks something it knows
 * nothing about. `shapes.ts` imports the type from yonder-core precisely to
 * stop that drift, and cannot: this template is untyped JavaScript, so the
 * mitigation never reached the place the failure happens. The fall-back is
 * what reaches it.
 */
const STATES = {
    'not-offered': 'this camera has none',
    advertised: 'not answering',
    gated: 'another control has it',
    undrawn: 'offered, not on this page'
}
export default {
    name: 'YonderFacts',
    inject: ['$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        /**
         * **What arrived, in preference to what was configured.**
         *
         * A capability list written into the flows is a *stored* list, and
         * R-CAM-14 exists because a stored list is a stale list the first time
         * a lens, a firmware or the camera itself changes — a page confidently
         * telling an operator their camera cannot record, about a camera that
         * can. So `capabilityFacts()` in yonder-core builds these from what the
         * device answered a moment ago and the daemon sends them on
         * `payload.facts`.
         *
         * The configured list stays as the fallback and is not dead: it is what
         * the row draws before the first message arrives, which is the
         * difference between a page that is briefly empty and a page that looks
         * like it failed.
         *
         * Reached through `$store` rather than vuex's `mapState`, for the
         * reason YonderDataBar records: vuex has to be external, no `Vuex`
         * global exists on the page, and `$store` is the supported way in.
         */
        facts () {
            const live = this.$store?.state?.data?.messages?.[this.id]?.payload?.facts
            return Array.isArray(live) ? live : (this.props.facts || [])
        }
    },
    created () { this.$dataTracker(this.id) },
    methods: {
        words (state) {
            return STATES[state] || `reported as ${state}`
        }
    }
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
/* `gated` reads exactly as neutral as `not-offered` — sharing this rule
   means the two cannot drift apart by accident — and takes no border: the
   left border below belongs to `advertised`, a fault, which this is not
   (R-UI-21). */
.y-facts__row.is-not-offered .y-facts__state,
.y-facts__row.is-gated .y-facts__state { color: var(--yonder-neutral, #7d7869); }
.y-facts__row.is-advertised { border-left: 3px solid var(--yonder-waiting, #ffcf28); padding-left: 7px; }
.y-facts__row.is-advertised .y-facts__state { color: var(--yonder-waiting, #ffcf28); font-weight: 600; }
/* The camera has it; this page does not draw it. Nothing is wrong, so it
   reads as a fact rather than as a fault — but it is about the console rather
   than about the device, so it is not the same fact as `not-offered`. */
.y-facts__row.is-undrawn .y-facts__state { color: var(--yonder-label, #7f8a95); }
.y-facts__reason { color: var(--yonder-label, #7f8a95); font-style: italic; }
</style>
