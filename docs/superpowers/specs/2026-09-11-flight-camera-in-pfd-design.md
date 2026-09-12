# The camera in the flight display — design

Approved in conversation on 2026-09-11; this record awaits the operator's review.
Base: `origin/main` at `e1c4e1f` plus the local terrain-service commits through
`f7ccd49`. Requirements: R-FLT-29 (added here), R-FLT-01, R-FLT-09, R-FLT-25,
R-VID-03, R-VID-13. Defect: [K-68](../../known-issues.md#k-68).

## Goal

Fly by the picture. Choosing the camera as the flight display's background puts the
live picture across the whole attitude scene with the instruments over it, the way
synthetic terrain already does. One control in the top row shrinks that picture into a
small window over the terrain and brings it back. Terrain drawn onto the picture itself
waits for the board to be able to say where the camera was looking when each frame was
taken; that groundwork is scoped here as a bounded spike, not as display work.

## What exists, and what is wrong with it

The Flight page's PFD already offers three backgrounds under **Display → Map, terrain &
data**: synthetic terrain, camera, and camera with registered terrain (R-FLT-09, F-07).
The camera choice mounts the Camera page's picture component whole into the PFD's
background slot. The result, reproduced in the fixture harness with a synthetic frame,
is [`flight.camera.today.night.png`](../../console/design/instrument-library/flight.camera.today.night.png):

- The picture keeps its own shape inside a nearly square scene, so it appears as a
  bordered box in the middle of the display rather than as the scene.
- The picture's toolbar, its preview-mode buttons, its badges and its notices all render
  inside the attitude area, under the pitch ladder and the mode annunciator.
- Around the box, the background container paints a fixed blue-and-brown split that
  reads as a horizon and never moves, while the real attitude horizon is switched off the
  moment a camera is chosen.

The third background can never become ready. The daemon reports every camera with no
calibration, no frame capture time and no pose time, and a fixed registration reason
(`packages/yonder-core/src/cockpit/camera.ts`). The overlay component that would draw
registered terrain (`CameraTerrainOverlay.vue`) is therefore a seam with nothing behind
it, and the setting only ever shows an unavailable notice.

Two designs were approved without ever being drawn together: the camera view's compact
form for the Cockpit ([2026-09-03](2026-09-03-camera-view-design.md), video-first with
overlays and a map inset) and the flight display's backgrounds
([cockpit integration design](../../cockpit-integration-design.md)). No render of the PFD
with a camera in it existed in the blueprint. This document is that render and its rules.

## Decisions

Each was settled by looking at a render of the real PFD component in the fixture harness.
The renders are listed at the end.

1. **The camera fills the scene.** With Camera as the background the picture covers the
   attitude area edge to edge, cropping a little at top or bottom where the camera's shape
   and the scene's differ, exactly as terrain does. Letterboxing was rejected because a
   bordered box reads as an inset, and the flying view has one subject.
2. **None of the picture's own chrome appears in the PFD.** No toolbar, no preview-mode
   buttons, no badges, no notices, no thumbnail strip, no capture controls. The Camera
   page keeps all of them. The picture component gains a scene presentation that draws the
   frame alone.

   **Amended 2026-09-12, by the operator, after the whole-branch review.** "No notices"
   read literally made the scene silent about every reason except *stopped*: a browser
   that blocked autoplay, an expired session, a 401/403/404/503 from the delivery path,
   a decoder that stopped and is reconnecting. A picture that has never received a frame
   is never stale, so in those cases the scene and the window showed a black rectangle
   with no hatch, no age count and no reason, and the window had no way back to a live
   picture. That is R-UI-20's silent absence, and it is the worse fault: this decision
   exists to keep the flying view to one subject, not to withhold why the subject is
   missing. So the scene shows **one line of reason when there is one, and nothing at
   all when the picture is fine**, and the **Resume live video** control returns for the
   autoplay-blocked case — the one reason the operator's own browser can fix, with
   nothing sent to the device or the aircraft. The line is drawn inside the frame, at
   its foot, not in the PFD's footer: the footer carries the background label and the
   stale age, and a reason hidden there is a reason nobody reads. Everything else
   decision 2 excludes stays excluded, and the *stopped* state keeps its message while
   losing its **Start video** button, which starts the device's stream (decision 12,
   R-CMD-04).

   **The line goes in the full scene; the window is marked unavailable instead.** The
   window is a sixth of the scene's width: about 140 x 55 px on the Flight page, with
   roughly 40 px of usable height. "The video service is unavailable. Reconnecting
   automatically." is 68 px of text in that box however it is set. The page gate measured
   exactly that and refused it as content hidden from the operator, which is the right
   answer — truncating it kept the tail and dropped the words that say what is wrong.

   **Settled by the operator on 2026-09-12:** a window with no picture shows **the red
   cross the cockpit already draws over an instrument with no reading**, with one line
   beneath it, rather than a blank box, a grown window, or a sentence that cannot fit.
   The treatment is not a new one — it is `InstrumentGauge.vue`'s own `.missing-cross`,
   the same two strokes in the same `#ef5a53` with the same `DATA UNAVAILABLE` beneath —
   so a window with nothing behind it reads as one more instrument with no data instead
   of as an idea the operator has to learn. It applies to every state with no live
   picture: the delivery failures, an expired session, a decoder reconnecting, and a
   camera the operator stopped. Two states say something shorter and truer than
   *DATA UNAVAILABLE* — `VIDEO STOPPED` for a camera somebody deliberately stopped, and
   `SIGN IN REQUIRED` — because "unavailable" would misdescribe both.

   Three things the cross does not do. It never covers a frame: a picture that has had
   media and then went quiet keeps it, desaturated, darkened and hatched, with its age in
   the window's header, because the held frame is the one thing still worth having
   (decision 11, R-VID-03). It does not appear when this browser blocked autoplay, where
   **Resume live video** stays and is the thing to press — a cross over a button is two
   answers to one question. And it is not drawn in the full scene, which shows the line.
3. **The fixed blue-and-brown split goes.** Behind a camera the background container is
   the display's dark ground colour; nothing pretends to be a horizon.
4. **The white horizon line stays drawn over the picture, on by default.** A forward
   camera shows the true horizon only when its mount is level and the picture is clear;
   the line gives attitude at a glance when it is not. A switch in PFD settings hides it.
   Over synthetic terrain the line stays off, as today, because the terrain draws its own.
5. **The picture is the camera's configured preview, and nothing else.** Codec, size,
   rate, fixed or adaptive behaviour and image controls are whatever the Cam page set
   (R-VID-13). The PFD adds no picture-quality control of its own. The full-rate stream is
   not requested from the PFD.
6. **A small window is the camera's other form.** Its home is the top left of the scene,
   over the sky, beside the airspeed tape and above the wind readout, where it covers no
   instrument at laptop size. The operator can drag it by its header and resize it from its
   corner grip; place and size are remembered in that browser with the other display
   preferences (R-FLT-25) and reset from PFD settings. It cannot be kept off the
   instruments by rule, because they cover most of the scene, so the default is clear and
   the operator owns it from there.
7. **Two states, one control.** *Full*: the picture fills the scene and there is no
   window. *Window*: synthetic terrain fills the scene and the picture sits in the window.
   A **Camera** button in the top row, beside the full-screen button, reads the current
   state and flips it; the window's own maximize control also goes to full. A control on
   the scene itself was rejected as clutter, and a control in the footer as the wrong
   place; the top row is where the PFD keeps the controls that change what you look at.
   The button carries a camera glyph with cycling arrows, drawn in the same stroke as the
   full-screen glyph, and is the same height as its neighbours.
8. **There is no terrain thumbnail.** With the camera full, the terrain is not shown in
   the window. A thumbnail repeats what the height-above-ground readout and the
   clearance forecast already say, at a size where a ridge is a few pixels tall, and it
   costs the renderer. The window is the camera's, only.
9. **Height above ground and the forward-clearance forecast keep working while the
   camera fills the scene.** Today both are computed inside the terrain renderer, so
   unmounting it to show the camera would silently blank them. Terrain evaluation is
   separated from terrain drawing: with the camera full, the evaluation continues and the
   drawing stops.
10. **Terrain onto the video waits for calibration and frame timing.** The registered
    overlay requires the camera's lens and mount, the capture time of each frame and a
    matching height datum (R-FLT-09). An estimated overlay from a datasheet field of view
    and a guessed delay was considered and rejected: over cellular the picture arrives a
    few hundred milliseconds late, so it would sit in the wrong place in every turn, and
    the requirement is explicit that unknown registration must not look aligned. The
    groundwork is a bounded spike on the board (below). The two candidate treatments,
    a translucent wash and a ground-only wire, are recorded as renders and chosen after it.
11. **A stale picture still announces itself in the PFD.** The desaturation, darkening
    and hatch stay on the frame in the scene presentation. The age count, which lived in
    the picture's toolbar, is shown in the footer's camera label when the picture is full
    and in the window's header when it is small (R-VID-03).
12. **Nothing here commands the aircraft or changes the device.** The states, the
    window's geometry and the horizon-line switch are browser presentation. Starting or
    stopping a stream is done on Cameras, not from the PFD (R-CMD-04, R-CMD-05).

## Behaviour

### States

The camera presentation has two values, `full` and `window`, applying whenever a camera
is selected for the PFD. The existing background choice keeps its three values; `full`
is what Camera and Camera-with-registered-terrain mean, and `window` is synthetic terrain
in the scene with the picture in the window. The Display panel's Background chooser
continues to work: choosing Camera there is the same as going to `full`, and choosing
Synthetic terrain there with a camera selected is the same as going to `window`.

| State | Scene | Window | Camera button reads |
|---|---|---|---|
| `full` | The picture, instruments over it, horizon line per the switch | none | Camera · Full · tap for window |
| `window` | Synthetic terrain (or the conventional horizon when terrain data is off) | The picture, top-left home unless moved | Camera · Window · tap for full |
| no camera selected, or none configured | unchanged from today | none | Camera · unavailable (disabled) |

There is no third state with a camera selected and no picture anywhere. An operator who
wants an unobstructed terrain view moves the window aside or shrinks it to its smallest
size. This keeps the control to one tap each way, which was the point.

### The window

- Home position: top left of the attitude scene, clear of the airspeed tape, the bank
  scale and the forecast notice at laptop size. Default width one sixth of the scene's
  width; height follows the picture's own aspect ratio.
- Drag the header to move; the window stays wholly inside the scene. Drag the corner
  grip to resize between one eighth and one half of the scene's width, keeping the
  picture's aspect ratio. Touch and mouse both work.
- Place and size are stored as fractions of the scene, so a saved position keeps its
  meaning across laptop and tablet sizes and across full screen. Stored values are
  validated on load; anything out of range falls back to the home position and default
  size.
- The header carries the label CAMERA, the age count when the picture is stale, and the
  maximize control. The window draws above the instruments, like the mission and map
  insets, because the operator placed it.
- Registered terrain is never drawn in the window; that treatment belongs to the full
  scene only.

### The Camera button

- Lives in the cockpit's control row beside the full-screen button, so it stays in the
  same place in full screen and on tablet layouts.
- Label **Camera** with the swap glyph, and a second line stating the current state and
  what a tap does. Same height and style as its neighbours.
- Disabled, reading *unavailable*, when no camera is selected or none is configured. It
  never starts or stops a stream.

### Unavailable and stale pictures

- **No camera configured at all** (nothing for the PFD to show, either state): the
  existing notice *Selected camera unavailable* with its *Use synthetic terrain* switch
  remains (F-16), and the Camera control is disabled and reads *unavailable*.
- Camera configured but not streaming, state `full`: the picture is mounted and says so
  itself, in its own words, on the scene — decision 2 as amended. The F-16 notice does
  not apply, because a configured camera is not an unavailable one; the escape to terrain
  is the Camera control, one tap, which is where the operator already looks. The button
  still flips to `window`.
- Camera selected but not streaming, state `window`: the window is marked the way the
  cockpit marks an instrument with no reading — the red cross and one line beneath it
  (*VIDEO STOPPED*, *SIGN IN REQUIRED*, or *DATA UNAVAILABLE*), and nothing else. The
  sentence form of the reason is read by going to full, where it fits. See decision 2's
  amendment, settled 2026-09-12.
- Stream stalls while showing: the frame desaturates, darkens and takes the hatch, and
  the age count runs in the footer label (full) or the window header (window).
- Reload: the state, the window's place and size and the horizon-line switch are
  restored from the browser's display preferences.

### Full screen

Nothing changes. Full screen only removes the browser and the console's own header and
sidebar; the cockpit's control row, with the Camera button, stays inside the cockpit. The
window's fractions apply to the larger scene.

## Interfaces

- **`YonderPicture` scene presentation.** A prop (`scene`) that renders only the frame
  and its video, sized to cover its box, with no toolbar, notices, capture host or
  thumbnail strip. The session, transport, reconnect, stills fallback, adaptive reporting
  (R-VID-19) and the stale signals on the frame are unchanged. The component exposes the
  stale age so the host can show it. The Cockpit page and the Camera page do not use the
  scene presentation and are unaffected.
- **Cockpit presentation state.** `background` (`terrain` | `camera` | `camera-overlay`),
  `cameraWindow` (`x`, `y`, `w` as scene fractions) and `horizonLine` (boolean) join the
  display preferences validated by `cockpitDisplaySettings` and stored with them.
  `cameraView` (`full` | `window`) is **derived** from `background` and never stored
  beside it. *Corrected 2026-09-12 after the whole-branch review:* this entry first named
  `cameraView` as a stored value, which contradicted the Behaviour section above — and
  two independent stored values reached exactly the third state that section forbids, as
  the default, with the control misreporting it. The Behaviour section is what the states
  are; this is how they are held.
- **Top-row control.** One button in the existing header actions, next to the
  full-screen button, bound to `cameraView` and to camera availability.
- **PFD horizon line.** An option on `PrimaryFlightDisplay` that draws the attitude
  line alone, without the sky and ground fill, while a camera is the background.
- **Terrain evaluation without drawing.** `TerrainVision` accepts a `draw` flag. With it
  off, the component keeps loading tiles, evaluating height above ground and the forward
  clearance forecast, and reporting status; it paints nothing. The plan may instead lift
  the evaluation into the terrain state module, as long as the reports keep flowing with
  the camera full.
- **Daemon.** No change for the display work. The cockpit camera record keeps reporting
  calibration and frame timing honestly as absent until the spike says otherwise.

## The spike: calibration and frame timing on the board

Bounded observation on the Radxa with the SeekerHD, producing a findings record under
`docs/hardware/` and no production change:

1. **Lens.** Measure the SeekerHD's field of view and distortion in the prepared capture
   mode, and express them in the shape the cockpit's calibration import already validates.
2. **Mount.** Check how the camera sits on the airframe relative to the aircraft's axes,
   and record the boresight and any crop or rotation.
3. **Frame timing.** Establish whether the pipeline can stamp each preview frame with its
   capture time on the board's clock, how that time reaches the browser with the frame,
   and the measured delay from capture to display over the console's transport.
4. **Datum.** Confirm the height reference the aircraft reports against the terrain
   packs' reference, as the synthetic view already requires.

The findings decide how the daemon's camera record gets a real calibration and a real
frame pose, and therefore when the existing overlay draws. The wash or wire treatment is
chosen then. Any pipeline behaviour that ships as a result gets its own requirement in
the change that implements it.

## Acceptance criteria and evidence

Software, on this machine, as component tests:

1. With a camera selected and `full`, the picture frame's box equals the attitude scene's
   box at laptop and tablet sizes, and no toolbar, notice, badge or strip from the picture
   component is rendered inside the PFD.
2. With a camera selected and `full`, the background container has no gradient, the
   attitude sky and ground fills are hidden, and the horizon line is drawn when the switch
   is on and hidden when it is off.
3. The Camera button flips `full` and `window`; the window appears at its home; its
   maximize control returns to `full`; the button is disabled with *unavailable* when no
   camera is selected.
4. Dragging moves the window within the scene; resizing keeps the aspect ratio within the
   size limits; place and size persist and reload; invalid stored values fall back.
5. With `full`, terrain status reports including height above ground and the forecast
   continue to arrive while the terrain renderer paints nothing.
6. In the scene presentation the frame still desaturates, darkens and hatches when stale,
   and the age count appears in the footer label (full) and the window header (window).
7. None of the above sends a vehicle command or a device configuration change; the
   existing "does not send" test pattern covers the new controls.

Integration, in the page gate and the cockpit guide: Flight captured with a fixture
camera and a stills frame in both palettes at laptop and tablet sizes, in both states; a
guide step for the Camera button; existing captures unchanged except where this design
intends them to change.

Hardware, on the Radxa with the SeekerHD streaming, looked at by the operator: the live
preview fills the PFD; the button and the window behave as above; stopping the stream
shows the unavailable states; height above ground continues with the camera full; the
picture's own cadence readout and the PFD's motion are not degraded by the fill. This
evidence is marked pending until a person has seen it.

## Requirements

Added in this change. R-FLT-27 and R-FLT-28 are reserved by the
[onboard terrain service](2026-09-11-onboard-terrain-service-design.md) and its plan,
which claimed them first; this design takes the next free ID.

| ID | Requirement | P |
|---|---|---|
| R-FLT-29 | Let the selected camera's configured preview fill the PFD's attitude scene with the screen-fixed instruments over it and none of the picture's own controls inside it, keeping the attitude line available over the picture. Offer the same picture as a movable, resizable window over synthetic terrain, with one visible control that switches between the two and remembers place and size locally. Height above ground and the forward-clearance forecast remain available with the camera filling the scene. Neither state starts or stops a stream, requests a different stream, or commands the aircraft | 1 |

Touched: R-FLT-01 and R-FLT-25 (the single PFD keeps its attitude display and insets
under both states), R-FLT-09 (the registered-terrain background keeps its gate; the
spike is the path to satisfying it), R-VID-03 (stale signals carried into the scene
presentation), R-VID-13 (the PFD consumes the configured preview and never requests
more). R-CMD-04 and R-CMD-05 are unchanged and unweakened.

## Renders this was settled on

All are the real PFD component in the fixture harness with synthetic telemetry and a
synthetic camera frame; none is flight evidence. Files in
`docs/console/design/instrument-library/`:

| File | What it shows |
|---|---|
| `flight.camera.today.night.png` | The defect, K-68: the picture box over the fixed split, chrome inside the scene |
| `flight.camera.full.night.png` | Decision 1 to 3: the camera fills the scene, instruments over it |
| `flight.camera.window.night.png` | Decision 6: the window in its top-left home, terrain in the scene. Composite |
| `flight.camera.toggle.night.png` and `flight.camera.toggle.zoom.night.png` | Decision 7: the Camera button beside full screen, magnified |
| `flight.camera.full.tablet.night.png` | The full state at tablet size in full screen |
| `flight.camera.overlay-wash.candidate.night.png` | Decision 10, candidate: translucent terrain wash under the instruments, horizon line kept. Terrain and picture are from different places; treatment only |
| `flight.camera.overlay-wire.candidate.night.png` | Decision 10, candidate: ground-only wire. Same caveat |

Rejected along the way and not kept: the picture letterboxed; the window replacing the
map inset; a floating window above the map inset; a tab on the map inset; a shrink
control on the scene; a shrink control in the footer; a terrain thumbnail in the window;
an estimated, uncalibrated overlay.

## Out of scope

- The terrain thumbnail, the estimated overlay and any picture-quality control on the PFD.
- The Camera page and the Cockpit page, which keep their picture presentations.
- The mission and map insets, the MFD pages and the instrument bank.
- Day-palette renders; the page gate produces them as part of the integration evidence.
- Drawing terrain onto the video. It follows the spike as its own bounded change.

## Plan shape

Two bounded display pieces and one hardware spike, for `yonder-writing-plans` and `crew`:

1. The scene presentation of the picture, the fill, the horizon-line switch, the dark
   background, and terrain evaluation without drawing, with the stale age in the footer.
2. The window, the Camera button, persistence, the unavailable and stale states, the guide
   step, the manifest rows and the gate captures.
3. The calibration and frame-timing spike on the Radxa, findings only.
