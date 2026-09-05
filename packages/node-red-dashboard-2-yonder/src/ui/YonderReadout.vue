<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-ro">
        <div v-for="(row, i) in rows" :key="row.label + i" class="y-ro__row">
            <span class="y-ro__l">{{ row.label }}</span>
            <span class="y-ro__v" :class="{ 'is-absent': isAbsent(row) }">{{ shown(row) }}<template v-if="showUnit(row)">{{ ' ' }}<span class="y-ro__u">{{ row.unit }}</span></template></span>
        </div>
    </div>
</template>

<script>
/**
 * A label, a value and its unit, one row at a time (R-UI-08, R-UI-27).
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right: no `id`, no `$dataTracker`, no `$store`. It draws exactly the
 * `rows` it is given and decides nothing about where they came from — a
 * live message, a configured fallback, both are somebody else's problem.
 * `YonderDeck`, later in this plan, is the caller.
 *
 * **`null` is absent; `0` and `''` are real values.** A card that is not
 * fitted and a card that is fitted and reading zero must read as different
 * sentences — the same distinction R-UI-05 makes about a command, R-CAM-14
 * makes about a capability, and `YonderDataBar`/`YonderFacts` each make in
 * their own way, applied here to a single value. `undefined` — a row a
 * caller forgot to give a value at all — reads the same as `null` rather
 * than as a blank, for the identical reason. The one failure this
 * component exists not to have is a truthy check standing in for that
 * test: `row.value || 'none'` reads a real zero as absent, which is the
 * bug `readout.component.test.ts`'s zero-specific test exists to catch —
 * the coordinator's own verbatim absence test never hands this component a
 * zero, only a `null` and a truthy `"1"`, so it would pass a truthy-check
 * implementation exactly as well as a correct one.
 *
 * A row reporting absent never shows a unit, whatever `unit` it carries —
 * "none Mb/s" is not a sentence, and not fitted is not fitted regardless of
 * which unit would have applied if it were.
 */
export default {
    name: 'YonderReadout',
    props: {
        rows: { type: Array, default: () => [] }
    },
    methods: {
        isAbsent (row) {
            return row.value === null || row.value === undefined
        },
        showUnit (row) {
            if (this.isAbsent(row)) return false
            const unit = row.unit
            return unit !== undefined && unit !== null && unit !== ''
        },
        shown (row) {
            return this.isAbsent(row) ? 'none' : String(row.value)
        }
    }
}
</script>

<style scoped>
.y-ro { font-family: var(--yonder-font, system-ui, sans-serif); }
.y-ro__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 0;
    font-size: 13px;
}
.y-ro__row + .y-ro__row { border-top: 1px solid var(--yonder-divider, #2b333c); }
.y-ro__l {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    white-space: nowrap;
}
.y-ro__v {
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #ffffff);
    text-transform: none;
    white-space: nowrap;
}
/*
 * A token carrying a unit is never uppercased: `Mb/s`, not `MB/S` — that
 * reads as megabytes (CLAUDE.md, project-wide; this component is where the
 * rule is most easily lost, because every label around it is uppercase).
 * `text-transform: none` is stated here explicitly rather than trusted to
 * absence, so it wins regardless of what an ancestor or a future sibling
 * rule declares.
 *
 * `margin-left`, never a leading space typed into the tag: a space inside
 * markup is invisible in the source and survives no reformatting. This
 * margin is the *visual* half of the gap; the *serialised-text* half —
 * what `readout.component.test.ts`'s first test reads through `.text()` —
 * is the sibling `{{ ' ' }}` text node the template puts before this span,
 * the same two-part fix `YonderBudget.vue`'s head gap needed for the same
 * reason. Neither half proves the other: a margin with no text node would
 * leave `.textContent` reading `3.0Mb/s`, and a text node with no margin
 * would look wrong, so each has its own test.
 */
.y-ro__u {
    font-weight: 400;
    font-size: 0.9em;
    text-transform: none;
    margin-left: 4px;
    color: var(--yonder-label, #7f8a95);
}
.y-ro__v.is-absent {
    color: var(--yonder-neutral, #7d7869);
    font-weight: 400;
}
</style>
