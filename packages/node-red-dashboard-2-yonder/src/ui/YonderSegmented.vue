<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div v-if="state !== 'not-offered'" class="y-seg" :class="'is-' + state">
        <span v-if="label" class="y-seg__label">{{ label }}</span>
        <div class="y-seg__group" role="group" :aria-label="label">
            <button
                v-for="o in options"
                :key="o"
                type="button"
                class="y-seg__opt"
                :class="{ on: o === value }"
                :disabled="state !== 'present'"
                :aria-pressed="o === value"
                @click="pick(o)"
            >{{ o }}</button>
        </div>
        <div v-if="reason" class="y-seg__why" :class="toneClass">{{ reason }}</div>
    </div>
</template>

<script>
/**
 * A two- or three-way choice an operator presses — Video against Photo,
 * Fixed against Adaptive — in all four capability states (R-UI-20, R-UI-21).
 *
 * Ported from the blueprint's `DraftSegmented.vue`
 * (`docs/console/design/instrument-library/gallery/`, four rounds and an
 * operator review): the pixel values — the 230px cap, the 4px gap, the
 * type scale, every colour — are its own, carried over unchanged. What
 * changed is the class names (`y-seg*`, this library's own BEM prefix, in
 * place of the draft's `d-*`) and, exactly as `YonderPicker` already
 * departed from its own draft, the prop/event names: `value`/`change`, not
 * `modelValue`/`update:modelValue`. Every emitting part in this library
 * states its own event plainly instead, and a press here is named `change`
 * for the same reason the picker's own menu change is.
 *
 * **A value the options do not contain marks none of them.** The obvious
 * implementation — `options[0]` when nothing matches — would mark a camera
 * as being in a mode it is not in, which is the class of lie this whole
 * console exists to avoid. Nothing marked is the honest answer: `on` is
 * `o === value`, a plain equality with no fallback, so a stray value simply
 * fails every comparison rather than being coerced onto the first option.
 *
 * **Emitting the option, not its index** — `pick(o)` sends the option
 * itself. The index is a fact about the array; the option is a fact about
 * the camera. Every consumer of this component maps an option to a device
 * value, and an index would make each of them re-derive the same mapping
 * `YonderPicker`'s own `value`/`label` pairs do not need, because this
 * control's options are already the device's own values.
 *
 * **The four states behave exactly as `YonderPicker`'s do**, read there
 * before changing anything here: `present` works, offering exactly the
 * options given. `not-offered` draws nothing at all — no wrapper, no
 * label, no group — the same silence `YonderFacts` already speaks once;
 * this control never repeats it in a second, emptier one. `advertised` is
 * a **fault** (R-CAM-14): the device accepts the press and does not
 * deliver it, so the control stays, disabled, in the caution tone,
 * carrying the reason. `gated` is **not** a fault (R-UI-21): another
 * control currently has charge of this one, so it stays disabled in the
 * neutral tone instead, naming the control that has it — drawing that in
 * caution would tell an operator something is broken when nothing is.
 *
 * The tone is a lookup, not a ternary, for the same reason `YonderFacts`
 * and `YonderPicker` both use one: a ternary keyed on one state reads
 * every other state as its other branch, and a state this file does not
 * know about yet would silently draw in whichever tone the ternary
 * happened to fall back to.
 *
 * **Never stretches to its column (R-UI-08).** A segmented control that
 * fills its column turns two short words into two enormous slabs and stops
 * reading as a set of choices — `.y-seg` carries `max-width` alongside
 * `width: max-content`, never a percentage, so it is capped and sized to
 * its own content rather than to whatever surface it happens to sit on.
 *
 * **The `disabled` attribute is what stops the emit; the guard inside
 * `pick()` is belt-and-suspenders beside it, not a second path the test
 * suite exercises.** Mutation-checked (task-17-report.md): with the guard
 * removed and `disabled` left in place, `segmented.component.test.ts`'s
 * "emits nothing at all unless it is present" stays green — a real
 * `<button disabled>`'s click does not reach a Vue `@click` handler at all,
 * in jsdom same as in a browser. Only removing both together turns it red.
 * The guard stays anyway, exactly as the draft already had it: a disabled
 * DOM attribute is state this component asserts about itself on every
 * render, and the guard is what keeps a stray emit impossible even if some
 * future change ever let a press reach `pick()` by a path that does not
 * pass through that attribute — cheap insurance the test does not itself
 * require, recorded here so the next reader does not credit it with more
 * than it proves.
 */
const TONE_CLASS = {
    advertised: 'why-advertised',
    gated: 'why-gated'
}
export default {
    name: 'YonderSegmented',
    props: {
        label: { type: String, default: '' },
        value: { type: String, default: '' },
        options: { type: Array, default: () => [] },
        state: { type: String, default: 'present' },
        reason: { type: String, default: '' }
    },
    emits: ['change'],
    computed: {
        toneClass () {
            return TONE_CLASS[this.state] || ''
        }
    },
    methods: {
        pick (o) {
            if (this.state === 'present') this.$emit('change', o)
        }
    }
}
</script>

<style scoped>
.y-seg {
    margin-bottom: 13px;
    font-family: var(--yonder-font, system-ui, sans-serif);
    max-width: 230px;
    width: max-content;
}
.y-seg__label {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 5px;
}
.y-seg__group { display: flex; gap: 4px; }
.y-seg__opt {
    flex: 1 1 auto;
    min-width: 58px;
    min-height: 34px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    padding: 0 12px;
    cursor: pointer;
    border-radius: 3px;
    border: 1px solid var(--yonder-divider, #2b333c);
    background: transparent;
    color: var(--yonder-label, #7f8a95);
}
.y-seg__opt:hover:not(:disabled) { border-color: var(--yonder-label, #7f8a95); color: var(--yonder-value, #ffffff); }
.y-seg__opt.on {
    border-color: var(--yonder-select, #2ad4f0);
    color: var(--yonder-select, #2ad4f0);
    background: color-mix(in srgb, var(--yonder-select, #2ad4f0) 12%, transparent);
}
.y-seg__opt:disabled { cursor: not-allowed; }
/* Order matters: these two come after `.y-seg__opt.on` so a disabled
   control's own tone wins over the "on" colour on equal specificity,
   exactly as the draft already had it — an advertised or gated option
   reads in its state's tone whether or not it is the one marked on. */
.is-advertised .y-seg__opt { border-color: var(--yonder-waiting, #ffcf28); color: var(--yonder-waiting, #ffcf28); }
/* **Gated takes the neutral tone, exactly as `YonderPicker` does and as the
   advertised rule above already does here.** Dashing the border alone left
   the chosen option wearing `.on`'s select colour — cyan, which is this
   console's mark for *this is live and selected* — so a shutter another
   control had charge of read as a working control with an unusual border.
   Another control holding this one is not a fault, and it is not live
   either; both facts have to be visible (R-UI-21). */
.is-gated .y-seg__opt {
    border-style: dashed;
    border-color: var(--yonder-neutral, #7d7869);
    color: var(--yonder-neutral, #7d7869);
    background: transparent;
}
.y-seg__why { font-size: 11px; margin-top: 5px; line-height: 1.4; max-width: 230px; }
.why-advertised { color: var(--yonder-waiting, #ffcf28); }
.why-gated { color: var(--yonder-neutral, #7d7869); }
</style>
