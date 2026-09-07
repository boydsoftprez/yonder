<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-strip">
        <button
            v-for="cam in cameras"
            :key="cam.id"
            type="button"
            class="y-strip__thumb"
            :class="{ on: cam.active }"
            @click="$emit('go', cam.id)"
        >
            <span class="y-strip__img" :class="{ 'is-empty': !cam.thumbSrc }" :style="cam.thumbSrc ? { backgroundImage: 'url(' + cam.thumbSrc + ')' } : {}" />
            <span class="y-strip__cap" :class="{ 'is-stopped': cam.stopped }">{{ captionOf(cam) }}</span>
            <span v-if="cam.name" class="y-strip__name">{{ cam.name }}</span>
        </button>
        <!-- L-22: `OTHER CAMERAS` over what every still copy is costing, in the
             daemon's own words, to the right of the thumbnails. -->
        <div v-if="downlink" class="y-strip__dl">
            <em class="y-strip__dl-h">OTHER CAMERAS</em>
            <b class="y-strip__dl-v">{{ downlink }}</b>
        </div>
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
 * (`Still · 4 s`), never the number itself. Two more words, both about a
 * camera that has no frame to show: `Stopped` for one with no pipeline
 * (`stopped`), drawn as stopped and never as a stale frame, and `Still ·
 * waiting` for one that is running and whose first still has not been
 * taken yet (`ageSeconds` null) — a wait of at most one interval, which is
 * a different fact from a camera to start.
 *
 * **A press emits the camera's own id, never its position in the array.**
 * `cameras` is drawn in whatever order its caller hands it, and a caller
 * is free to reorder or filter that array between renders (a camera
 * detected later, one temporarily rejected — R-CAM-12); an id survives
 * that and an array index does not. `pick(cam)` closes over the whole
 * camera object precisely so nothing here ever has to reach for `index`
 * at all.
 *
 * **`OTHER CAMERAS` over `downlink`** (blueprint L-22), and `downlink` is a
 * sentence the daemon composed — `12 kb/s of stills · counted in Path
 * total` — never a sum this component reconstructs. §8.2: "actual traffic
 * per output/subscriber on each path … including other viewers and
 * thumbnail stills, not the sum of two encoder targets." Every still this
 * strip shows for every non-active camera is itself part of the path total
 * (§8.6, "count every transmitted copy in path spend"), and this component
 * has no visibility into the other subscribers or viewers that also share
 * it — so `downlink` arrives pre-composed, exactly the way
 * `YonderStateOverlay`'s own `cost.path` does, and nothing here adds
 * anything to produce it. The heading is written in capitals in the
 * template rather than uppercased by a stylesheet, so what a test reads
 * through `.text()` is what is on screen.
 */
export default {
    name: 'YonderThumbStrip',
    props: {
        /** `{ id, name, active, ageSeconds, thumbSrc, stopped }` per camera —
         * `video/present.ts`'s own `ThumbRow`. */
        cameras: { type: Array, default: () => [] },
        downlink: { type: String, default: '' }
    },
    emits: ['go'],
    methods: {
        /** The word under a thumbnail — see this component's doc comment. */
        captionOf (cam) {
            if (cam.active) return 'Live'
            if (cam.stopped) return 'Stopped'
            if (cam.ageSeconds === null || cam.ageSeconds === undefined) return 'Still · waiting'
            return 'Still · ' + cam.ageSeconds + ' s'
        }
    }
}
</script>

<style scoped>
.y-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
    font-family: var(--yonder-font, system-ui, sans-serif);
}
.y-strip__thumb {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 84px;
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
    width: 100%;
    height: 46px;
    border-radius: 2px;
    background-color: var(--yonder-display, #04060a);
    background-size: cover;
    background-position: center;
}
.y-strip__cap {
    font-size: 9.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    color: var(--yonder-label, #7f8a95);
}
.y-strip__thumb.on .y-strip__cap { color: var(--yonder-select, #2ad4f0); font-weight: 700; }
.y-strip__cap.is-stopped { color: var(--yonder-neutral, #7d7869); }
/* A thumbnail with nothing to show keeps its box, so the strip does not
   reflow when a frame arrives or a camera stops. */
.y-strip__img.is-empty { opacity: 0.6; }
.y-strip__name {
    font-size: 10px;
    font-weight: 600;
    color: var(--yonder-value, #ffffff);
}
.y-strip__dl {
    margin-left: auto;
    align-self: center;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 10.5px;
    color: var(--yonder-label, #7f8a95);
}
.y-strip__dl-h {
    font-style: normal;
    font-size: 9.5px;
    letter-spacing: 0.1em;
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
