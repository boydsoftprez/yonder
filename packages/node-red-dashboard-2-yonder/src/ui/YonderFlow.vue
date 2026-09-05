<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-flow">
        <span v-if="props.label" class="y-flow__label">{{ props.label }}</span>

        <div class="y-flow__rail">
            <template v-for="(part, i) in parts" :key="i">
                <div v-if="part.kind === 'place'" class="y-flow__node" :class="{ absent: part.absent }">
                    <span class="y-flow__k">{{ part.role }}</span>
                    <span class="y-flow__v">{{ part.label }}</span>
                    <span v-if="part.detail" class="y-flow__d">{{ part.detail }}</span>
                </div>

                <div v-else class="y-flow__leg" :class="{ absent: part.absent }">
                    <span class="y-flow__rate">{{ part.rate }}</span>
                    <!--
                        Two arrows, one shown at a time by CSS rather than by a
                        media query in script: the component cannot know the
                        width it is laid out at, and a resize observer to find
                        out would re-render an instrument on every drag.
                    -->
                    <svg class="y-flow__arrow y-flow__arrow--h" viewBox="0 0 112 12" preserveAspectRatio="none" aria-hidden="true">
                        <line x1="0" y1="6" x2="100" y2="6" /><polygon points="100,1 112,6 100,11" />
                    </svg>
                    <svg class="y-flow__arrow y-flow__arrow--v" viewBox="0 0 12 26" preserveAspectRatio="none" aria-hidden="true">
                        <line x1="6" y1="0" x2="6" y2="18" /><polygon points="1,18 11,18 6,26" />
                    </svg>
                    <span class="y-flow__cap">{{ part.caption }}</span>
                </div>
            </template>
        </div>
    </div>
</template>

<script>
/**
 * Where telemetry comes from, what it passes through, and where it goes
 * (R-MAV-10, R-UI-13).
 *
 * **The only instrument in this set that draws a relationship.** Every other
 * one draws a quantity or a state. What an operator reads off this is not any
 * single value but *which leg is dead*, and that is a reading three separate
 * rows leave them to assemble for themselves.
 *
 * **An absent leg is dashed and grey, never red.** Nothing has failed when
 * telemetry is stopped on purpose, or when no autopilot has been wired yet.
 * Red would be the same lie the path check refuses to tell when it shows a
 * dash for a link nobody attempted.
 *
 * **The three places are always drawn, even when one of them is empty.** A
 * strip that collapsed to whatever is working would answer "where is my
 * telemetry going" with silence in exactly the case an operator is asking.
 * The destination stays on screen when nothing is reaching it, because it is
 * still configured; it simply is not receiving.
 *
 * Drawn from stylesheet and vector rules, never a raster asset, so it follows
 * the palette and scales to any display (R-UI-13). The store is reached
 * through `$store` for the reason `YonderSparkline` records: a bundled vuex
 * would be a second store, and Dashboard puts no `Vuex` global on the page.
 */
export default {
    name: 'YonderFlow',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    computed: {
        payload () {
            const messages = this.$store.state.data.messages
            return (messages && messages[this.id] && messages[this.id].payload) || {}
        },
        /**
         * One flat list of places and legs, so the template is a single loop
         * rather than three hand-placed cells with two hand-placed arrows
         * between them. A missing leg then cannot draw in the wrong gap.
         */
        parts () {
            const p = this.payload
            const place = (role, v) => ({
                kind: 'place',
                role,
                label: (v && v.label) || '—',
                detail: (v && v.detail) || '',
                absent: Boolean(v && v.absent)
            })
            const legs = Array.isArray(p.legs) ? p.legs : []
            const leg = (i) => {
                const l = legs[i] || {}
                return {
                    kind: 'leg',
                    // An em dash, never "0" — a rate nobody measured is not zero.
                    rate: l.rate || '—',
                    caption: l.caption || '',
                    absent: l.absent === undefined ? !l.rate : Boolean(l.absent)
                }
            }
            return [
                place('From', p.from), leg(0),
                place('Through', p.through), leg(1),
                place('To', p.to)
            ]
        }
    },
    created () {
        this.$dataTracker(this.id)
    }
}
</script>

<style scoped>
.y-flow { font-family: var(--yonder-font); }
.y-flow * { box-sizing: border-box; }

.y-flow__label {
    display: block;
    font-family: var(--yonder-font-mono);
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 6px;
}

.y-flow__rail {
    display: grid;
    grid-template-columns: 1fr 112px 1fr 112px 1fr;
    align-items: stretch;
}

.y-flow__node {
    background: var(--yonder-pane, #090d12);
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: var(--yonder-radius, 4px);
    padding: 10px 12px;
    min-height: 76px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    min-width: 0;
}

.y-flow__k {
    font-family: var(--yonder-font-mono);
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
}

/* The place's name is the reading, so it is the larger of the two lines. */
.y-flow__v {
    font-size: 1.0625rem;
    font-weight: 650;
    color: var(--yonder-value, #fff);
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.y-flow__node.absent .y-flow__v { color: var(--yonder-label, #7f8a95); font-weight: 500; }

/* An address is compared character by character, so it never wraps and never
   shrinks — it ellipsises, and the payload is expected to be short enough. */
.y-flow__d {
    font-family: var(--yonder-font-mono);
    font-size: 0.6875rem;
    color: var(--yonder-muted, #7f8a95);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.y-flow__leg {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 4px;
    min-width: 0;
}

.y-flow__rate {
    font-family: var(--yonder-font-mono);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--yonder-value, #fff);
    text-align: center;
    line-height: 1.25;
    max-width: 100%;
    overflow-wrap: anywhere;
}

.y-flow__cap {
    font-family: var(--yonder-font-mono);
    font-size: 0.6875rem;
    color: var(--yonder-muted, #7f8a95);
    text-align: center;
    line-height: 1.25;
    max-width: 100%;
    overflow-wrap: anywhere;
}

.y-flow__leg.absent .y-flow__rate { color: var(--yonder-label, #7f8a95); font-weight: 400; }

.y-flow__arrow { width: 100%; height: 12px; flex: none; }
.y-flow__arrow line { stroke: var(--yonder-select, #2ad4f0); stroke-width: 2; }
.y-flow__arrow polygon { fill: var(--yonder-select, #2ad4f0); }
.y-flow__leg.absent .y-flow__arrow line { stroke: var(--yonder-divider, #2b333c); stroke-dasharray: 4 4; }
.y-flow__leg.absent .y-flow__arrow polygon { fill: var(--yonder-divider, #2b333c); }

.y-flow__arrow--v { display: none; }

/* Narrower than a laptop the strip stands up: one column, arrows pointing
   down. Not a second design — the same three places in the same order. */
@media (max-width: 1023px) {
    .y-flow__rail { grid-template-columns: 1fr; }
    .y-flow__node { min-height: 0; }
    .y-flow__leg { flex-direction: row; justify-content: flex-start; gap: 12px; padding: 6px 0 6px 20px; }
    .y-flow__rate, .y-flow__cap { text-align: left; }
    .y-flow__arrow--h { display: none; }
    .y-flow__arrow--v { display: block; width: 12px; height: 26px; }
}
</style>
