<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <span class="y-ann" :class="'tone-' + tone">
        <i class="y-ann__lamp" aria-hidden="true" />
        <span class="y-ann__text">{{ text }}</span>
    </span>
</template>

<script>
import { presentation } from 'yonder-core/presentation'

/**
 * The annunciator (R-UI-11, ADR-0005).
 *
 * R-UI-11 exists because the four command tones were reaching the page as
 * coloured body text — the weakest expression available, because it has to be
 * read to be understood. On a console driven at arm's length the whole point
 * of a state is that it is legible before it is read, so it becomes a lamp
 * and a caption.
 *
 * Both the tone and the words come from `presentation()` in `yonder-core`.
 * This component chooses neither, which is what stops a control meaning one
 * thing on the network page and another in the cockpit.
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
    name: 'YonderAnnunciator',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        /** A CommandStatus, from the shared channel or from the payload. */
        status () {
            const msg = this.$store?.state?.data?.messages?.[this.id]
            if (!msg) return null
            const from = this.props.source === 'payload' ? msg.payload : msg.yonder
            return from && typeof from === 'object' ? from : null
        },
        shown () {
            return presentation(this.status?.state ?? 'idle')
        },
        tone () {
            return this.shown.tone
        },
        /**
         * The node's own label wins when it has one, so a page can say what
         * the state is *of*. Otherwise the shared wording, which is the same
         * on every page by construction.
         */
        text () {
            return this.props.label || this.status?.message || this.shown.label
        }
    },
    created () {
        this.$dataTracker(this.id)
    }
}
</script>

<style scoped>
.y-ann {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 1px solid currentColor;
    font-family: var(--yonder-font-mono);
    font-size: 0.5625rem;
    font-weight: 800;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    white-space: nowrap;
}

/* Lit, not merely coloured: the glow is what carries at a glance. */
.y-ann__lamp {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
    flex: none;
}

.tone-neutral { color: var(--yonder-label, #7f8a95); }
.tone-waiting { color: var(--yonder-waiting, #ffcf28); }
.tone-good { color: var(--yonder-good, #35d06a); }
.tone-bad { color: var(--yonder-bad, #ff4034); }

.y-ann__text { color: inherit; }
</style>
