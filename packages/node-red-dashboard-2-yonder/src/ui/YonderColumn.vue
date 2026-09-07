<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div v-if="legend" class="y-col">
        <div class="y-col__head">
            <span class="y-col__legend">{{ legend }}</span>
            <!-- The right-hand end of the head row: the qualifier prop, or
                 whatever the page puts there instead. See `head-right`. -->
            <slot name="head-right">
                <span v-if="qualifier" class="y-col__q" :class="toneClass">{{ qualifier }}</span>
            </slot>
        </div>
        <slot />
    </div>
</template>

<script>
/**
 * A titled group inside the deck, with an optional right-hand qualifier —
 * "to the ground station", "rate control" (§6).
 *
 * Ported from the blueprint's `DraftColumn.vue`
 * (`docs/console/design/instrument-library/gallery/`, read but not
 * modified, per instruction): the padding, the head row's baseline-aligned
 * layout and the type scale are its own, carried over unchanged. Changed,
 * as every other part in this library already changed from its own draft:
 * class names (`y-col*`, not the draft's `d-*`) and the prop names — this
 * file says `legend`/`qualifier`/`tone` where the draft said
 * `title`/`note`/`noteTone`. The coordinator's own resolution names this
 * part's two facts "a legend" and "a right-hand qualifier", so the props
 * are named to match the words the requirement uses rather than the
 * draft's.
 *
 * **Empty input draws no wrapper at all — no head, no slot, nothing.**
 * The same silence `state: 'not-offered'` already draws for `YonderPicker`,
 * `YonderSegmented` and `YonderSetBar` (R-UI-20's own reasoning), applied
 * here to a part that has no `state` prop of its own to key it on: a
 * column with nothing to call itself is not a column with an empty title,
 * the way a camera with no shutter is not a shutter control that happens
 * to be blank. Whatever this column would have wrapped stays unwrapped
 * rather than escaping onto the page on its own — an empty box sitting
 * where a group would have been claims a group exists and has nothing in
 * it, which is a different, false sentence from the group not existing.
 *
 * The qualifier, unlike the legend, is genuinely optional: most columns
 * have none, and that is the ordinary case rather than one needing this
 * same silent treatment — it simply draws nothing in the space it would
 * have taken.
 *
 * **`head-right` is the same place, for something that is not a string.**
 * The blueprint puts a link in the outputs legend on Live — `stop or start
 * them on Setup ›` (L-92) — and a `qualifier` cannot be one: it is a
 * `<span>`, and the whole point of that element is that it states a fact
 * and cannot be pressed. Rather than teach this column what a link is, or
 * let one page draw its own head row and start a second copy of this
 * layout, the slot hands the right-hand end over and the column keeps
 * owning where it sits and how it aligns. `qualifier` remains the default
 * content, so every existing caller is untouched and a page supplies one or
 * the other, never both.
 *
 * **The tone is a lookup, not a ternary** — the same reasoning
 * `YonderFacts`, `YonderPicker`, `YonderSegmented` and `YonderSetBar` all
 * give for using one: a ternary keyed on one tone reads every other tone
 * as its other branch, and a tone this file does not know about yet would
 * silently draw in whichever tone the ternary happened to fall back to.
 * An unrecognised tone (including the default, unset `''`) draws in the
 * plain label colour instead — never a fallback that could be mistaken for
 * a real answer.
 */
const TONE_CLASS = {
    select: 'tone-select',
    waiting: 'tone-waiting'
}
export default {
    name: 'YonderColumn',
    props: {
        legend: { type: String, default: '' },
        qualifier: { type: String, default: '' },
        tone: { type: String, default: '' }
    },
    computed: {
        toneClass () {
            return TONE_CLASS[this.tone] || ''
        }
    }
}
</script>

<style scoped>
.y-col { padding: 14px 16px 4px; min-width: 0; font-family: var(--yonder-font, system-ui, sans-serif); }
.y-col__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 12px;
}
.y-col__q { font-style: normal; letter-spacing: 0.1em; }
.tone-select { color: var(--yonder-select, #2ad4f0); }
.tone-waiting { color: var(--yonder-waiting, #ffcf28); }
</style>
