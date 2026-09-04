<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-keys" role="toolbar">
        <button
            v-for="key in props.keys"
            :key="key.action"
            type="button"
            class="y-keys__key"
            :class="['tone-' + (key.tone || 'plain'), { on: key.active }]"
            :aria-pressed="key.active ? 'true' : 'false'"
            @click="press(key)"
        >
            {{ key.label }}
        </button>
    </div>
</template>

<script>
/**
 * The soft keys (R-UI-10, ADR-0009).
 *
 * The answer to the complaint this design language began with: a button that
 * spanned half the page. It did so because a stock widget *is* a row of its
 * group and cannot be smaller than one — so shrinking the button only added
 * empty space around it, and no stylesheet could have fixed it. The fix is
 * that actions stop being widgets.
 *
 * They live along the foot of the display, the way a multi-function display
 * puts them under the bezel, and R-UI-10 says no action lives anywhere else
 * on the page.
 *
 * `warn` is reserved for a control that takes the page away from the operator
 * — the join that drops the access point (K-13) — and a page has at most one.
 * That is a rule about pages, enforced where pages are assembled; this
 * component draws the tone it is given.
 */
export default {
    name: 'YonderSoftKeys',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        press (key) {
            // `widget-action` rather than `widget-change`: pressing a key is an
            // event, not a value to restore on reload. A console that replayed
            // the last key pressed when a browser reconnected would be
            // originating an action nobody asked for.
            this.$socket.emit('widget-action', this.id, { payload: key.action, topic: key.label })
        }
    }
}
</script>

<style scoped>
.y-keys {
    display: flex;
    border-top: 1px solid var(--yonder-divider, #2b333c);
    background: var(--yonder-pane, #090d12);
}

.y-keys__key {
    /* Sized to its words, never `flex: 1`. Two keys stretched across a 1256px
       rail are the slab this whole design language replaced, wearing a rail
       for a hat. */
    flex: 0 0 auto;
    min-width: 8rem;
    padding-inline: 1.25rem;
    /* A key is a control, so it takes the same floor every other control
       takes. This was 34px, under a comment that justified it the same way
       `--yonder-touch: 44px` was justified — so the two numbers disagreed
       while their reasons matched, and the shared fiction is what kept that
       invisible. The rail is the full width; a key within it never is. */
    min-height: var(--yonder-touch, 44px);
    padding: 7px 6px;
    border: 0;
    border-right: 1px solid var(--yonder-divider, #2b333c);
    background: transparent;
    font-family: var(--yonder-font-mono);
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--yonder-label, #7f8a95);
    cursor: pointer;
}
.y-keys__key:last-child { border-right: 0; }

.y-keys__key.on {
    color: var(--yonder-value, #fff);
    /* A raised state is lighter on a dark panel and darker on a light one, so
       it comes from the theme rather than from an assumption about which. */
    background: var(--yonder-raised, rgba(255, 255, 255, 0.06));
    box-shadow: inset 0 2px 0 var(--yonder-select, #2ad4f0);
}

.tone-act { color: var(--yonder-select, #2ad4f0); }
.tone-warn { color: var(--yonder-irreversible, #f03fce); }

.y-keys__key:hover { background: var(--yonder-raised, rgba(255, 255, 255, 0.04)); }
.y-keys__key:focus-visible {
    outline: 2px solid var(--yonder-select, #2ad4f0);
    outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
    .y-keys__key { transition: none; }
}
</style>
