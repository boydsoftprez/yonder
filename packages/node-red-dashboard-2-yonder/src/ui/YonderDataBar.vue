<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-bar">
        <div v-for="cell in props.cells" :key="cell.key" class="y-bar__cell">
            <span class="y-bar__k">{{ cell.label }}</span>
            <span class="y-bar__v" :class="{ id: cell.kind === 'id', absent: !has(cell.key) }">
                {{ shown(cell.key) }}
            </span>
        </div>
    </div>
</template>

<script>

/**
 * The data bar (ADR-0009).
 *
 * A row of label-and-value cells. It exists because of arithmetic rather than
 * taste: a stock widget is a whole row of its group and holds one string, so
 * the Status page spent roughly 370 px on five short values. Six fit here in
 * thirty, which is the difference between a page an operator scans and a page
 * they scroll.
 *
 * A key that is not in the payload draws as an em dash. *Not known* and
 * *nothing* are different answers, and only one of them is honest — the same
 * distinction R-UI-05 makes about commands, applied to a fact.
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
    name: 'YonderDataBar',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        payload () {
            const value = this.$store?.state?.data?.messages?.[this.id]?.payload
            return value && typeof value === 'object' ? value : {}
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    methods: {
        has (key) {
            const value = this.payload[key]
            return value !== undefined && value !== null && value !== ''
        },
        shown (key) {
            return this.has(key) ? String(this.payload[key]) : '—'
        }
    }
}
</script>

<style scoped>
.y-bar {
    display: flex;
    /* R-UI-25: six cells of real values ran past the row's own width and one
       came back `1280 × 7…`. Wrapping onto a second line is what a row this
       narrow does instead of asking a cell to shrink below its value. */
    flex-wrap: wrap;
    align-items: stretch;
    font-family: var(--yonder-font);
    border-top: 1px solid var(--yonder-divider, #2b333c);
}

.y-bar__cell {
    flex: 1;
    /* `min-width: 0` is what let a cell shrink below its own value's width
       in the first place — `flex-wrap` above cannot help a cell that will
       still rather shrink than wrap. `max-content` is the floor: never
       smaller than the value it was handed. */
    min-width: max-content;
    padding: 5px 10px;
    border-right: 1px solid var(--yonder-divider, #2b333c);
}
.y-bar__cell:last-child { border-right: 0; }

.y-bar__k {
    display: block;
    font-family: var(--yonder-font-mono);
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}

.y-bar__v {
    font-family: var(--yonder-font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-value, #fff);
    display: block;
    /* No `text-overflow: ellipsis` here (R-UI-25): the cell it sits in is
       never narrower than this value needs (`min-width: max-content`
       above), so a value is never shortened to fit — the row wraps first. */
    white-space: nowrap;
}

/* An identifier is compared character by character, so it is cyan and
   addressable rather than white and read. */
.y-bar__v.id { color: var(--yonder-select, #2ad4f0); }
.y-bar__v.absent { color: var(--yonder-label, #7f8a95); font-weight: 400; }
</style>
