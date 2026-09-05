<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div v-if="state !== 'not-offered'" class="y-pick" :class="'is-' + state">
        <label v-if="label" class="y-pick__label" :for="selectId">{{ label }}</label>
        <div class="y-pick__control" :class="{ 'is-focus': focused }">
            <span class="y-pick__value">{{ shownLabel }}</span>
            <span class="y-pick__caret" aria-hidden="true">&#9662;</span>
            <select
                :id="selectId"
                class="y-pick__select"
                :value="value"
                :disabled="state !== 'present'"
                :aria-label="label"
                @focus="focused = true"
                @blur="focused = false"
                @change="$emit('change', $event.target.value)"
            >
                <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
        </div>
        <div v-if="reason" class="y-pick__why" :class="toneClass">{{ reason }}</div>
    </div>
</template>

<script>
/**
 * A menu of the device's own entries, in all four capability states
 * (R-CAM-14, R-UI-20, R-UI-21).
 *
 * Ported from the blueprint's `DraftPicker.vue`
 * (`docs/console/design/instrument-library/gallery/`, four rounds and an
 * operator review): a real `<select>` under a drawn control, because a
 * custom listbox would have to reimplement keyboard handling and focus, and
 * a native select is what gives a tablet a usable wheel and a screen reader
 * something to read. **`value`/`change`, not `modelValue`/`update:modelValue`
 * (the blueprint's own names).** Every emitting part in this library states
 * its own event plainly instead — `YonderHoldKey` sends `widget-action`,
 * `YonderTextField` sends `update:value` — and this control's own event is a
 * plain DOM change, so it is named `change`.
 *
 * **Four states, and each has to look different — the same rule
 * `YonderFacts` draws as a row, applied here to a control an operator can
 * actually turn.**
 *
 * `present` works: enabled, offering exactly the entries `options` carries —
 * never a wider range synthesised from a `min`/`max` the device reported,
 * which is what R-CAM-14 forbids. The bench's own `auto_exposure` answers
 * ids 1 and 3 only (`packages/yonder-core/src/video/probe/fixtures/
 * list-ctrls-menus-globalshutter.txt`: `min=0 max=3`, but only `1: Manual
 * Mode` and `3: Aperture Priority Mode` are real entries) — a picker that
 * filled in every id between would put two modes on the page this camera
 * does not have.
 *
 * `not-offered` renders nothing at all — no wrapper, no label, no select.
 * The fact that a camera lacks a capability is stated once, where
 * `YonderFacts` draws it (R-UI-20); a picker that also rendered an empty box
 * where its control would have been would say the same absence twice, in
 * two different silences.
 *
 * `advertised` is a **fault**: the device lists the capability, accepts the
 * command, and does not deliver it. The control stays — an operator must be
 * able to tell *this camera cannot* from *this page failed* — but disabled,
 * in the caution tone, carrying the reason.
 *
 * `gated` is **not a fault** (R-UI-21): another control currently has charge
 * of this one, exactly the way the bench's own `auto_exposure` leaves
 * `exposure_time_absolute` reporting `flags=inactive` in that same fixture
 * while it sits in Aperture Priority Mode. Drawing that in the caution tone
 * would tell an operator something is broken when nothing is, so it is
 * disabled in the neutral tone instead, naming the control that has it.
 *
 * **The tone is a lookup, not a ternary** — `YonderFacts`' own reasoning
 * applies unchanged: a ternary keyed on one state reads every other state as
 * its other branch, and a state this file does not know about yet would
 * silently draw in whichever tone the ternary happened to fall back to.
 */
const TONE_CLASS = {
    advertised: 'why-advertised',
    gated: 'why-gated'
}
export default {
    name: 'YonderPicker',
    props: {
        label: { type: String, default: '' },
        value: { type: [String, Number], default: '' },
        options: { type: Array, default: () => [] },
        state: { type: String, default: 'present' },
        reason: { type: String, default: '' }
    },
    emits: ['change'],
    data: () => ({ focused: false }),
    computed: {
        /**
         * **A real `<label for>`, not a span beside a control.** `aria-label`
         * already gave the select its accessible name, so a screen reader was
         * never lost — but a span is not a label, and clicking the word
         * `Exposure` did nothing. On a page an operator reaches for while an
         * aircraft is flying, a target the size of the word costs nothing to
         * offer and is the difference between one press and two.
         *
         * Unique per instance, because a deck draws many of these at once and
         * duplicate ids would associate every label with the first select.
         */
        selectId () { return `y-pick-${this._uid ?? this.$?.uid ?? Math.random().toString(36).slice(2)}` },
        /**
         * The overlay text shown under the real, transparent `<select>` —
         * the current value's own label, so the drawn control reads the
         * same word the menu offers rather than the raw option value (an id
         * such as `"3"` means nothing to an operator without it).
         */
        shownLabel () {
            const hit = this.options.find(o => String(o.value) === String(this.value))
            return hit ? hit.label : String(this.value)
        },
        toneClass () {
            return TONE_CLASS[this.state] || ''
        }
    }
}
</script>

<style scoped>
.y-pick { margin-bottom: 13px; font-family: var(--yonder-font, system-ui, sans-serif); }
.y-pick__label {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 5px;
}
.y-pick__control {
    position: relative;
    display: flex;
    width: 100%;
    max-width: 230px;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 3px;
    border: 1px solid var(--yonder-divider, #2b333c);
    background: color-mix(in srgb, var(--yonder-value, #ffffff) 2%, transparent);
    color: var(--yonder-value, #ffffff);
}
.y-pick__control.is-focus { border-color: var(--yonder-select, #2ad4f0); }
.y-pick__select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    font: inherit;
}
.y-pick__select:disabled { cursor: not-allowed; }
.y-pick__value { font-variant-numeric: tabular-nums; }
.y-pick__caret { color: var(--yonder-select, #2ad4f0); font-size: 11px; }
.is-advertised .y-pick__control { border-color: var(--yonder-waiting, #ffcf28); color: var(--yonder-waiting, #ffcf28); }
.is-advertised .y-pick__caret, .is-gated .y-pick__caret { display: none; }
/* `gated` reads in the neutral tone, the same token `YonderFacts` uses for
   exactly the same reason (R-UI-21): another control having charge of this
   one is not a fault, so it takes no caution border and no caution colour —
   dashed rather than solid is this control's own way of marking "not
   available right now", distinct from both a plain enabled box and the
   caution-toned advertised one. */
.is-gated .y-pick__control { color: var(--yonder-neutral, #7d7869); border-style: dashed; background: transparent; }
.y-pick__why { font-size: 11px; margin-top: 5px; line-height: 1.4; max-width: 230px; }
.why-advertised { color: var(--yonder-waiting, #ffcf28); }
.why-gated { color: var(--yonder-neutral, #7d7869); }
</style>
