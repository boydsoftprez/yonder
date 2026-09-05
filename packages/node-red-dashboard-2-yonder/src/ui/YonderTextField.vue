<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-tf">
        <span v-if="label" class="y-tf__label">{{ label }}</span>
        <div class="y-tf__box" :class="{ 'is-focus': focus }">
            <input
                class="y-tf__input"
                type="text"
                :value="local"
                :maxlength="max"
                :placeholder="placeholder"
                :aria-label="label"
                @focus="focus = true"
                @blur="focus = false"
                @input="onInput"
            >
            <span v-if="focus" class="y-tf__count">{{ local.length }}/{{ max }}</span>
        </div>
        <div v-if="hint" class="y-tf__hint">{{ hint }}</div>
    </div>
</template>

<script>
/**
 * A name the operator chooses (R-UI-27).
 *
 * Yonder ships `Cam 1`, `Cam 2` … because a default that guesses at a
 * mounting — nose, belly, gimbal — is a guess about somebody else's
 * aircraft (the blueprint's own words for this control,
 * `docs/console/design/instrument-library/gallery/DraftTextField.vue`).
 * This is the one part in this library an operator types into rather than
 * picks or presses.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right: no `id`, no `$dataTracker`, no `$store`.
 *
 * **`value`/`update:value`, not `modelValue`/`update:modelValue`.** Every
 * other emitting part already shipped in this library states its own
 * event's name plainly — `YonderHoldKey` sends `widget-action`, not a Vue
 * `v-model` convention — and a caller composing this field into a real page
 * (`YonderDeck`, later in this plan) reads it the same way it reads
 * everything else here.
 *
 * **A local, capped copy, not the prop directly.** Nothing composes this
 * field with two-way binding in a raw mount — that is what the emitted
 * event is for — so the `<input>` is bound to its own `local` copy, seeded
 * from `value` and kept in step with it if a caller does change the prop
 * later. Typing writes `local` (capped) first and emits second, so what
 * the input shows and what the counter counts are always the string that
 * was just emitted, never whatever the parent last accepted.
 *
 * **The cap is enforced twice, on purpose (coordinator resolution 6).**
 * `maxlength` stops ordinary typing at the browser's own layer, but a
 * value arriving by paste, or set on the element programmatically, reaches
 * `local` through the same `input` event and is capped again here — the
 * only cap a caller can actually rely on, since `maxlength` alone does not
 * survive `element.value = …` set from outside the browser's own typing
 * path. That includes the value this component is *handed*: a stored name
 * written before `max` was ever tightened is capped the moment it is
 * mounted, not only on the next keystroke.
 */
export default {
    name: 'YonderTextField',
    props: {
        label: { type: String, default: '' },
        value: { type: String, default: '' },
        placeholder: { type: String, default: '' },
        hint: { type: String, default: '' },
        max: { type: Number, default: 24 }
    },
    emits: ['update:value'],
    data () {
        return { focus: false, local: this.cap(this.value) }
    },
    watch: {
        value (next) {
            this.local = this.cap(next)
        }
    },
    methods: {
        cap (raw) {
            const s = typeof raw === 'string' ? raw : ''
            return s.length > this.max ? s.slice(0, this.max) : s
        },
        onInput (event) {
            const capped = this.cap(event.target.value)
            this.local = capped
            this.$emit('update:value', capped)
        }
    }
}
</script>

<style scoped>
.y-tf { margin-bottom: 13px; font-family: var(--yonder-font, system-ui, sans-serif); }
.y-tf__label {
    display: block;
    font-size: 9.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 4px;
}
.y-tf__box {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 250px;
    padding: 7px 10px;
    border-radius: 2px;
    border: 1px solid var(--yonder-divider, #2b333c);
    background: color-mix(in srgb, var(--yonder-value, #ffffff) 2%, transparent);
}
.y-tf__box.is-focus { border-color: var(--yonder-select, #2ad4f0); }
.y-tf__input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    font: inherit;
    font-size: 13px;
    color: var(--yonder-value, #ffffff);
}
.y-tf__input::placeholder { color: var(--yonder-label, #7f8a95); }
.y-tf__count {
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-tf__hint {
    font-size: 9.5px;
    margin-top: 4px;
    max-width: 250px;
    color: var(--yonder-label, #7f8a95);
}
</style>
