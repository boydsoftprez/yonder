# The camera in the flight display implementation plan

> **Execution:** run with `crew` (`/crew docs/superpowers/plans/2026-09-11-flight-camera-in-pfd.md`)
> under `yonder-cost-aware-execution`. Requirements and acceptance cases are binding; test
> order and review effort follow Yonder's risk-based policy; console evidence follows
> `yonder-page-verification`. No review between tasks; one whole-branch review at the end.

**Goal:** the selected camera's configured preview fills the Flight page's attitude scene
with the instruments over it, and the same picture has a movable, resizable window form
over synthetic terrain, switched by one control in the cockpit's top row.

**Architecture:** `YonderPicture` gains a scene presentation that renders its video frame
alone. `YonderCockpit` stops unmounting `TerrainVision` when a camera is chosen and
instead tells it whether to paint, so height above ground and the clearance forecast keep
reporting behind the picture. A `cameraView` preference joins the existing PFD display
preferences and drives both the background slot and a new window that is a peer of the
mission and map insets.

**Tech Stack:** Vue 3 options API in `packages/node-red-dashboard-2-yonder`, Vitest with
`@vue/test-utils` for component tests, plain CSS in `src/ui/cockpit/*.css`, Playwright for
the cockpit guide captures, `scripts/verify-pages.sh` for the page gate.

**Spec:** [the camera in the flight display](../specs/2026-09-11-flight-camera-in-pfd-design.md).
Every decision is settled there; this is how it gets built.

## Global Constraints

- Logic and presentation live in `packages/`; `flows/` is wiring only; no `function` node.
- Every change traces to an `R-*` ID. This plan implements **R-FLT-29**, already added to
  `docs/requirements.md`. R-FLT-27 and R-FLT-28 belong to the onboard terrain service; do
  not use them.
- Yonder relays commands and never originates one (R-CMD-04, R-CMD-05). Nothing in this
  plan starts or stops a stream, changes device configuration, or sends a flight command.
- Every source file carries `// SPDX-License-Identifier: GPL-3.0-or-later` (or the
  `<!-- ... -->` form in a `.vue` file), as its neighbours do.
- A node without tests is not merged. `npm test` and `npm run lint` pass on the finished
  revision, from the repository root.
- Commits are GPG-signed with DCO sign-off. Never `--no-gpg-sign`.
- The picture's four stale signals (desaturation, darkening, hatch, a running count) are
  load-bearing under R-VID-03 and survive every presentation change.
- The PFD consumes the camera's **configured preview** and never requests a different
  stream (R-VID-13). No picture-quality control is added to the Flight page.
- Browser presentation state persists in `localStorage` only. It never reaches the daemon,
  `config.yaml` or a flow.
- The window holds the camera and only the camera. Registered terrain is never drawn
  inside it, and no terrain thumbnail is built: the spec rejected both, because the height
  readout and the clearance forecast already carry what a thumbnail would imply.
- Only one `scripts/verify-pages.sh` runs at a time. Before starting one,
  `pgrep -fl 'verify-pages.sh|yonder-pages|dist/daemon/server.js'` must print nothing.

## What already exists

- `packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue` — the live picture. Its
  template is one `.y-pic` grid: a `.y-pic__toolbar` header, `.y-pic__fit` containing
  `.y-pic__frame` (the video, the stills image, the hatch, the flash, the aim orb, the
  off/stopped notices), then `.y-pic__capture-host`, `.y-pic__notices` and
  `.y-pic__thumbnails`. It injects `$socket` and `$dataTracker` (line 563) and calls
  `this.$dataTracker(this.id)` on mount (line 998). CSS for `.y-pic`, `.y-pic__fit`,
  `.y-pic__frame` and `.y-pic__video` is at lines 1741-1830, above a long comment
  recording three sizing attempts that failed.
- `src/ui/YonderCockpit.vue` — the Flight host. Its `#background` slot (lines 63-110)
  today wraps `TerrainVision` in `<template v-if="background==='terrain'">` and the
  picture in `<template v-else-if="cameraPath">`, so **choosing a camera unmounts the
  terrain component**. `cameraProps` (line 891) builds the picture's props. The cockpit
  chrome's `nav.cockpit-utilities` (lines 23-29) holds Flight plan, Display, Aircraft,
  the full-screen button and Menu.
- `src/ui/cockpit/TerrainVision.vue` — synthetic vision. One `requestAnimationFrame` loop,
  `animate` (line 884), does everything: tile loading, `clearance.value` (line 963),
  `forecast` (lines 964-991), the `status` emit (line 617), and finally one paint call,
  `if (drawDue(time)) renderer.draw(props.displayPose || pose, origin, props.viewport)`
  (about line 1000). Early returns sit before the evaluation: no pose (913), graphics
  unavailable (917), renderer creation failure (921), no origin (944).
- `src/ui/cockpit/PrimaryFlightDisplay.vue` — the PFD. `terrainReady` is
  `props.backgroundReady === true` (line 295). The `.pfd-horizon` group (lines 24-28)
  draws a sky rect, an earth rect and a white line, all at `:opacity="terrainReady?0:1"`.
  The background slot is at line 9, inside `.pfd-instrument-canvas`.
- `src/ui/cockpit/pfd-controls.mjs` — `displayDefaults` and `validatePfdPreferences`
  (line 76). `YonderCockpit.persist()` (line 1154) writes the whole `preferences` object
  to `localStorage` under `yonder-cockpit-v1`; `mounted` reads it back (line 1024).
- `src/ui/cockpit/cockpit.css` — `.cockpit-body` is `position: relative` (line 95). The
  mission and map insets are absolutely positioned against it at `z-index: 5` (lines
  216-240). `.cockpit-background` is `z-index: 0` with a `linear-gradient` (line 178).
  `.cockpit-forecast` occupies the top-left corner at `z-index: 6` (line 893).
- `packages/node-red-dashboard-2-yonder/cockpit/` — the fixture harness. `fixture.mjs`
  builds the synthetic snapshot, `guide.mjs` and `layout-guide.mjs` drive the production
  widget with Playwright and write captures into `.cockpit-artifacts/guide/`.
  `layout-guide.mjs` already sets tablet viewports (line 50).
- `docs/images/cockpit/` — committed guide images, each with a README row and a
  `manifest.json` entry carrying `file`, `source`, `sha256` and `bytes`.
- `scripts/verify-pages.sh` — the page gate. Its main sweep already captures the `flight`
  page in both palettes with `--synthetic-cameras`, but the PFD's default background is
  terrain, so no camera has ever appeared in a gate capture.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/node-red-dashboard-2-yonder/src/ui/cockpit/CameraWindow.vue` | The movable, resizable camera window: header with label, stale age and maximize control; the picture in scene presentation; a corner resize grip. Emits geometry and maximize; owns no state. |
| `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-view.mjs` | Pure helpers: `cameraViewSettings` validation, `clampCameraWindow`, the home geometry constant. No DOM. |
| `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-view.test.ts` | Unit tests for the helpers. |
| `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-scene.component.test.ts` | Component tests for Task 1: the fill, the chrome absence, the horizon line, terrain evaluation without drawing. |
| `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-window.component.test.ts` | Component tests for Task 2: the window, the toggle, persistence, unavailable and stale states. |

**Modify**

| Path | Change |
|---|---|
| `src/ui/YonderPicture.vue` | Add a `scene` prop. When set, render only `.y-pic__fit`/`.y-pic__frame` and give the frame a cover fit; expose the stale age to the host. |
| `src/ui/YonderCockpit.vue` | Keep `TerrainVision` mounted whenever terrain is enabled and pass `draw`; render the picture in scene presentation; add the Camera button to `nav.cockpit-utilities`; own `cameraView` and the window's geometry; mount `CameraWindow`. |
| `src/ui/cockpit/TerrainVision.vue` | Add a `draw` prop that gates only the `renderer.draw(...)` call. |
| `src/ui/cockpit/PrimaryFlightDisplay.vue` | Add a `horizonLine` option: with a camera background, draw the attitude line without the sky and earth fills. |
| `src/ui/cockpit/pfd-controls.mjs` | Add `cameraView`, `cameraWindow` and `horizonLine` to `displayDefaults` and validate them in `validatePfdPreferences`. |
| `src/ui/cockpit/PfdControlPanel.vue` | Add the horizon-line switch and a reset for the window's position. |
| `src/ui/cockpit/cockpit.css` | The dark background behind a camera; the camera window; the Camera button; the footer's camera label. |
| `packages/node-red-dashboard-2-yonder/cockpit/guide.mjs` | Add a camera walkthrough group that captures both states in both palettes and at tablet size. |
| `packages/node-red-dashboard-2-yonder/cockpit/fixture.mjs` | Seed a synthetic camera with a stills frame so the harness can show a picture. |
| `docs/images/cockpit/README.md`, `docs/images/cockpit/manifest.json` | Rows and entries for the new guide captures. |
| `docs/cockpit-user-guide.md` | A step for the Camera button and the two states; correct the camera-unavailable troubleshooting row. |
| `docs/console/design/blueprint-manifest.md` | Move F-31 to F-34 from "not yet built" to their implementations and evidence. |
| `docs/known-issues.md` | Close K-68 with what was built and the evidence that closed it. |

## Task 1: The camera fills the attitude scene

**Requirements:** R-FLT-29, R-FLT-01, R-FLT-08, R-VID-03, R-VID-13, R-CMD-04. Closes the
first half of K-68. No new requirement in this task.

**Files:**
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue` (add the `scene`
  prop and its presentation; expose the stale age)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderCockpit.vue` (keep
  `TerrainVision` mounted; render the picture in scene presentation; pass `horizonLine`)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/TerrainVision.vue` (the
  `draw` prop)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/PrimaryFlightDisplay.vue`
  (the horizon-line option)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/pfd-controls.mjs`
  (`horizonLine` default and validation)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/PfdControlPanel.vue` (the
  horizon-line switch)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/cockpit.css` (the dark
  background behind a camera; the footer's camera label)
- Modify: `packages/node-red-dashboard-2-yonder/cockpit/fixture.mjs` (a synthetic camera
  with a stills frame)
- Test: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-scene.component.test.ts`

**Interfaces:**

- Consumes: nothing from another task.
- Produces, for Task 2:
  - `YonderPicture` prop `scene: Boolean` (default `false`), declared as a fourth entry in
    the component's existing `props` **object** (`id`, `props`, `state` at lines 564-568) —
    it is not an array, and `scene` is a sibling of those three, not a key inside the
    nested `props` object. When true the component renders only `.y-pic__fit` containing
    `.y-pic__frame`; the toolbar, the capture host, the notices and the thumbnail strip are
    not rendered. The frame fills its parent and the video uses `object-fit: cover`.
    Session, transport, reconnect, the stills fallback, the adaptive report and the four
    stale signals are unchanged.
  - `YonderPicture` emits `stale` with `{ seconds: number, text: string }` whenever its
    staleness changes, carrying the component's existing computeds unchanged: `seconds` is
    `staleFor` (lines 761-764 — whole seconds since the last frame, less a two-second
    grace, and **`0`, not null, when the picture is live**) and `text` is `ageText` (lines
    792-795 — `"3 s ago"`, `"1 min 0 s ago"`). Do not invent a parallel convention; a host
    shows `text` when `seconds` is greater than zero.
  - `TerrainVision` prop `draw: Boolean` (default `true`). When false the component paints
    nothing, its canvas shows nothing, and everything else it does is unchanged, including
    the `status` emit and the `estimatedAglM`, `groundElevationM` and `forecast` it
    carries. `data-terrain-ready` keeps reporting readiness in both modes, because terrain
    is still being evaluated and a CSS rule in `cockpit.css` keys off it.
  - `PrimaryFlightDisplay` option `horizonLine: Boolean` in its `options` object. When the
    background is a camera (`backgroundReady` true and the host says the background is not
    terrain), the `.pfd-horizon` group draws its white line at full opacity and omits the
    sky and earth fills. Over terrain, nothing changes.
  - `displayDefaults.horizonLine === true` in `pfd-controls.mjs`, validated as a boolean
    by `validatePfdPreferences` in the same list as `pitchLadder`.

**Acceptance:**

1. Mounting `YonderPicture` with `scene: true` renders no `.y-pic__toolbar`,
   `.y-pic__capture-host`, `.y-pic__notices` or `.y-pic__thumbnails`, and does render
   `.y-pic__frame` and its `video.y-pic__video`. With `scene` absent or false, all of them
   render exactly as today.
2. With `scene: true`, `getComputedStyle` reports `.y-pic__fit` and `.y-pic__frame` as
   `position: absolute` with all four insets `0px` and `aspect-ratio: auto`, and
   `.y-pic__video` as `object-fit: cover`. With `scene` false the same lookups report
   today's values, including the frame's `aspect-ratio`. (jsdom performs no layout, so
   this asserts the rules that produce the fill, not a measured box; the measured fill is
   evidenced by Task 2's guide capture in a real browser. `css: true` in
   `vitest.config.ts` is what makes these lookups meaningful.)
3. With `scene: true` and the picture stale, `.y-pic__hatch` is present, the video's
   `filter` style is the degrade filter, and a `stale` event has been emitted whose
   `seconds` is a positive whole number. With the picture live, the last emitted `stale`
   carries `seconds: 0`.
4. Mounted directly with the harness `terrain-performance.component.test.ts` already
   uses — fake timers, a stubbed `requestAnimationFrame` stepper, a Proxy fake WebGL
   context from a stubbed `HTMLCanvasElement.prototype.getContext`, and a mocked
   `loadTerrainPack` resolving a pack with `groundSampler` and `sampleBoth` —
   `TerrainVision` with `draw: false` never calls the context's `clear` across 120
   stepped frames, while its last emitted `status` still carries a finite `estimatedAglM`
   and a non-null `forecast`. The same mount with `draw: true` calls `clear` at the
   existing cadence and emits the same `estimatedAglM`.
5. Painting terrain, then setting `draw: false`, leaves no fossil: the canvas's computed
   `visibility` is `hidden` while `draw` is false, and the component's
   `data-terrain-ready` attribute still reads `true`. Setting `draw` back to `true` makes
   the canvas visible again and calls `clear` on the next stepped frame. (Without this the
   canvas keeps whatever was last rasterized: `gl.clear` runs only inside `draw()` at line
   452, and the canvas's visibility binds to the same `visible` ref that `status()` sets
   true whenever terrain is ready, line 619. A camera that then failed to stream would
   show the unavailable banner over a frozen terrain image that reads as live.)
6. In `YonderCockpit` with a camera selected and terrain enabled, the `TerrainVision`
   component is still present in the component tree and receives `draw: false`; with
   terrain as the background it receives `draw: true`. (This is the host-level half of
   case 4: choosing a camera today unmounts it, which is the regression this task exists
   to prevent. Most host tests stub `TerrainVision`, and a stub is enough here: the
   assertion is on the prop it was handed, not on what it did with it.)
7. In `YonderCockpit` with a camera selected, `.cockpit-background` has no
   `linear-gradient`, and the PFD's sky and earth rects are at opacity 0 while the white
   horizon line is at full opacity. Turning `horizonLine` off hides the line and leaves
   the fills hidden. With terrain as the background, the line stays hidden as today.
8. `validatePfdPreferences({display:{horizonLine:false}}).display.horizonLine` is `false`;
   `validatePfdPreferences({display:{horizonLine:'no'}}).display.horizonLine` is `true`
   (the default), and an absent key gives `true`.
9. The Camera page and the Cockpit page are unaffected: mounting `YonderPicture` without
   `scene` produces the same DOM as before this task, asserted by the existing
   `picture.component.test.ts` suite passing unchanged — in particular its slot-height
   test (about line 1563, which asserts `.y-pic`'s `gridTemplateRows` and `.y-pic__fit`'s
   `containerType`) and its overlay-ordering test (about line 1619, which asserts
   `.y-pic__hud`, `.y-pic__state`, `.y-pic__rec`, `.y-pic__foot` and `.y-pic__osd` are
   present). Both assert today's presentation and must keep passing untouched.
10. Scene mode gets the counterparts those two tests lack: with `scene: true`,
   `.y-pic`'s `gridTemplateRows` is a single track, and `.y-pic__hud`, `.y-pic__state`,
   `.y-pic__rec`, `.y-pic__foot`, `.y-pic__osd`, `.y-pic__capture-host`,
   `.y-pic__notices` and `.y-pic__thumbnails` are all absent from the DOM.
11. None of the above calls the fixture's command collector: `window.cockpitFixture.calls`
   stays empty, matching the existing "does not send" pattern in
   `flight-host.component.test.ts`.

**Verification:** ordinary feature with one load-bearing invariant (terrain evaluation
must survive), so: test the new behaviour, and write acceptance cases **6 then 4 first**,
in that order. Case 6 is the actual regression — today the host unmounts the terrain
component the moment a camera is chosen — and case 4 is the new split it depends on. Layer: unit and component tests on this
machine. Commands, from the repository root:

```
npm test -w node-red-dashboard-2-yonder
npm run lint
```

Focused iteration may use `npx vitest run camera-scene` inside the package. No console
gate in this task; Task 2 carries the console evidence, because a half-built state is not
worth six minutes of gate. No hardware evidence in this task.

**Execution note (advisory):** sonnet. No prerequisite. Not parallelisable with Task 2,
which modifies the same three files.

- [ ] **Step 1:** Write `camera-scene.component.test.ts` with acceptance case 6 as its
      first test, mounting `YonderCockpit` from `cockpit/fixture.mjs` the way
      `flight-host.component.test.ts` does, with `global.provide` stubs for `$socket`
      (`{on(){},off(){},emit(){}}`) and `$dataTracker` (`() => {}`) so `YonderPicture`
      mounts. Seed a camera into the fixture snapshot, select the camera background, and
      assert that `TerrainVision` is still in the tree and received `draw: false`. Run it
      and watch it fail, because `YonderCockpit` unmounts `TerrainVision` today. Add
      acceptance case 4 as a second, separate test against `TerrainVision` itself, copying
      the fake-GL and frame-stepper `setup()` from `terrain-performance.component.test.ts`
      rather than reinventing it.
- [ ] **Step 2:** In `TerrainVision.vue` add `"draw"` to the props array and change the
      single paint call in `animate` from
      `if (drawDue(time)) renderer.draw(props.displayPose || pose, origin, props.viewport);`
      to `if (props.draw !== false && drawDue(time)) renderer.draw(props.displayPose || pose, origin, props.viewport);`.
      Change nothing else in that loop: the early returns at "Waiting for fresh GPS"
      (~913), "Graphics unavailable" (~917), the renderer creation (~921) and `!origin`
      (~944) all stay, so evaluation keeps the same preconditions it has today and this
      task adds no new failure mode. Record in a comment beside the change that the
      renderer is still created when `draw` is false, deliberately, so the terrain view
      resumes instantly and the evaluation path is identical in both modes.
      Then change the canvas's visibility binding on template line 15 from
      `visible ? 'visible' : 'hidden'` so it is also hidden whenever `draw` is false, and
      say in the same comment why: `gl.clear` runs only inside `draw()` (line 452) and
      `status()` sets `visible` true whenever terrain is ready (line 619), so a canvas left
      visible with painting stopped holds the last frame it drew for as long as the camera
      is up. Leave `data-terrain-ready` bound to `visible` alone: it reports whether
      terrain is being evaluated, which is still true, and `cockpit.css` keys a background
      rule off it.
- [ ] **Step 3:** In `YonderCockpit.vue`'s `#background` slot, restructure so the terrain
      component is mounted whenever `onlineTerrain` is true regardless of `background`,
      with `:draw="background==='terrain'"`, and the picture is mounted whenever
      `cameraPath` is non-empty and `background !== 'terrain'`. Keep the existing
      `terrain` named slot contract for hosts that override it. The picture renders after
      the terrain component in DOM order so it covers it; give `.cockpit-camera`
      `position: absolute; inset: 0` in `cockpit.css` and keep the terrain canvas at its
      existing position. Verify step 1's test now passes.
- [ ] **Step 4:** Add the `scene` prop to `YonderPicture.vue`. Wrap the toolbar, the
      capture host, the notices and the thumbnail strip in `v-if="!scene"`. Add a
      `scene` class binding on `.y-pic`. Collapsing the grid is not optional: `.y-pic`'s
      four tracks are `auto minmax(0,1fr) minmax(34px,auto) minmax(80px,max-content)`, so
      leaving them while the elements are gone still reserves at least 114 px for the two
      bottom tracks, stealing it from the frame's `1fr` row and shrinking the `100cqh` the
      frame sizes against. Dropping the capture host is safe because `YonderDeck` teleports
      into `#nrdb-page-page-camera .y-pic__capture-host` (`YonderDeck.vue:367`), a selector
      scoped to the Camera page, which never renders in scene mode. In the component's CSS
      add a `.y-pic.scene` block that sets the grid to one row, makes `.y-pic__fit` `position:absolute;inset:0`
      with `container-type: normal`, makes `.y-pic__frame` `position:absolute;inset:0`
      with `width:auto;height:auto;max-width:none;max-height:none;aspect-ratio:auto`, and
      sets `.y-pic__video { object-fit: cover }`. Extend the file's existing sizing
      comment with a fourth paragraph: the scene presentation is the one case where the
      picture is told its box by the page rather than taking its own shape, because the
      attitude scene is the subject and a letterboxed box reads as an inset; `cover`
      rather than `contain` is what makes that true, and it crops rather than distorts.
- [ ] **Step 5:** In `YonderPicture.vue` emit `stale` from the same place that updates
      `staleFor`, carrying `{ seconds, text }` as specified above, and declare it in
      `emits`. Do not remove the toolbar's own age display; the scene presentation simply
      does not render the toolbar.
- [ ] **Step 6:** In `PrimaryFlightDisplay.vue` add a `cameraBackground` prop (boolean,
      set by the host when the background is a camera) and change the `.pfd-horizon`
      group so the two fill rects carry `:opacity="terrainReady||cameraBackground?0:1"`
      and the white line carries `:opacity="cameraBackground ? (options.horizonLine===false?0:1) : (terrainReady?0:1)"`.
      Leave the dark backing rect at line 22 as it is. Pass `cameraBackground` from
      `YonderCockpit.vue`.
- [ ] **Step 7:** Add `horizonLine: true` to `displayDefaults` in `pfd-controls.mjs` and
      add `'horizonLine'` to the boolean key list in `validatePfdPreferences`. Add the
      switch to `PfdControlPanel.vue` beside the pitch-ladder switch, reading
      `<label class="pfd-option"><span>Horizon line over camera<small>Attitude line drawn on the picture</small></span><input type="checkbox" aria-label="Horizon line over camera" :checked="options.horizonLine!==false" @change="$emit('option','horizonLine',$event.target.checked)"></label>`.
- [ ] **Step 8:** In `cockpit.css`, remove the `linear-gradient` from `.cockpit-background`
      and give it the display's dark ground colour, keeping the existing
      `:has(.terrain-vision[data-terrain-ready="false"])` rule. Add the
      `.cockpit-camera { position:absolute; inset:0 }` rule from step 3. Add a
      `.display-foot .foot-camera` rule for the footer's camera label so the label can
      carry the stale age without changing the footer's height.
- [ ] **Step 9:** In `cockpit/fixture.mjs`, seed `cameras` and `camera` on the snapshot
      with a synthetic camera (`id: 'cam0'`, `name: 'SeekerHD'`, `path: 'cam0-preview'`,
      `detected: true`, `calibration: null`, `frameCaptureMs: null`, `poseTimeMs: null`,
      `registration: { ready: false, reason: 'Camera lens/mount calibration and capture-time alignment have not been verified' }`)
      and a small embedded `stillsUrl` data URI so the harness and the guide can show a
      picture without a stream. Keep the existing default background as terrain so no
      committed capture changes in this task.
- [ ] **Step 10:** Write the remaining acceptance cases 1, 2, 3, 5, 7, 8, 9, 10 and 11 as
      tests and make them pass. Case 5 extends the fake-GL harness from step 1's second
      test rather than starting a new one. Then run `npm test -w node-red-dashboard-2-yonder` and
      `npm run lint` from the repository root and record both results.

## Task 2: The camera window and the Camera button

**Requirements:** R-FLT-29, R-FLT-25 (the cockpit's single responsive control row, where the Camera button lives), R-VID-03, R-CMD-04. Closes the second half
of K-68. No new requirement in this task.

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/CameraWindow.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-view.mjs`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-view.test.ts`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/cockpit/camera-window.component.test.ts`
- Modify: `src/ui/YonderCockpit.vue` (own `cameraView`, mount the window, add the button)
- Modify: `src/ui/cockpit/pfd-controls.mjs` (`cameraView`, `cameraWindow` defaults and
  validation)
- Modify: `src/ui/cockpit/PfdControlPanel.vue` (reset the window's position)
- Modify: `src/ui/cockpit/cockpit.css` (the window, the button)
- Modify: `packages/node-red-dashboard-2-yonder/cockpit/guide.mjs` (the camera captures)
- Modify: `docs/images/cockpit/README.md`, `docs/images/cockpit/manifest.json`
- Modify: `docs/cockpit-user-guide.md`
- Modify: `docs/console/design/blueprint-manifest.md`, `docs/known-issues.md`

**Interfaces:**

- Consumes, from Task 1: `YonderPicture`'s `scene` prop and its `stale` event;
  `TerrainVision`'s `draw` prop; `PrimaryFlightDisplay`'s `cameraBackground` prop and
  `options.horizonLine`; the synthetic camera in `cockpit/fixture.mjs`.
- Produces:
  - `camera-view.mjs` exports
    `export const cameraWindowHome = Object.freeze({ x: 0.13, y: 0.12, w: 0.17 })` —
    fractions of `.cockpit-body`'s box: left edge, top edge and width. The width is about
    one sixth of the box, as the spec asks. These are the geometry of the approved render
    `docs/console/design/instrument-library/flight.camera.window.night.png`, measured from
    it: at 1440x900 they place the window's left edge about 29 px right of the airspeed
    tape and its top about 30 px below `.cockpit-forecast`, so it covers no instrument at
    laptop size.
  - `export function clampCameraWindow(input, aspect)` → `{x, y, w}`. It clamps `w` to
    `[0.08, 0.5]`, clamps `x` and `y` so the whole window including its header stays
    inside the box given the picture's aspect ratio, and returns a copy of
    `cameraWindowHome` for any input that is not three finite numbers.
  - `export function cameraViewSettings(input)` → `'full' | 'window'`, defaulting to
    `'full'` for anything else.
  - `displayDefaults.cameraView === 'full'` and
    `displayDefaults.cameraWindow` deep-equal to `cameraWindowHome`, both validated in
    `validatePfdPreferences` through the two helpers above.
  - `CameraWindow.vue` props `{ picture: Object, label: String, stale: Object, aspect: Number, geometry: Object }`
    and events `update:geometry` (a `{x,y,w}` already clamped) and `maximize`. It renders
    a header (`CAMERA`, the stale age when present, a maximize button labelled
    `Maximize camera`), the picture in scene presentation, and a resize grip labelled
    `Resize camera window`. It holds no persistent state.

**Acceptance:**

1. `clampCameraWindow({x:0.9,y:0.9,w:0.4}, 16/9)` returns a geometry whose right edge
   (`x+w`) is at most 1 and whose bottom edge is at most 1.
   `clampCameraWindow({x:0.2,y:0.2,w:0.9}, 16/9).w` is `0.5`.
   `clampCameraWindow({x:0.2,y:0.2,w:0.01}, 16/9).w` is `0.08`.
   `clampCameraWindow(null, 16/9)` and `clampCameraWindow({x:'a',y:0.2,w:0.2}, 16/9)`
   both deep-equal `cameraWindowHome`.
2. `cameraViewSettings('window')` is `'window'`; `cameraViewSettings('full')`,
   `cameraViewSettings(undefined)` and `cameraViewSettings('inset')` are all `'full'`.
3. `validatePfdPreferences({display:{cameraView:'window',cameraWindow:{x:0.9,y:0.9,w:0.4}}})`
   returns `cameraView: 'window'` and a clamped `cameraWindow`; a stored object with a
   `cameraWindow` of `{x:5,y:5,w:5}` comes back as `cameraWindowHome`.
4. In `YonderCockpit` with a camera selected and `cameraView: 'full'`, no
   `.cockpit-camera-window` exists and the picture fills the scene. Pressing the button
   labelled `Camera view` sets `cameraView` to `'window'`, renders exactly one
   `.cockpit-camera-window` at the home geometry, and the scene shows terrain
   (`TerrainVision` painting again). Pressing the window's `Maximize camera` returns to
   `'full'` and removes the window. Pressing `Camera view` again also returns to `'full'`.
5. The Camera button is a sibling of the full-screen button inside
   `nav.cockpit-utilities`, carries `aria-pressed` reflecting `cameraView === 'full'`, and
   its accessible name is `Camera view`. With no camera selected it is `disabled` and its
   text contains `unavailable`, and pressing it changes nothing.
6. Dragging the window's header by a pointer gesture emits a `{x,y,w}` whose values differ
   from the home geometry and lie inside the box; dragging the grip changes `w` only and
   keeps the aspect ratio. After either, `localStorage.getItem('yonder-cockpit-v1')`
   parsed carries the same `display.cameraWindow`, and remounting the component restores
   it. The PFD settings reset returns `cameraWindow` to `cameraWindowHome` and leaves
   `cameraView` alone.
7. With `cameraView: 'window'` and the camera not streaming, the window renders the
   picture's own unavailable wording inside itself and no `.cockpit-camera-fallback`
   banner is drawn over the scene. With `cameraView: 'full'` and the camera not streaming,
   the existing `Selected camera unavailable` banner and its `Use synthetic terrain`
   button still appear and still work, and the Camera button still flips to `'window'`.
8. With the picture stale, the age text from Task 1's `stale` event appears in the
   footer's camera label when `cameraView` is `'full'` and in the window's header when it
   is `'window'`, and in neither place when the picture is live.
9. Neither state, neither gesture and neither button calls the fixture's command
   collector: `window.cockpitFixture.calls` stays empty.

**Verification:** ordinary console feature with persisted presentation state, so: test the
new behaviour, test-first for the two pure helpers in `camera-view.mjs` because their
contract is fully known, implementation-first allowed for the pointer gestures. Layers:

- **Software**, on this machine:
  ```
  npm test -w node-red-dashboard-2-yonder
  npm run lint
  ```
- **Integration**, the cockpit guide, which drives the production widget with Playwright
  and is the house instrument for cockpit states (`docs/images/cockpit/`):
  ```
  npm run build -w node-red-dashboard-2-yonder
  npm run cockpit:dev -w node-red-dashboard-2-yonder   # in one terminal
  npm run cockpit:guide -w node-red-dashboard-2-yonder # in another
  ```
  The added group captures `flight-camera-full`, `flight-camera-window`,
  `flight-camera-full-day` and `flight-camera-window-tablet` (1024x768, set the way
  `layout-guide.mjs` sets viewports at its line 50). Copy the four into
  `docs/images/cockpit/`, add their README rows and their `manifest.json` entries with
  real `sha256` and `bytes`, and reference them from the user guide's new step.
- **Integration**, the page gate, as the repository's unchanged floor. It is required
  because this change is outside `docs/`:
  ```
  pgrep -fl 'verify-pages.sh|yonder-pages|dist/daemon/server.js'   # must print nothing
  ./scripts/verify-pages.sh > vendor/gate.log 2>&1; echo "gate exit=$?" >> vendor/gate.log
  ```
  Read the `passed, failed` line and the `gate exit=` line before claiming anything.
  **The gate cannot reach cockpit-internal state**: it has no way to set the PFD's
  background or `cameraView`, so its `flight` captures stay in the default terrain state
  and must not change shape. A changed `flight` shape in this task means something moved
  that should not have; investigate before accepting. Do not set `ACCEPT_SHAPE`.
- **Hardware**, on the Radxa with the SeekerHD streaming, performed by the controller or
  JJ, never by a subagent on its own: the live preview fills the PFD; the Camera button
  and the window behave as in cases 4, 5 and 6; stopping the stream shows case 7; height
  above ground keeps reporting with the camera full. **Reports pending until a person has
  seen it.** Confirm which board answered before drawing a conclusion.

**Execution note (advisory):** sonnet for the component and helpers; the documentation and
manifest updates in the same task rather than split out, because they are the deliverable's
own evidence. Prerequisite: Task 1. Not parallelisable with Task 1.

- [ ] **Step 1:** Write `camera-view.mjs` and `camera-view.test.ts` together, test-first,
      to acceptance cases 1 and 2. The module imports nothing and touches no DOM.
- [ ] **Step 2:** Add `cameraView` and `cameraWindow` to `displayDefaults` in
      `pfd-controls.mjs` and validate them in `validatePfdPreferences` by calling
      `cameraViewSettings` and `clampCameraWindow`. Add acceptance case 3 to
      `pfd-controls.ported.test.ts` or to `camera-view.test.ts`, whichever the existing
      file layout makes natural.
- [ ] **Step 3:** Write `CameraWindow.vue`: a `.cockpit-camera-window` root positioned
      from its `geometry` prop in percentages; a header carrying the label, the stale age
      and a `Maximize camera` button; `<YonderPicture scene .../>` in the body; a corner
      `Resize camera window` grip. Pointer handling uses `pointerdown`/`pointermove`/
      `pointerup` with `setPointerCapture`, emits `update:geometry` with an already
      clamped value on every move, and works for touch and mouse alike. The component
      holds no persistent state and sends no command.
- [ ] **Step 4:** In `YonderCockpit.vue`, drive the background slot from
      `preferences.display.cameraView`: `full` renders the picture in scene presentation
      over a non-painting terrain component, `window` renders the painting terrain
      component and mounts `CameraWindow` as a sibling of the mission and map insets
      inside `.cockpit-body`. Wire `update:geometry` to write
      `preferences.display.cameraWindow` and call the existing `persist()`, and
      `maximize` to set `cameraView` to `'full'`. Hold the picture's `stale` payload in
      component state so it can be shown in either place.
- [ ] **Step 5:** Add the Camera button to `nav.cockpit-utilities` in the cockpit chrome,
      immediately before the full-screen button, matching its neighbours' markup:
      `<button class="utility-extra cockpit-camera-view" aria-label="Camera view" :aria-pressed="cameraView==='full'" :disabled="!cameraPath" @click="toggleCameraView">`
      with the swap glyph as an inline `<svg class="camera-glyph" viewBox="0 0 20 20">`
      inside the label line, then `Camera` and a `<small>` reading `Full · tap for window`,
      `Window · tap for full`, or `Unavailable`.
- [ ] **Step 6:** Add the CSS: `.cockpit-camera-window` absolutely positioned in
      `.cockpit-body` at `z-index: 5` like the insets, with the same border, radius and
      shadow; its header row; the resize grip; and
      `.cockpit-camera-view .camera-glyph { width:1.05em; height:1.05em; vertical-align:-0.18em; margin-right:.35em }`
      so the button keeps the row's height. jsdom performs no layout, so the unit test
      asserts the rule (`getComputedStyle` on the glyph reports an `em`-relative width and
      the button carries the same `utility-extra` class as its neighbours); the actual
      equal height is checked in Task 2's guide capture, which runs a real browser, by
      comparing the Camera and Aircraft buttons' measured heights there and failing the
      guide group if they differ by more than one pixel.
- [ ] **Step 7:** Add the window-position reset to `PfdControlPanel.vue`, beside the other
      display options, emitting an option change that writes `cameraWindowHome`.
- [ ] **Step 8:** Write `camera-window.component.test.ts` covering acceptance cases 4 to 9,
      mounting the host the way Task 1's test does. Simulate the pointer gestures with
      `trigger('pointerdown', {clientX, clientY, pointerId: 1})` and friends, stubbing
      `setPointerCapture` and `releasePointerCapture` on the element, and stub
      `getBoundingClientRect` on `.cockpit-body` so fractions have a known box.
- [ ] **Step 9:** Add the guide group to `cockpit/guide.mjs`: select the camera, capture
      `flight-camera-full`, press the Camera button, capture `flight-camera-window`,
      switch the cockpit palette to day and capture `flight-camera-full-day`, set the
      viewport to 1024x768 and capture `flight-camera-window-tablet`, then restore the
      palette, the viewport and the background so later groups are unaffected. Assert
      `window.cockpitFixture.calls` is still empty at the end of the group, as the other
      groups do.
- [ ] **Step 10:** Copy the four captures into `docs/images/cockpit/`, add their README
      rows and `manifest.json` entries (`file`, `source: "guide"`, real `sha256`, real
      `bytes`), and add the user-guide step: how to fill the PFD with the camera, how the
      Camera button switches to the window, that the picture is whatever the Cam page is
      set to send, and that the registered-terrain background stays unavailable until the
      camera is calibrated. Correct the guide's camera-unavailable troubleshooting row,
      which currently tells the operator to use synthetic terrain without mentioning the
      window.
- [ ] **Step 11:** Move manifest rows F-31 to F-34 in
      `docs/console/design/blueprint-manifest.md` from "Not yet built" to their
      implementations, evidence files and the guide captures. Close K-68 in
      `docs/known-issues.md` with what was built, naming the software and guide evidence
      and leaving the hardware line pending until a person has seen the board.
- [ ] **Step 12:** Run the final checks once on the finished revision: `npm test` and
      `npm run lint` from the repository root, then the page gate exactly as the
      Verification section specifies, and record the `passed, failed` and `gate exit=`
      lines. Then hand the hardware scenario to the controller or JJ.

## Task 3: What the board can say about where the camera was looking

**Requirements:** R-FLT-09, R-FLT-29, R-CAM-01, R-CTL-05. **No production change and no
new requirement.** A behaviour that ships as a result of these findings gets its own
requirement in the change that implements it.

This is a bounded observation, not an implementation. It exists because the
Camera-with-registered-terrain background cannot become ready until the board can say, for
each frame, where the camera was pointing when it was taken. The spec rejected an
estimated overlay: over cellular the picture arrives a few hundred milliseconds late, so a
mesh drawn for the attitude of right now sits in the wrong place in every turn, and
R-FLT-09 is explicit that unknown registration must not look aligned.

**Files:**
- Create: `docs/hardware/2026-09-11-seekerhd-registration.md` — the findings record
- Modify: `docs/known-issues.md` — only if an observation contradicts something written
  there

**Interfaces:**
- Consumes: nothing. It may run before, during or after Tasks 1 and 2.
- Produces: a findings record with four answers and their evidence, and an explicit
  statement of what the evidence cannot say. It produces no code and no type.

**Acceptance:** the record answers all four questions below, each with the command or
observation that produced it, and each marked *measured*, *estimated* or *unknown*. An
answer of "unknown, and here is why" is a passing answer. An invented device contract is a
failing answer.

1. **Lens.** The SeekerHD's field of view and distortion in the prepared capture mode
   (1920x1080 Bayer scaled by the ISP to NV12 1280x720, per
   `docs/hardware/seekerhd-on-radxa-zero-3w.md`), expressed in the shape the cockpit's
   existing calibration import already validates — read that validator,
   `validateCameraCalibration`, and report against its actual fields rather than inventing
   names. Say whether the manufacturer's figures were used, a measurement was taken, or
   neither.
2. **Mount.** How the camera sits relative to the aircraft's axes on the current airframe:
   the boresight, and any crop or rotation the pipeline applies between the sensor and the
   delivered frame. Note that R-CTL-05 makes rotation and mirroring separate controls, so
   report what the pipeline is actually doing today, not what it could do.
3. **Frame timing.** Whether the pipeline can stamp each preview frame with its capture
   time on the board's clock; by what mechanism if so; how that time could reach the
   browser alongside the frame over the existing WebRTC transport; and the **measured**
   capture-to-display delay over the console's transport on the LAN, with the method used
   to measure it. This is the answer that decides whether a registered overlay is possible
   at all.
4. **Datum.** The height reference the aircraft reports, against the vertical reference the
   terrain packs carry, and whether a conversion is already applied anywhere in the path.

**Verification:** hardware observation, so: observe the real interface on the board before
any contract is written, and label anything not observed as pending. Read-only unless JJ
approves a change. The board is the Radxa; confirm which board answered before drawing a
conclusion, because both are named `yonder`. Do not restart `yonder-core`: it renders the
network and has taken a board off the air. The console is behind the administrator
password; use the read-only browser tools or `curl`, and the daemon's unix socket as root
for state. Leave the board as it was found. No `npm test` gate applies; the record is
reviewed by reading it.

**Execution note (advisory):** the controller or JJ, on the board, not a subagent acting on
its own initiative. Opus if any part of it is delegated, because it touches a device.
Independent of Tasks 1 and 2; it can run in parallel with them since it changes no code.

- [ ] **Step 1:** Confirm the board's identity and state read-only, and record the
      revisions in play: the model string, the console and daemon versions, the camera's
      configured mode, and whether the SeekerHD is streaming.
- [ ] **Step 2:** Read `validateCameraCalibration` in the dashboard package and record its
      exact required fields, so questions 1 and 2 are answered in the shape the console
      already accepts rather than in an invented one.
- [ ] **Step 3:** Answer question 1 from the camera's own documentation and from what the
      ISP reports on the board, and say plainly which parts are manufacturer figures and
      which were measured.
- [ ] **Step 4:** Answer question 2 by inspecting the pipeline's actual arguments on the
      board and the physical mounting, and record the boresight as measured or unknown.
- [ ] **Step 5:** Answer question 3. Establish whether a capture timestamp exists anywhere
      in the current path, and measure the capture-to-display delay by a method the record
      states, on the LAN, with the number and its spread. If no timestamp exists today,
      say what would have to change and where, without changing it.
- [ ] **Step 6:** Answer question 4 from the receiver's configuration and the terrain
      pack's manifest, not from an assumption.
- [ ] **Step 7:** Write `docs/hardware/2026-09-11-seekerhd-registration.md` with the four
      answers, their evidence, and a closing section naming what the evidence cannot say
      and what a registered overlay would still need. Recommend, but do not decide, whether
      the wash or the wire treatment in the spec's renders should be built first.

## Baseline and ledger

Base revision: the commit that added the spec, R-FLT-29, K-68 and manifest rows F-31 to
F-34. Tasks 1 and 2 are serialised on the shared working tree; Task 3 changes no code and
can run beside them.

**Flagged before Task 1, for JJ to decide:** no task in this plan touches networking,
config apply and rollback, secrets, authorisation or device reachability, so none is a
candidate for an earlier independent review. The whole-branch review at the end covers it.

Final checks, once, on the finished revision: `npm test` and `npm run lint` from the
repository root, and `./scripts/verify-pages.sh` with the one-gate-at-a-time check before
it. Hardware evidence for Task 2 and all of Task 3 report **pending** until a person has
seen the board.
