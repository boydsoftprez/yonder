<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-strip">
        <button
            v-for="cam in cameras"
            :key="cam.id"
            type="button"
            class="y-strip__thumb"
            :class="{ on: cam.active }"
            :title="[cam.name, cam.caption].filter(Boolean).join(' · ')"
            @click="$emit('go', cam.id)"
        >
            <span class="y-strip__img" :style="cam.thumbSrc ? { backgroundImage: 'url(' + cam.thumbSrc + ')' } : {}" aria-hidden="true" />
            <span class="y-strip__cap">{{ cam.caption || (cam.active ? 'Live' : ('Still · ' + (cam.ageSeconds ?? 0) + ' s')) }}</span>
            <span v-if="cam.thumbSrc && Number.isFinite(cam.ageSeconds) && cam.ageSeconds >= 0" class="y-strip__age">{{ cam.ageSeconds }} s ago</span>
            <span v-if="cam.name" class="y-strip__name">{{ cam.name }}</span>
        </button>
        <div v-if="downlink" class="y-strip__dl">Downlink now <b class="y-strip__dl-v">{{ downlink }}</b></div>
    </div>
</template>

<script>
/**
 * The other cameras as stills, and the cost (§6, R-UI-03, R-VID-14).
 *
 * **One thumb per camera, always — the active one included, not omitted.**
 * §6's own table describes this strip as showing "the others as stills",
 * but the coordinator's own resolution corrects that in person (task-19-
 * brief.md §6): "one thumb per camera; the active one marked and reading
 * `Live`". Every camera keeps a fixed position in the strip whichever one
 * is currently on the main picture, so an operator counting cameras never
 * has to notice one is briefly missing because it happens to be the one
 * already in view.
 *
 * **Draws what it is given and decides nothing.** `ageSeconds` is R-VID-
 * 14's own frame age, computed wherever the stills mechanism already
 * computes it (§8.6) — this component only chooses the words around it
 * (`Still · 4 s`), never the number itself.
 *
 * **A press emits the camera's own id, never its position in the array.**
 * `cameras` is drawn in whatever order its caller hands it, and a caller
 * is free to reorder or filter that array between renders (a camera
 * detected later, one temporarily rejected — R-CAM-12); an id survives
 * that and an array index does not. `pick(cam)` closes over the whole
 * camera object precisely so nothing here ever has to reach for `index`
 * at all.
 *
 * **`Downlink now` is the measured path total, never a sum this component
 * reconstructs.** §8.2: "actual traffic per output/subscriber on each
 * path … including other viewers and thumbnail stills, not the sum of two
 * encoder targets." Every still this strip shows for every non-active
 * camera is itself part of that total (§8.6, "count every transmitted
 * copy in path spend"), and this component has no visibility into the
 * other subscribers or viewers that also share it — so `downlink` arrives
 * pre-measured, exactly the way `YonderStateOverlay`'s own `cost.path`
 * does, and nothing here adds anything to produce it.
 */
export default {
    name: 'YonderThumbStrip',
    props: {
        /** `{ id, name, active, ageSeconds, thumbSrc }` per camera. */
        cameras: { type: Array, default: () => [] },
        downlink: { type: String, default: '' }
    },
    emits: ['go']
}
</script>

<style scoped>
.y-strip__age { display: block; grid-column: 2; grid-row: 3; font-size: 10px; color: var(--yonder-label, #7f8a95); }
.y-strip {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-strip__thumb {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    grid-template-rows: 14px 16px 14px;
    align-items: center;
    gap: 1px 8px;
    width: 216px;
    height: 56px;
    flex: 0 0 216px;
    box-sizing: border-box;
    text-align: left;
    padding: 4px;
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 3px;
    background: var(--yonder-track, #161b21);
    cursor: pointer;
    font: inherit;
    color: var(--yonder-label, #7f8a95);
}
.y-strip__thumb.on { border-color: var(--yonder-select, #2ad4f0); }
.y-strip__img {
    grid-column: 1;
    grid-row: 1 / 4;
    width: 64px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 2px;
    background-color: var(--yonder-display, #04060a);
    background-size: cover;
    background-position: center;
}
.y-strip__cap {
    grid-column: 2;
    grid-row: 1;
    font-size: 9.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-strip__thumb.on .y-strip__cap { color: var(--yonder-select, #2ad4f0); font-weight: 700; }
.y-strip__name {
    grid-column: 2;
    grid-row: 2;
    font-size: 10px;
    font-weight: 600;
    color: var(--yonder-value, #ffffff);
}
.y-strip__cap, .y-strip__name, .y-strip__age {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.y-strip__dl {
    margin-left: auto;
    align-self: center;
    flex: 0 0 auto;
    max-width: 280px;
    min-width: 160px;
    line-height: 1.4;
    font-size: 10.5px;
    color: var(--yonder-label, #7f8a95);
}
/* Never uppercased: a bare `Mb/s` in `downlink` would read `MB/S`
   (CLAUDE.md, project-wide; first stated on `YonderReadout`). This
   component has no ambient uppercase rule of its own to fight, unlike
   `YonderPlacard`'s, but the exemption is declared here too rather than
   relying on that happening to remain true. */
.y-strip__dl-v {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    text-transform: none;
    color: var(--yonder-value, #ffffff);
}
</style>
