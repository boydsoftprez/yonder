<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-bar">
        <div
            v-for="cell in props.cells"
            :key="cell.key"
            class="y-bar__cell"
            :class="{ note: cell.kind === 'note' }"
        >
            <span class="y-bar__k">{{ cell.label }}</span>
            <span
                class="y-bar__v"
                :class="{ id: cell.kind === 'id', note: cell.kind === 'note', absent: !has(cell.key) }"
            >
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
 *
 * **`kind: 'note'` is a cell holding a sentence rather than a reading**, and
 * it exists because a bar of readings could not hold one. The camera strip's
 * `RUNNING` cell carries `runWords()` — a state and, when there is one, the
 * supervisor's own failure reason, which the capture gate's widest honest
 * value measures at 104 characters and 750 px. In a reading's cell that is
 * `white-space: nowrap` against `min-width: max-content`, so the row cannot
 * wrap it and cannot shrink it: the strip ran 798 px wide inside a 710 px
 * page and took the page sideways with it. Shortening it is forbidden
 * (R-UI-25) and correctly so — half a sentence about why a pipeline died is
 * worse than none.
 *
 * So a note cell wraps its own words, and takes a line of its own to do it:
 * `flex-basis: 100%` rather than a share of the line. That is deliberately
 * the *predictable* arrangement rather than the tightest one — a cell
 * competing for a share of the line is one whose height depends on how wide
 * every other cell's value happened to be that run, and a strip whose height
 * moves with its content is a widget whose slot cannot be sized. On its own
 * line it wraps against the whole bar, so its height is a function of the
 * page width alone.
 *
 * **A cell is declared a note by the page, never guessed from its value.**
 * Wrapping on "this string looks long" would wrap a reading the day a camera
 * reports a wider one, and `white-space: nowrap` on a reading is what stops
 * `1280 × 720` breaking after the `×`.
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

/* A sentence, on a line of its own — see this file's own doc comment.
   `min-width: 0` undoes the `max-content` floor above, which is what makes
   the row unable to wrap a long value; `flex-basis: 100%` is what puts it on
   its own line rather than leaving its height at the mercy of how wide the
   other cells' values were. No right-hand rule: it is the only cell on its
   line, and a border down the far edge of the bar reads as a column that
   is not there. */
.y-bar__cell.note {
    flex: 1 1 100%;
    min-width: 0;
    border-right: 0;
}

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

/* Prose wraps, and never in the middle of a word unless a word is itself
   wider than the bar — `anywhere` rather than `break-word` because a device
   node or a GStreamer element with no spaces in it is exactly the token a
   failure reason carries, and the guarantee this cell exists to give is that
   *nothing* leaves the bar sideways.

   Not bold and not tabular: this is a sentence, and the reading style would
   make it compete with the numbers beside it. */
.y-bar__v.note {
    white-space: normal;
    overflow-wrap: anywhere;
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-weight: 400;
    font-variant-numeric: normal;
}

/* An identifier is compared character by character, so it is cyan and
   addressable rather than white and read. */
.y-bar__v.id { color: var(--yonder-select, #2ad4f0); }
.y-bar__v.absent { color: var(--yonder-label, #7f8a95); font-weight: 400; }
</style>
