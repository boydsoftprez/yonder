<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div v-if="kind || name" class="y-plc">
        <span v-if="kind" class="y-plc__kind">{{ kind }}</span>
        <span v-if="kind && name" class="y-plc__sep" aria-hidden="true">&middot;</span>
        <span v-if="name" class="y-plc__name">{{ name }}<template v-if="unit">{{ ' ' }}<i class="y-plc__u">{{ unit }}</i></template></span>
    </div>
</template>

<script>
/**
 * The nameplate at the top of a camera page — `CAMERA · CAM 2`,
 * `ACCESSORY · H.264 · 1280×720p30` (§6).
 *
 * **One generic plate, used twice, not one component drawing two facts at
 * once.** Both of §6's own worked examples share the shape `KIND · VALUE`,
 * so this is `kind`/`name` — the same "one part, reused across call
 * sites" idiom `YonderColumn` already uses for its own right-hand
 * qualifier (`to the ground station`, `rate control`). A camera page names
 * the camera with one instance (`kind: 'Camera'`) and states what it is
 * with a second (`kind: 'Accessory'`, `name` carrying the encoding
 * descriptor) rather than asking one template to know about both at once.
 *
 * **ADR-0009 draws every placard in letterspaced capitals, and a unit
 * inside `name` must not be one of them — declared explicitly, not
 * trusted to absence.** This is the same rule stated first on
 * `YonderReadout` and stated again on `YonderSetBar`: `Mb/s` uppercased by
 * an ambient `text-transform` reads `MB/S`, which says megabytes rather
 * than megabits — a different, wrong unit, not a cosmetic slip. Two
 * instances of the identical mistake in this same library is not a
 * coincidence worth risking a third time on inheritance, so `.y-plc__u`
 * resets `text-transform: none` on its own element rather than counting on
 * nothing above it ever setting one.
 *
 * **Draws no wrapper at all when it names neither a kind nor a value** —
 * the same silence an empty legend already draws on `YonderColumn`, and
 * `state: 'not-offered'` already draws on `YonderPicker`, `YonderSegmented`
 * and `YonderSetBar` (R-UI-20's own reasoning): a placard with nothing on
 * it is not a placard with a blank engraving, any more than an absent
 * camera is a camera with nothing plugged in.
 */
export default {
    name: 'YonderPlacard',
    props: {
        kind: { type: String, default: '' },
        name: { type: String, default: '' },
        unit: { type: String, default: '' }
    }
}
</script>

<style scoped>
.y-plc {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--yonder-value, #ffffff);
}
.y-plc__kind { color: var(--yonder-label, #7f8a95); }
.y-plc__sep { color: var(--yonder-divider, #2b333c); }
/* A token carrying a unit is never uppercased: `Mb/s`, not `MB/S` — that
   reads as megabytes (CLAUDE.md, project-wide; the same rule
   `YonderReadout` and `YonderSetBar` each state on their own unit
   element). Stated here explicitly so it wins regardless of what this
   component's own ambient `text-transform: uppercase` above would
   otherwise hand it. */
.y-plc__u {
    font-style: normal;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0.02em;
    color: var(--yonder-label, #7f8a95);
}
</style>
