<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-ov" :class="toneClass">
        <div class="y-ov__head">
            <span class="y-ov__cap">{{ headWord }}</span>
            <span v-if="size" class="y-ov__size">{{ size }}</span>
            <span v-if="rate" class="y-ov__rate">{{ rate }}</span>
            <span v-if="bitrate" class="y-ov__bitrate">{{ bitrate }}</span>
        </div>
        <div v-if="detail" class="y-ov__detail">{{ detail }}</div>
        <div v-if="step || reserveStep" class="y-ov__step" :class="{ 'y-ov__step--reserved': reserveStep }" :tabindex="reserveStep && step ? 0 : undefined">{{ step }}</div>
        <div v-if="hasCost" class="y-ov__cost">
            <span v-if="cost.view" class="y-ov__cost-f">This view {{ cost.view }}</span>
            <span v-if="cost.encode" class="y-ov__cost-f">Shared encode {{ cost.encode }}</span>
            <span v-if="cost.path" class="y-ov__cost-f">Path total {{ cost.path }}</span>
        </div>
    </div>
</template>

<script>
/**
 * What the picture is doing, drawn on itself (R-VID-18) — the preview-state
 * message §8.2 describes, combining the daemon's per-camera and
 * per-viewer scopes into one overlay.
 *
 * **Draws what it is given and decides nothing — the whole message is
 * pre-formatted by the daemon.** `size`, `rate`, `bitrate` and `detail`
 * arrive as the exact strings this component shows (`'1280×720'`,
 * `'15 fps'`, `'1.8 Mb/s'`, `'1.8 of 0.3–2.0'`); this file never parses,
 * sums or reformats any of them, for the identical reason `YonderBudget`
 * and `YonderDataBar` never do — §8.2 says plainly that "the picture draws
 * the resulting state without depending on the deck or a second rate
 * algorithm", and a second algorithm is exactly what reformatting a
 * daemon-composed string here would be.
 *
 * **Five head words, and the tone is a lookup, not a ternary** — the
 * reasoning `YonderFacts`, `YonderPicker`, `YonderSegmented`, `YonderSetBar`
 * and `YonderColumn` all give for using one: a ternary keyed on one head
 * reads every other head as its other branch, and a head this file does
 * not know about yet would silently draw in whichever tone the ternary
 * happened to fall back to. Three of the five are the coordinator's own
 * named examples (task-19-brief.md §5): `floor` (pinned at the operator's
 * own bitrate floor) takes the caution tone, `stills` (R-VID-14's
 * fall-back: live video could not be established) takes the fault tone,
 * and `full-rate` (the operator's own held key, R-VID-13) takes the select
 * tone this library already uses for a live, chosen thing. The other two
 * are this file's own reasoned extensions, not dictated: `adaptive`
 * (ordinary operation, inside the envelope) takes the good tone
 * `YonderPicture` already uses for an ordinary live picture, and `held`
 * (a chosen size holding rather than stepping, §8.1) takes the neutral
 * tone — a deliberate, correct state, not a caution and not a live
 * selection either. An unrecognised head draws with no tone class at all
 * (the plain value colour) rather than guessing.
 *
 * **The step line is a fact about a change, not a permanent fixture**: it
 * shows text only when the daemon's own message carries it (§8.2, "the
 * last step with its reason"). Video toolbars reserve its space so transient
 * messages never move the picture; long reasons remain scrollable. Other
 * placements omit the empty row.
 *
 * **The cost is three fields, never one sum** (coordinator resolution 5,
 * §8.2's own words): "actual traffic per output/subscriber on each path
 * … not the sum of two encoder targets. Show this viewer's cost
 * separately from total path spend." This component does not add `view`
 * and `encode` to produce `path` — it has no way to, since the path total
 * genuinely includes other viewers and thumbnail stills this component is
 * never told about — so all three are drawn as their own labelled field,
 * and any one of them missing simply omits its own row rather than
 * leaving a gap the others shift to fill.
 */
const HEAD_WORD = {
    adaptive: 'ADAPTIVE',
    floor: 'MINIMUM BITRATE',
    held: 'FIXED SIZE',
    fixed: 'FIXED BITRATE',
    'full-rate': 'FULL RATE',
    stills: 'STILLS'
}
const TONE_CLASS = {
    adaptive: 'tone-good',
    floor: 'tone-waiting',
    held: 'tone-neutral',
    fixed: 'tone-neutral',
    'full-rate': 'tone-select',
    stills: 'tone-bad'
}
export default {
    name: 'YonderStateOverlay',
    props: {
        head: { type: String, default: 'adaptive' },
        size: { type: String, default: '' },
        rate: { type: String, default: '' },
        bitrate: { type: String, default: '' },
        detail: { type: String, default: '' },
        step: { type: String, default: '' },
        reserveStep: { type: Boolean, default: false },
        /** `{ view, encode, path }` — this viewer's own delivery, the
         * shared preview encode, and the measured path total. Each is
         * optional and pre-formatted; see this component's own doc
         * comment on why none of the three is ever derived from another. */
        cost: { type: Object, default: () => ({}) }
    },
    computed: {
        headWord () {
            return HEAD_WORD[this.head] || String(this.head).toUpperCase()
        },
        toneClass () {
            return TONE_CLASS[this.head] || ''
        },
        hasCost () {
            return Boolean(this.cost && (this.cost.view || this.cost.encode || this.cost.path))
        }
    }
}
</script>

<style scoped>
.y-ov {
    display: inline-flex;
    flex-direction: column;
    gap: 3px;
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 11px;
    color: var(--yonder-value, #ffffff);
}
.y-ov__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; }
.y-ov__cap {
    font-weight: 700;
    letter-spacing: 0.1em;
    /* `headWord` already carries its own capitals (`ADAPTIVE`, `AT THE
       FLOOR`, …) — this is not what makes them capitals, it just matches
       the letter-spacing the rest of this overlay's caps carry. Left
       un-transformed on purpose: a head this file does not recognise falls
       back to `String(head).toUpperCase()` in script rather than in CSS, so
       what a test reads through `.text()` is exactly what is on screen,
       never a rendering-only capitalisation `.text()` cannot see. */
}
.y-ov__size, .y-ov__rate, .y-ov__bitrate {
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-ov__detail {
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-ov__step {
    font-size: 10.5px;
    color: var(--yonder-waiting, #ffcf28);
}
/* R-VID-18: status changes must not displace the live picture. */
.y-ov__step--reserved {
    line-height: 1.4;
    block-size: 2.8em;
    overflow: auto;
    overflow-wrap: anywhere;
    pointer-events: auto;
}
.y-ov__cost { display: flex; flex-wrap: wrap; gap: 10px; font-size: 10px; color: var(--yonder-label, #7f8a95); }
.y-ov__cost-f { font-variant-numeric: tabular-nums; }
.tone-good .y-ov__cap { color: var(--yonder-good, #35d06a); }
.tone-waiting .y-ov__cap { color: var(--yonder-waiting, #ffcf28); }
.tone-bad .y-ov__cap { color: var(--yonder-bad, #ff4034); }
.tone-neutral .y-ov__cap { color: var(--yonder-neutral, #7d7869); }
.tone-select .y-ov__cap { color: var(--yonder-select, #2ad4f0); }
</style>
