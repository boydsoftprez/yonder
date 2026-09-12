# The camera in the flight display implementation plan

> **Execution:** run with `crew` (`/crew docs/superpowers/plans/2026-09-11-flight-camera-in-pfd.md`)
> under `yonder-cost-aware-execution`. Requirements and acceptance cases are binding;
> test order and review effort follow Yonder's risk-based policy; console evidence follows
> `yonder-page-verification`. No review between tasks; one whole-branch review at the end.

**Goal:** the selected camera's configured preview fills the Flight page's attitude scene
with the instruments over it, and the same picture has a movable, resizable window form
over synthetic terrain, switched by one control in the cockpit's top row.

**Architecture:** `YonderPicture` gains a scene presentation that renders its frame alone.
`YonderCockpit` stops unmounting `TerrainVision` when a camera is chosen and instead tells
it whether to paint, so height above ground and the clearance forecast keep reporting
behind the picture. A `cameraView` preference joins the existing PFD display preferences
and drives both the background slot and a window that is a peer of the existing insets.

**Tech Stack:** Vue 3 options API in `packages/node-red-dashboard-2-yonder`, Vitest with
`@vue/test-utils` under jsdom, plain CSS in `src/ui/cockpit/`, Playwright for the cockpit
guide captures.

**Spec:** [the camera in the flight display](../specs/2026-09-11-flight-camera-in-pfd-design.md),
which settles every decision and records the renders they were settled on. Read it first.

## Global Constraints

- Logic and presentation in `packages/`; `flows/` is wiring only; no `function` node.
- This plan implements **R-FLT-29**, already in `docs/requirements.md`. R-FLT-27 and
  R-FLT-28 belong to the onboard terrain service; do not use them.
- Nothing here starts or stops a stream, changes device configuration, or sends a flight
  command (R-CMD-04, R-CMD-05).
- The PFD shows the camera's **configured preview** and never requests a different stream
  (R-VID-13). No picture-quality control is added to the Flight page.
- The picture's four stale signals — desaturation, darkening, hatch, a running count — are
  load-bearing under R-VID-03 and survive every presentation change.
- The window holds the camera and only the camera. No terrain thumbnail, and registered
  terrain is never drawn inside it. The spec rejected both.
- Presentation state persists in `localStorage` only. It never reaches the daemon,
  `config.yaml` or a flow.
- SPDX header on every file. `npm test` and `npm run lint` green from the repository root.
  Signed commits with sign-off.

## What already exists

- `src/ui/YonderPicture.vue` — the live picture. One `.y-pic` grid of four rows: toolbar,
  `.y-pic__fit` wrapping `.y-pic__frame`, capture host, notices, thumbnails. Injects
  `$socket` and `$dataTracker`. Its props are an object (`id`, `props`, `state`), not an
  array. `staleFor` and `ageText` already compute the age; `staleFor` is **0 when live**.
- `src/ui/YonderCockpit.vue` — the Flight host. Its `#background` slot wraps the terrain
  component in `v-if="background==='terrain'"`, so **choosing a camera unmounts it today**.
  `nav.cockpit-utilities` in the cockpit chrome holds the top-row controls.
- `src/ui/cockpit/TerrainVision.vue` — synthetic vision. One `requestAnimationFrame` loop
  does tile loading, clearance, the forecast and the `status` emit, then paints on a single
  line. Its canvas clears **only** inside that paint call, and its visibility binds to the
  same flag `status()` sets true whenever terrain is ready.
- `src/ui/cockpit/PrimaryFlightDisplay.vue` — the PFD. `.pfd-horizon` draws a sky rect, an
  earth rect and a white line, all hidden together when the background is ready.
- `src/ui/cockpit/pfd-controls.mjs` — `displayDefaults` and `validatePfdPreferences`;
  `YonderCockpit.persist()` writes them to `localStorage` under `yonder-cockpit-v1`.
- `src/ui/cockpit/cockpit.css` — `.cockpit-body` is the positioning context; the mission
  and map insets sit in it absolutely at `z-index: 5`; `.cockpit-forecast` holds the
  top-left corner.
- `cockpit/` — the fixture harness. `guide.mjs` and `layout-guide.mjs` drive the production
  widget with Playwright and write the captures that become `docs/images/cockpit/`.
- The page gate has never photographed a camera in the flight display, and cannot reach
  cockpit-internal state to do so.

## File Structure

**Create:** `src/ui/cockpit/CameraWindow.vue` (the window: header, picture, resize grip;
holds no state), `src/ui/cockpit/camera-view.mjs` (pure geometry and validation helpers),
and three test files beside them.

**Modify:** `YonderPicture.vue` (the `scene` prop), `YonderCockpit.vue` (keep terrain
mounted, own `cameraView`, add the button, mount the window), `TerrainVision.vue` (the
`draw` prop), `PrimaryFlightDisplay.vue` (the horizon line), `pfd-controls.mjs` (the three
new preferences), `PfdControlPanel.vue` (two switches), `cockpit.css`, `cockpit/guide.mjs`
and `cockpit/fixture.mjs`, then `docs/images/cockpit/`, `docs/cockpit-user-guide.md`,
`docs/console/design/blueprint-manifest.md` and `docs/known-issues.md`.

## Task 1: The camera fills the attitude scene

**Requirements:** R-FLT-29, R-FLT-01, R-FLT-08, R-VID-03, R-VID-13, R-CMD-04. Half of K-68.

**Files:** modify `YonderPicture.vue`, `YonderCockpit.vue`, `TerrainVision.vue`,
`PrimaryFlightDisplay.vue`, `pfd-controls.mjs`, `PfdControlPanel.vue`, `cockpit.css`,
`cockpit/fixture.mjs`. Test: `src/ui/cockpit/camera-scene.component.test.ts`.

**Interfaces produced, for Task 2:**
- `YonderPicture` prop `scene: Boolean` (default false), a fourth entry in its props
  object. When true it renders only the frame and its video, filling the parent with
  `object-fit: cover`; the toolbar, capture host, notices and thumbnails are not rendered.
  Everything else — session, transport, reconnect, stills fallback, stale signals — is
  unchanged.
- `YonderPicture` emits `stale` with `{ seconds, text }`, carrying its existing `staleFor`
  and `ageText` unchanged. `seconds` is 0 when the picture is live. Do not invent a second
  convention for the same fact.
- `TerrainVision` prop `draw: Boolean` (default true). When false it paints nothing and its
  canvas shows nothing, while everything else, including the `status` emit and the
  `estimatedAglM` and `forecast` it carries, is unchanged. `data-terrain-ready` keeps
  reporting readiness in both modes; a CSS rule keys off it.
- `PrimaryFlightDisplay` prop `cameraBackground` and option `horizonLine` (default true):
  over a camera the attitude line is drawn without the sky and earth fills. Over terrain
  nothing changes.

**Acceptance:**
1. With `scene: true` the toolbar, capture host, notices and thumbnails are absent and the
   frame and its video are present; without it, the DOM is unchanged from today.
2. With `scene: true` the fill rules are in force: the fit and frame are absolute with zero
   insets and no aspect ratio, the video is `object-fit: cover`, and `.y-pic`'s grid is a
   single row. jsdom does no layout, so these are rule assertions; the measured fill is
   Task 2's guide capture.
3. A stale picture in scene mode still hatches and desaturates, and the emitted `stale`
   carries a positive `seconds`; a live one carries 0.
4. `TerrainVision` with `draw: false` never paints across 120 stepped frames while its
   `status` still carries a finite `estimatedAglM` and a non-null `forecast`; with
   `draw: true` it paints at the existing cadence and reports the same values.
5. Painting, then setting `draw: false`, leaves no fossil: the canvas is hidden and
   `data-terrain-ready` still reads true. Returning to `draw: true` paints again.
6. In the host, choosing a camera leaves `TerrainVision` mounted with `draw: false`;
   choosing terrain gives it `draw: true`.
7. With a camera background the scene has no gradient, the sky and earth fills are hidden,
   and the horizon line follows its switch. Over terrain the line stays hidden.
8. `horizonLine` validates as a boolean and defaults to true for junk or absence.
9. The existing `picture.component.test.ts` passes untouched, including its slot-height and
   overlay-ordering tests.
10. No fixture command is sent by any of it.

**Verification:** ordinary feature with one load-bearing invariant, terrain evaluation
surviving. Write cases 6 then 4 first: case 6 is the actual regression, since the host
unmounts the terrain component today. Case 4 extends the fake-WebGL and frame-stepper
harness in `terrain-performance.component.test.ts` rather than inventing one; case 6 works
against a stubbed component, since it asserts the prop handed over, not what was done with
it. Software only: `npm test -w node-red-dashboard-2-yonder` and `npm run lint`. Console
evidence and hardware belong to Task 2; a half-built state is not worth a gate run.

**Execution note (advisory):** sonnet. No prerequisite. Not parallel with Task 2, which
touches the same files.

- [ ] **Step 1:** Write case 6, watch it fail, then make the host keep `TerrainVision`
      mounted whenever terrain is enabled, passing `draw` from the background choice, with
      the picture layered over it.
- [ ] **Step 2:** Add `draw` to `TerrainVision` gating its single paint call, and hide the
      canvas while it is false. Say in a comment why both halves are needed: the canvas
      clears only inside that call, so gating the call alone leaves the last frame on
      screen, and a camera that then failed to stream would draw its unavailable banner
      over a frozen terrain image that reads as live. Leave `data-terrain-ready` alone.
      Keep the renderer created in both modes so the two paths stay identical.
- [ ] **Step 3:** Add the `scene` prop and its presentation. Collapse `.y-pic`'s grid to one
      row: leaving four tracks reserves height for elements that are no longer there and
      shrinks the container the frame sizes against, which is the fourth version of the
      sizing bug already documented in that file — extend that comment rather than repeat
      it. Dropping the capture host is safe because the deck teleports into a selector
      scoped to the Camera page.
- [ ] **Step 4:** Emit `stale` from wherever `staleFor` updates, carrying the existing
      computeds. Leave the toolbar's own age display alone.
- [ ] **Step 5:** Add `cameraBackground` and `horizonLine` to the PFD and the preference,
      the switch to the PFD settings panel, the dark scene background in `cockpit.css`, and
      a synthetic camera with a stills frame to `cockpit/fixture.mjs`. Keep the fixture's
      default background as terrain so no committed capture moves in this task.
- [ ] **Step 6:** Write the remaining cases, then run the two commands above.

## Task 2: The camera window and the Camera button

**Requirements:** R-FLT-29, R-FLT-25, R-VID-03, R-CMD-04. The other half of K-68.

**Files:** create `CameraWindow.vue`, `camera-view.mjs` and two test files; modify
`YonderCockpit.vue`, `pfd-controls.mjs`, `PfdControlPanel.vue`, `cockpit.css`,
`cockpit/guide.mjs`, `docs/images/cockpit/`, `docs/cockpit-user-guide.md`,
`docs/console/design/blueprint-manifest.md`, `docs/known-issues.md`.

**Interfaces consumed:** everything Task 1 produced.

**Interfaces produced:**
- `camera-view.mjs`: `cameraWindowHome = { x: 0.13, y: 0.12, w: 0.17 }` as fractions of
  `.cockpit-body` — the measured geometry of the approved render
  `instrument-library/flight.camera.window.night.png`, clearing the airspeed tape and the
  forecast notice at laptop size. `clampCameraWindow(input, aspect)` keeps the whole window
  inside the box and the width within one eighth to one half, returning home for anything
  invalid. `cameraViewSettings(input)` returns `'full'` or `'window'`, defaulting to full.
- `CameraWindow.vue` takes the picture, a label, the stale payload, an aspect and a
  geometry; emits `update:geometry` already clamped, and `maximize`. It holds no state.

**Acceptance:**
1. `clampCameraWindow` keeps the window inside the box, clamps the width to its bounds,
   and returns `cameraWindowHome` for null or non-numeric input.
2. `cameraViewSettings` returns window only for `'window'`, full for everything else.
3. `validatePfdPreferences` round-trips both, clamping a stored geometry and replacing an
   impossible one with home.
4. With a camera and `cameraView: 'full'` there is no window and the picture fills the
   scene. Pressing the top-row Camera control gives exactly one window at home with terrain
   painting behind it; the window's maximize, and the same control again, both return to
   full.
5. The Camera control sits beside the full-screen button, reports its state, and is
   disabled and reads unavailable with no camera selected, changing nothing when pressed.
6. Dragging the header moves the window inside the box; dragging the grip changes width
   only and keeps the aspect ratio. Both persist, survive a remount, and the settings reset
   returns the geometry to home without touching the state.
7. With no stream: in window mode the window shows the picture's own reason and no banner
   is drawn over the scene; in full mode today's unavailable banner and its synthetic
   terrain switch still work, and the control still flips.
8. The stale age appears in the footer label in full mode and the window header in window
   mode, and in neither when the picture is live.
9. No fixture command is sent by any state, gesture or press.

**Verification:**
- **Software:** `npm test -w node-red-dashboard-2-yonder`, `npm run lint`. Test-first for
  the two pure helpers, whose contract is fully known; implementation-first is fine for the
  pointer gestures. Stub the body's bounding box so the fractions have a known box, the way
  `picture.component.test.ts` already stubs geometry.
- **Console:** the cockpit guide, which drives the production widget in a real browser and
  is the house instrument for cockpit states. Capture both states, both palettes, and
  tablet size; copy them into `docs/images/cockpit/` with their README rows and manifest
  entries, and reference them from the new user-guide step. Check there that the Camera
  control is the same height as its neighbours, which jsdom cannot tell you.
- **Page gate:** required because this change is outside `docs/`. Check no other gate is
  running first, run it, and read its `passed, failed` and `gate exit=` lines. It cannot
  reach cockpit-internal state, so its Flight capture stays in the default terrain state
  and **must not change shape**; a changed shape means something moved that should not
  have. Do not set `ACCEPT_SHAPE`.
- **Hardware**, by the controller or JJ, never a subagent alone: on the Radxa with the
  SeekerHD streaming, the live preview fills the PFD, the control and window behave as in
  cases 4 to 6, stopping the stream shows case 7, and height above ground keeps reporting
  with the camera full. **Pending until a person has seen it.**

**Execution note (advisory):** sonnet. Prerequisite: Task 1. Not parallel with it. The
documentation and manifest updates belong in this task, not split out: they are this
deliverable's own evidence.

- [ ] **Step 1:** Write `camera-view.mjs` and its tests together, test-first, to cases 1
      and 2; add case 3 to the preference validator.
- [ ] **Step 2:** Write `CameraWindow.vue` — header with label, stale age and maximize; the
      picture in scene presentation; a corner grip. Pointer capture for move and resize,
      emitting clamped geometry, working for touch and mouse.
- [ ] **Step 3:** Drive the host's background slot from `cameraView`, mount the window as a
      peer of the existing insets, persist geometry through the existing `persist()`, and
      hold the picture's stale payload so it can be shown in either place.
- [ ] **Step 4:** Add the Camera control to the top row before the full-screen button,
      matching its neighbours' markup, with the camera-and-arrows glyph sized in `em` so
      the button keeps the row's height.
- [ ] **Step 5:** Add the window and control CSS, and the window-position reset to the PFD
      settings panel.
- [ ] **Step 6:** Write the component tests for cases 4 to 9.
- [ ] **Step 7:** Add the guide group, restoring palette, viewport and background after it
      so later groups are unaffected, and assert no command was sent.
- [ ] **Step 8:** Commit the captures with their README rows and manifest entries, write the
      user-guide step, correct its camera-unavailable row, move manifest rows F-31 to F-34
      to their implementations, and close K-68 leaving its hardware line pending.
- [ ] **Step 9:** Run the final checks once on the finished revision, then hand the hardware
      scenario over.

## Task 3: What the board can say about where the camera was looking

**Requirements:** R-FLT-09, R-FLT-29, R-CAM-01, R-CTL-05. **No production change and no new
requirement.** Anything that ships as a result gets its own requirement then.

A bounded observation, not an implementation. The registered-terrain background cannot
become ready until the board can say, per frame, where the camera was pointing. The spec
rejected an estimated overlay: over cellular the picture arrives late enough that a mesh
drawn for the attitude of now sits wrong in every turn, and R-FLT-09 is explicit that
unknown registration must not look aligned.

**Files:** create `docs/hardware/2026-09-11-seekerhd-registration.md`.

**Acceptance:** the record answers all four questions, each with the observation that
produced it and each marked *measured*, *estimated* or *unknown*. "Unknown, and here is
why" passes. An invented device contract fails.

1. **Lens** — field of view and distortion in the prepared capture mode, expressed in the
   shape the cockpit's existing calibration import validates. Read that validator first and
   answer in its actual fields.
2. **Mount** — how the camera sits relative to the aircraft's axes, and any crop or rotation
   the pipeline applies today between sensor and delivered frame.
3. **Frame timing** — whether a frame can carry its capture time, by what mechanism, how it
   would reach the browser, and the **measured** capture-to-display delay with the method
   used. This is the answer that decides whether a registered overlay is possible at all.
4. **Datum** — the height reference the aircraft reports against the one the terrain packs
   carry, and whether anything already converts between them.

**Verification:** hardware observation, read-only unless JJ approves otherwise. Confirm
which board answered, because both are named `yonder`. Do not restart `yonder-core`: it
renders the network and has taken a board off the air. Use the read-only browser tools,
`curl`, or the daemon socket as root. Leave the board as found. The record is reviewed by
reading it.

**Execution note (advisory):** the controller or JJ, on the board, not a subagent on its
own initiative. Independent of Tasks 1 and 2 and can run beside them.

- [ ] **Step 1:** Confirm the board and record the revisions in play.
- [ ] **Step 2:** Read the calibration validator so questions 1 and 2 are answered in the
      shape the console already accepts.
- [ ] **Step 3:** Answer the four questions, marking each measured, estimated or unknown.
- [ ] **Step 4:** Write the record, close it with what the evidence cannot say and what a
      registered overlay still needs, and recommend — without deciding — whether the wash or
      the wire treatment in the spec's renders should be built first.

## Ledger

Base: the commit adding the spec, R-FLT-29, K-68 and manifest rows F-31 to F-34. Tasks 1
and 2 are serialised on the working tree; Task 3 changes no code and runs beside them.

Nothing here touches networking, config apply and rollback, secrets, authorisation or
device reachability, so no task is flagged for an earlier independent review. The
whole-branch review at the end covers it.

Final checks once, on the finished revision: `npm test`, `npm run lint`, and the page gate.
Hardware evidence for Task 2 and all of Task 3 report **pending** until a person has seen
the board.
