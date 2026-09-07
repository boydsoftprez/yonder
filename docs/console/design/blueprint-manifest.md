# The blueprint manifest

Every element the approved blueprint draws, written as a claim somebody can
check against a capture, with what the console does today beside it.

**Why this file exists.** The console was designed as a blueprint, approved,
and then built from a written spec. Nobody compared the result to the picture.
Four controls that both ends of the system already support were never built,
and the operator found each of them himself, one at a time, after three task
reviews, two fix rounds and two scoped re-reviews. **A review reads a diff, and
nothing in a diff is missing** (CLAUDE.md rule 7). This file is the form of the
question a diff cannot ask.

**How to use it.** Before a console surface is called finished, walk its table.
Each row is either *present*, or it is a gap with a classification and — if it
is to be deferred rather than built — a named owner. A deferred item with no
owner is indistinguishable from a closed one, and that is how the ground
station's resolution picker, the action that configures a detected camera and
the Cameras page's encode-headroom panel all went missing.

**This file decides nothing.** Where the blueprint collides with a repository
rule, a requirement or the substrate, both sides are written down and the row
is marked **conflict**. Those are the operator's calls (CLAUDE.md rule 8).

---

## What was compared, and against what

**The blueprint** is `docs/console/design/instrument-library/` — a live Vue
gallery and fifteen PNG renders of it, confirmed by the operator as *the*
reference. All fifteen were re-rendered from the gallery by `shot2.mjs`,
`shot4.mjs`, `shot5.mjs` and `shot6.mjs` and not one byte changed, so the
committed PNGs, the gallery source and the shot scripts agree.

The strip along the top of each full-shell render is the gallery's own harness
— palette, page, link and camera switches. It is not part of the design and is
not audited here.

**The console** is the committed captures in `docs/console/capture/`, read at
`HEAD` (`git show HEAD:<path>`) because another session had several of them
modified in the working tree while this audit ran. Where the working tree had
already moved, the row says so.

### Blueprint coverage, by surface

| Console surface | Blueprint render | Covered? |
|---|---|---|
| Camera · Live | `live.elp.night.png`, `live.pocket2.night.png`, `live.pocket2.day.png`, `live.pocket2.poor.png`, `photo-and-captures.elp.png`, `stage.poor.1512.png`, `fold.1440.png`, `fullpage.1440.png`, `columns.fixed.png`, `columns.adaptive.png`, `aim.elp.png`, `aim.pocket2.png` | yes, thoroughly |
| Camera · Setup | `setup.elp.night.png`, `setup.pocket2.night.png` | yes |
| Cameras | `cameras.night.png` | yes, night only |
| **Status** | — | **no render exists** |
| **Network** (five tabs) | — | **no render exists** |
| **Log** | — | **no render exists** |
| **Diagnostics** | — | **no render exists** |

**Finding B-01 — four of the six shipped pages have no approved picture at
all.** The instrument library was scoped to the camera work and never widened.
Status, Network, Log and Diagnostics ship today with no drawing anybody
approved, so for those surfaces there is nothing to be absent *from*: the
comparison this file exists to force cannot be made. Their sections below
inventory what the console currently draws, which is the raw material for a
blueprint, not a substitute for one. **Classification: unbuilt (the blueprint
itself). Owner: none.** This is a decision for the operator — either those
surfaces get renders, or the manifest records that they are governed by
requirements and the capture gate alone.

### Discrepancies seen in the working tree while auditing

- `camera-live.*.png`, `camera-setup.*.png` and their notebook/tablet variants
  were modified in the working tree. The committed versions predate
  `d25cc95`/`820bd01` (mirror, flip and rotation) and show no Orientation
  group; the working-tree renders do. **The committed captures are stale
  against the committed code.** Rows below are marked where this changes the
  answer.
- `cameras.day.png` and `cameras.night.png` were listed as modified at the
  start of this session and are now byte-identical to `HEAD`.
- `docs/console/capture/camera-live-sensor-turns.night.png` is untracked — a
  new capability state being added by the other session.
- `docs/console/design/instrument-library-alternative/` appears as untracked in
  the session's opening git status but **does not exist on disk**. Nothing in it
  can be a reference. The idiom the operator adopted from it is already carried
  by the Aim panel in the tracked blueprint.
- **A trap for the next reader:** `instrument-library/gallery/.superpowers/gallery/`
  holds fifteen PNGs with the same filenames as the blueprint's. It is
  gitignored scratch — re-render output, not a second reference. **The
  blueprint is the fifteen files at the top of `instrument-library/`.**

### What the capture gate does and does not catch

`scripts/verify-pages.sh` photographs every page in both palettes at 1280×900,
plus notebook (1440×900) and tablet (1024) viewports for the camera pages, and
measures overflow, clipping, the fold and the shape reference. It passes at
160/0 today. **It has no concept of fidelity** — it cannot ask whether what is
on the page is what the blueprint drew, and every gap below survived it.

It has a second blind spot this audit exposed: the camera pages are
photographed against one fixture (`scripts/fixtures/camera-globalshutter.json`,
plus `camera-sensor-turns.json`). That camera answers `aim: none` and gates
shutter, focus and temperature. The blueprint draws four capability states
across two cameras. **Most of the states the blueprint draws are unreachable by
the gate**, so a control drawn only in `advertised` or `gated` form cannot be
compared to anything.

---

## Surface 1 — Camera · Live

Blueprint: `live.elp.night.png` (the ELP, the camera on the bench),
`live.pocket2.night.png` / `.day.png` / `.poor.png` (the accessory camera and
the degraded link), `photo-and-captures.elp.png`, `aim.elp.png`,
`aim.pocket2.png`, `fold.1440.png`.
Capture: `camera-live.night.png` / `.day.png`, `camera-live-notebook.day.fold.png`.

### 1.1 Shell and navigation

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-01 | A header reading `YONDER │ Camera` on one line | Present, but `YONDER` and `Camera` stack on two lines at 1280 | drifted | Cosmetic at the gate's width; the blueprint's own width is 1400–1440 |
| L-02 | A sidebar with a `CAMERAS` section heading | **Absent** — the sidebar is one flat list | unbuilt | See L-04 |
| L-03 | A sidebar with a `SYSTEM` section heading above `LOG` and `DIAGNOSTICS` | **Absent** | unbuilt | Needs a Dashboard 2.x sidebar feature we do not use, or is a substrate limit — **unverified**, see C-3 |
| L-04 | **One sidebar entry per camera** under `CAMERAS` — `CAM 1`, `CAM 2` (R-UI-03) | **Absent** — one static entry, `CAMERA`, for all cameras | unbuilt | `flows/flows.json` declares six `ui-page` nodes, one of them `Camera`; nothing in `packages/` or `scripts/` creates a `ui-page` per detected camera. **Task 29 named this outcome — "one Dashboard page per detected camera (R-UI-03)" — and commit `75f8c46` claims it in its message.** The claim and the flow disagree |
| L-05 | The pressed camera's entry highlighted, the others not | Not applicable while L-04 is unbuilt | unbuilt | |
| L-06 | Sidebar order `STATUS · NETWORK · CAMERAS · CAM 1 · CAM 2 · LOG · DIAGNOSTICS` | `STATUS · NETWORK · CAMERAS · CAMERA · LOG · DIAGNOSTICS` | drifted | Follows from L-04 |

### 1.2 The placard and the picture

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-07 | A placard reading `CAMERA · <name>` at the left | Present — `CAMERA · FRONT CAMERA` | present | |
| L-08 | The placard's right side reading the transport, codec and mode: `USB · H.264 · 1280×720P30` | Present, but the encoder is appended too: `USB · H264 · 1280×720p30 · v4l2h264enc` | drifted | The blueprint gives the encoder its own readout in the Capture column (L-27) |
| L-09 | The picture drawn at the video's own aspect ratio, no fixed height | Present (`YonderPicture.vue` binds aspect from `loadedmetadata`) | present | |
| L-10 | **A state overlay on the picture**, top-left, four lines: head word, `1280×720 · 15 fps · 1.8 Mb/s`, `1.8 of 0.3–2.0 Mb/s` | **Absent from the page.** `YonderStateOverlay.vue` is built and `YonderPicture.vue` mounts it `v-if="previewState"`; nothing supplies `previewState` | owned — **Task 32** (the preview-state message, R-VID-18) | The component exists; the message does not |
| L-11 | The overlay's head word takes the state: `ADAPTIVE`, `AT THE FLOOR` (caution), `HELD`, `FULL RATE` (select), `STILLS` (fault) | Absent | owned — **Task 32** | |
| L-12 | The overlay carries the round-trip on a poor link: `0.3 of 0.3–2.0 Mb/s · 1.2 s round trip` | Absent | owned — **Task 32** | |
| L-13 | **A step line, top-right of the picture**, on a ladder change only: `dropped to 640×360 — the link could not carry 720p` | Absent | owned — **Task 31** (the ladder) and **Task 32** (reporting it) | |
| L-14 | A foot strip, bottom-left of the picture, of the live control readings — `ZOOM 0  GAIN 0` on the ELP, `PAN +0.0°  TILT +0.0°  ZOOM 1.0×  EV +0.0` on the Pocket 2 | Built (`.y-pic__foot`); not visible in the capture because the media server is not answering | present | Unverifiable from this capture; verified in source |
| L-15 | `LINK 3.10 Mb/s / DROP 0.0 %` in the bottom-right corner of the picture | Built (`.y-pic__foot` link/drop block); not visible in this capture | present | Same caveat as L-14 |
| L-16 | A `REC` pill with elapsed time while recording | Built (`.y-pic__rec`), and fed: `pick-cam-picture` carries `recorder` to it and `YonderPicture` counts from the board's own `since` | present | Task 33b wired it. The elapsed time is counted in the component, not formatted by the daemon — the page reads every five seconds and a pre-formatted string makes a stopwatch that steps in fives |
| L-17 | **A hint centred on the picture, `DRAG TO SLEW · RELEASE TO STOP`, whenever the camera can be aimed** | **Absent.** `gallery/DraftPicture.vue:45` draws it; `YonderPicture.vue` has no equivalent | **unbuilt** | No task names it. Task 25's step list covers the drag layer's *behaviour* and never its affordance |
| L-18 | **A white flash over the whole picture and a centred `● SAVED · TO THIS BOARD` banner** when a still lands | Built (`.y-pic__flash`, `.y-pic__saved`), 1200 ms, restarted by a second still and gated on `held` so a delete never flashes | present | Task 33b. The words for the medium are `heldWords()`'s, shared with the shutter key's own line |
| L-19 | The drag-to-slew orb measured from where the pointer went down | Built and tested (`picture.component.test.ts`) | present | |

### 1.3 The thumbnail strip

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-20 | **A strip under the picture, one thumbnail per camera**, the active one bordered and labelled `Live`, the others labelled `Still · 4 s` | **Absent from the page.** `YonderThumbStrip.vue` is built and mounted by `YonderPicture.vue`; no `cameras` payload reaches it | owned — **Task 34** (the stills strip, R-VID-14) | |
| L-21 | A press on a thumbnail switches camera, and the sidebar follows | Absent | owned — **Task 34**; the sidebar half needs L-04 | |
| L-22 | To the right of the strip, `OTHER CAMERAS` over `12 kb/s of stills · counted in Path total` | Absent | owned — **Task 34** | |

### 1.4 The strip beneath (delivery)

The blueprint draws one strip of delivery facts. The console draws a different
strip of camera facts in the same place.

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-23 | A `● CONFIRMED` pill at the left of the strip | Absent | unbuilt | Nothing owns the camera page's apply-confirmation pill |
| L-24 | `BROWSER 1 viewer` | Absent | owned — **Task 32** (viewers) | |
| L-25 | `GROUND STATION 10.50.x.x:5600` | Absent from the strip; the address appears in the Stream address panel lower down | drifted | |
| L-26 | **Three cost figures, never one sum**: `THIS VIEWER 1.8 Mb/s`, `SHARED ENCODE 1.8 Mb/s`, `PATH TOTAL 4.8 of 5.0 Mb/s` | Absent | owned — **Task 32** (`cost: { mine, shared, path }`) | Spec §15 names the single simulated sum as the thing to replace; the console has neither form |
| L-27 | Over capacity, `PATH TOTAL` turns to caution and reads `4.2 of 3.2 Mb/s · over — the ground station's stream comes first` (R-VID-11) | Absent | owned — **Task 32** | |
| L-28 | *(Not in the blueprint)* A readout strip reading `CAMERA / PICTURE / RATE / BITRATE / UPLINK` | Present in the console | **drifted — and it disagrees with itself** | It reads `PICTURE 3840 × 2160`, `RATE 60 fps`, `BITRATE 20000 kb/s` on the same screen where the placard reads `1280×720p30` and the Stream bitrate control reads `2000 kb/s`. Whatever it is sourcing, an operator reading this page gets two different answers to "what is going out". Worth its own defect number |

### 1.5 The Aim panel

Blueprint: `aim.elp.png` (advertised, not answering) and `aim.pocket2.png`
(present). The bench fixture answers `aim: none`, so the console draws one line
of text and none of the panel. **Every row here is therefore unverifiable from
the capture and was checked against `YonderAim.vue` instead.**

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-29 | An `AIM` legend with an **outlined badge** at the right: `□ RATE CONTROL` when present, `□ NOT ANSWERING` when advertised | Built (`YonderAim.vue:295`) | present | Not reachable by the gate's fixture |
| L-30 | On a camera with no aim at all, the panel collapses to one fact line | Present — `Aim  this camera has none` | present | |
| L-31 | The dial: one thin ring, a crosshair, a haloed puck, axis labels `TILT +`, `PAN`, `ROLL —` | Built (`YonderAimPad.vue`) | present | |
| L-32 | **An axis that will not answer stays on the dial, struck** — the ELP's `ROLL` arc is drawn broken | Built (`aimpad.component.test.ts` asserts the struck axis) | present | |
| L-33 | A **`Reported position` sub-heading** above the two gauges | **Absent** — `YonderAim.vue` renders the gauges with no heading | drifted | |
| L-34 | A `PAN` gauge with `−180° / 0° / +180°` beneath, dashed and em-dashed when dead | Built (`YonderPositionGauge.vue`, `:dead="!hasBounds"`) | present | |
| L-35 | A `TILT` gauge with `−90° / 0° / +90°` | Built | present | |
| L-36 | A **`Commanded rate` block below the gauges**, drawn as a bounded value: `0 °/s` with `0 … 30 °/s` beneath | Present as a bare value **above** the gauges, with no bounds | drifted | Order reversed, and the bounded track the blueprint draws is absent |
| L-37 | A `Gimbal mode` segmented control of three: `Follow │ Tilt lock │ FPV` | Built | present | |
| L-38 | **A sentence under the mode saying what the mode does** — `Pan and tilt follow the handle.` | Present in position but not in substance: `modeSentence` returns `Gimbal mode: ${mode}.`, a restatement of the label | drifted | The blueprint's own note calls for "a sentence under the gimbal mode saying what the mode does" |
| L-39 | The sentence sits **below** the segmented control | It is rendered **above** it | drifted | |
| L-40 | A `Recentre gimbal` key at the foot of the panel | Built | present | |
| L-41 | A caution line for an advertised-but-dead axis: `Listed ±180° in 1° steps. Fifteen values sent, every one acknowledged, the frame never moved.` | A `reason` slot exists (`effectiveReason`); this sentence is a property of the report, not the component | present (mechanism) | Unverifiable — no fixture produces it |
| L-42 | *(Not in the blueprint)* A `● READY` annunciator inside the Aim panel | Present in the capture | drifted | Nothing in the blueprint draws it |

### 1.6 The Capture column

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-43 | **A `MODE` segmented control, `Video │ Photo`, at the head of the column** | Built — `YonderSegmented`, drawn only where the camera offers both | present | Task 33b. The mode is the browser's: not configuration, never an apply, and it does not survive a reload (the operator's own decision) |
| L-44 | **One shutter key that follows the mode** — `○ RECORD` in Video, `PHOTO` in Photo, `● RECORDING 00:13:47` while running | Built — one key, drawn from whichever capability the mode selects | present | Task 33b. It lights and counts from `recorder.since`, the board's own answer, not from a local guess: a page opened after a recording started shows it running |
| L-45 | Beneath the key, where a capture lands (R-CAM-17): `to this board · 118 min free`, or `to the camera's card · no card in the camera` | Built — `captureDestination()` in `yonder-core`, from `recorder.remainingSeconds` against the storage reserve | present | Task 33b. A medium this device cannot measure says so — *this device cannot see what is left on it* — rather than *0 min free*, which is the opposite fact |
| L-46 | In Photo mode the free-space line counts photos: `to this board · 3900 photos free` | Built — the same sentence, from `recorder.remainingPhotos` | present | Task 33b. The count is an estimate at a measured 0.15 bytes per pixel, taken at the pessimistic end; `recorder.ts` says why an estimate beats silence here |
| L-47 | **A `CAPTURES (3) ›` link beside the shutter key** | Built — a link under the key, counting the same listing the panel draws, and pressing it re-reads now rather than at the next poll | present | Task 33b |
| L-48 | **The captures popover**: `CAPTURES · THIS BOARD` / `4 SAVED`, one row per still with a thumbnail, `just now`, `1280×720 · 1.1 MB`, and `VIEW · DOWNLOAD · DELETE` | Built (`ui-yonder-captures`) — **as a panel below the deck, not a popover hanging off the link** | drifted, deliberately — **owner: the operator, to accept or reverse** | A Dashboard 2.x widget cannot render inside another widget's column, and the deck's own columns are 220 px — the constraint the blueprint's popover exists to escape. Everything else is the render: the heading and count, the rows, the relative time, `1280×720 · 1.1 MB`, and the three keys. A recording carries its kind instead of a thumbnail (there is no frame without decoding the file); a camera-held capture is listed and carries none of the three keys (R-CAM-18 — Yonder never saw it); Delete asks on the row before it acts |
| L-49 | A `DEVICE` readout: `usb-1.2 · ELP-USBFHD01M` | Absent from the column; a by-path string appears in a separate `IDENTITY` panel below the deck | drifted | |
| L-50 | An `ENCODER` readout: `v4l2h264enc · hardware` | Absent from the column; folded into the placard (L-08), without the `hardware`/`re-encoded` qualifier | drifted | |
| L-51 | *(Not in the blueprint)* `CAPTURE FORMATS 10` | **Gone.** The formats are offered, in the Stream column's two pickers (L-56) | present | Was K-52's own smaller case: "a count offers nothing". R-CAM-14 asks for the formats offered, not counted, and the row that counted them is removed rather than reworded — the Stream column now offers those same formats, and a count beside it would state the fact twice |
| L-52 | On the Pocket 2: `BATTERY 99 %` and `CARD none` readouts | Not applicable — no Pocket 2 on the bench | deferred — Phase 5 | Gimbal work waits for the camera to return |

### 1.7 The Stream column — *to the ground station*

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-53 | A `STREAM` legend with the qualifier `TO THE GROUND STATION` | Present | present | |
| L-54 | A `BITRATE` segmented control, `Fixed │ Adaptive`, Fixed by default | Present | present | |
| L-55 | In Fixed: a `BITRATE` set bar reading `3.0 Mb/s` with `going out 3.0` beneath | Present, reading `2000 kb/s` | drifted | Unit: the blueprint states Mb/s for a megabit-scale value; the console states kb/s. Same for Preview's Ceiling (L-66) |
| L-56 | **A `RESOLUTION` picker beneath the bitrate, reading `1280×720 · 30 fps`, its options drawn from the probe's own format list** | **Built, as two pickers** — `RESOLUTION` then `FRAME RATE`, in that order, beneath the bitrate bar in the Stream column | **diverges from the render — the operator's decision** | See the note below the table. K-52 is closed |
| L-57 | In Adaptive: the bar becomes a `GOING OUT` readout | Present (`label: adaptive ? 'Going out' : 'Bitrate'`) | present | |
| L-58 | In Adaptive: `FLOOR` and `CEILING` **pickers** appear (`1.0 Mb/s`, …) | Present, but drawn as **set bars**, not pickers | drifted | `columns.adaptive.png` is the reference |
| L-59 | A staged edit shows `Pending · apply on Setup` beneath the control it was made on | Present (`YonderSetBar.vue:17`, `YonderDeck.vue:440`) | present | |

**L-56 diverges from the approved render, deliberately. The operator decided
it, under CLAUDE.md rule 8, and this row is the record of it.**

The blueprint draws **one** picker combining the two — `1280×720 · 30 fps` —
and that works in `gallery/cameras.js` because the mock camera offers one rate
per size. The bench camera offers eight, at ten sizes. A combined picker is
then an **eighty-row menu in which eight rows in every ten differ only in a
trailing number**, read on a page an operator reaches for while an aircraft is
flying. Two pickers is a menu of ten and a menu of eight, and it mirrors the
`SIZE` + `RATE` pair the Preview column already draws (L-64, L-65).

What the render asks for is otherwise met exactly: both menus are the probe's
own list and nothing else (R-CAM-14), the frame-rate menu carries **only the
rates that size reported**, and the pair sits beneath the bitrate bar in the
Stream column as drawn — spec §7 lists Resolution under *Stream · to the
ground station*, and `columns.adaptive.png` draws it in Adaptive too, so it is
not mode-conditional here either.

**Written down because a departure nobody wrote down is how this console
drifted from the blueprint in the first place** — the failure this whole file
exists to make loud. A future reviewer comparing `live.elp.night.png` to a
capture will find one control where the render has one; this row says why, and
who decided.

### 1.8 The Preview column — *to this browser*

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-60 | A `PREVIEW` legend with the qualifier `TO THIS BROWSER` | Present | present | |
| L-61 | A `BITRATE` segmented control, `Adaptive │ Fixed`, Adaptive by default | Present | present | |
| L-62 | A `GOING OUT` readout bar reading `1.8 Mb/s` | Present, reading `400 kb/s` | drifted | Unit, as L-55 |
| L-63 | Beneath it, a line naming the mode, size and rate actually in force: `adaptive · 1280×720 · 15 fps` (`at the floor · 640×360 · 15 fps` when pinned) | **Absent** | owned — **Task 32** | It restates the preview state message |
| L-64 | A `SIZE` picker whose `Auto` rung reads `Auto — steps with the link` and whose others read `1280×720 — hold` | Present | present | |
| L-65 | With `Auto` chosen, `SMALLEST AUTOMATIC SIZE` and `LARGEST AUTOMATIC SIZE` pickers appear | Built (`previewLadderBottom` / `previewLadderTop`) | present | Not visible in the capture — the fixture holds a rung |
| L-66 | A `RATE` picker | Present | present | |
| L-67 | `FLOOR` and `CEILING` **pickers** reading `300 kb/s` and `2.0 Mb/s` | Present as **set bars** reading `300 kb/s` and `2000 kb/s` | drifted | Kind and unit both |

### 1.9 Exposure and Colour

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-68 | `AUTO EXPOSURE` as a **segmented control offering exactly `Aperture priority │ Manual`** (spec §15's correction, menu ids 3 and 1) | A **picker** reading `Aperture Priority Mode` — the raw V4L2 menu label | drifted | The blueprint is authoritative; the console shows the device's word where the blueprint shortens it |
| L-69 | `SHUTTER` gated, drawn `—— µs` over a dashed track | Present | present | |
| L-70 | The gate's reason stated as **the condition**: `while auto exposure is aperture priority` | `auto exposure has it` | drifted | Blueprint names the state that closes the control; the console names the owner |
| L-71 | The ELP shutter reads **raw × 100 µs, step 100** — raw 156 is `15 600 µs` (spec §15) | Unverifiable — the control is gated in every committed capture | — | Spec §15 lists this as a blueprint correction already applied. **See C-1** |
| L-72 | `GAIN` as a set bar **on Live** | **Absent from Live** — deferred to Setup under `HOUSEKEEPING` (`setupOnly: true`) | drifted | **See C-2** |
| L-73 | `BACKLIGHT` as a set bar **on Live**, reading `54` | **Absent from Live** — on Setup as `BACKLIGHT COMPENSATION` | drifted | **See C-2**; the label also lengthened |
| L-74 | A `COLOUR` legend | Present | present | |
| L-75 | `WHITE BALANCE` as `Auto │ Manual` | `AUTO WHITE BALANCE` as `Off │ On` | drifted | Label and option words both |
| L-76 | `TEMPERATURE` gated, `—— K`, reason `while white balance is auto` | Present, reason `auto white balance has it` | drifted | As L-70 |
| L-77 | `BRIGHTNESS`, `CONTRAST` set bars | Present | present | |
| L-78 | `SATURATION`, `HUE` set bars | Present, in the Colour group | present | The blueprint puts `SATURATION`/`HUE` in the fourth column under Rendering; the console puts them in Colour |
| L-79 | On the Pocket 2: `EXPOSURE` picker `Program`, `ISO` and `SHUTTER` gated `while exposure is program` | Not applicable — Phase 5 deferred | deferred — Phase 5 | |

### 1.10 Optics, Rendering, Orientation

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-80 | `FOCUS` as a segmented `Auto │ Manual` | `AUTO FOCUS` as `Off │ On` | drifted | As L-75 |
| L-81 | A gated `FOCUS` bar, reason `while focus is auto` | Present, reason `auto focus has it` | drifted | As L-70 |
| L-82 | `ZOOM` as a set bar **with no unit on the ELP** (spec §15: no × ratio is established for it) | Present, `ZOOM 0`, no unit | present | |
| L-83 | On the Pocket 2, `ZOOM 1.0 ×` with the note `digital · the feed does not change, the browser crops` | Not applicable — Phase 5 deferred | deferred — Phase 5 | |
| L-84 | A `RENDERING` legend with `GAMMA` | Present | present | |
| L-85 | `SHARPNESS` **on Live**, with the note `over-sharpening spends uplink on edges` | **Absent from Live** (`setupOnly`); on Setup **without the note** | drifted | **See C-2**; the note is absent on both surfaces |
| L-86 | An `ORIENTATION` legend on **every** camera (R-CTL-05, R-CTL-15) | Present in the working tree; **absent from the committed capture**, which predates `d25cc95` | present | Committed-capture staleness, not a gap |
| L-87 | `MIRROR` as `Off │ On` | Present | present | |
| L-88 | `FLIP` as `Off │ On` | Present | present | |
| L-89 | `ROTATION` as a picker offering `0°`, `90°`, `180°`, `270°` | Present as a picker | present | |
| L-90 | **One line under the group** naming who is turning the picture and what it costs: `the board is doing this, at a cost per frame` | A line repeated **under each of the three controls** — `the board turns this after decoding` — plus one group line, `this camera cannot turn the picture itself, so the board turns it after decoding`. **The per-frame cost is stated nowhere** | drifted | The blueprint's README is explicit that the cost is the point and the tone is neutral: "a known, real per-frame cost is a fact, not a warning" |

### 1.11 Outputs and the rail

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-91 | **On Live**, outputs as one line of facts: `OUTPUTS  Ground station 3.0 Mb/s   RTSP idle · nothing can reach it over cellular   SRT off` | A full On/Off table on Live, identical to Setup's | drifted | The blueprint deliberately keeps Live read-only here |
| L-92 | **On Live**, a right-aligned link `stop or start them on Setup ›` | **Absent** | unbuilt | Follows from L-91 |
| L-93 | An `SRT` output row | **Absent** — only `RTP · to the ground station` and `RTSP · a player connects` | unbuilt | Nothing owns an SRT output |
| L-94 | Output labels `GROUND STATION`, `RTSP`, `SRT` | `RTP · to the ground station`, `RTSP · a player connects` | drifted | |
| L-95 | **One rail**, `LIVE · SETUP · STREAM ADDRESS`, with `FULL RATE` right-aligned and reading `3.1 Mb/s while held` (R-VID-13) | **Three separate boxes**: the deck's own `LIVE │ SETUP` rail, then a facts panel, then a second rail `START │ STOP │ SETUP` with `FULL RATE` in a box beside it | drifted | The `FULL RATE` hold key exists and reads `2.07 Mb/s while held` |
| L-96 | `STREAM ADDRESS` as a key on that one rail | Present, but on the *second* rail, and only on Setup | drifted | |
| L-97 | **The rail is sticky (`position: sticky; bottom: 0`) and stays reachable while the deck scrolls** (spec §5) | **Absent.** `fold.1440.png` shows the rail stuck at the foot of the 900 px viewport; `camera-live-notebook.day.fold.png` shows no rail at all — it is below the fold and scrolls away | **unbuilt** | Task 27 step 3 says the gate should assert "the rail's box inside the viewport at scroll bottom (the sticky rail)". The gate passes; the rail is not sticky. **This is a gate assertion that is not catching what it names** |
| L-98 | *(Not in the blueprint)* A `RUNNING` / `IDENTITY` facts panel below the deck | Present | drifted | Extra surface the blueprint does not draw |
| L-99 | *(Not in the blueprint)* A `BEFORE YOU PRESS START` panel | Present | drifted | Extra surface |
| L-100 | *(Not in the blueprint)* `START` and `STOP` keys | Present | drifted | Extra surface — the blueprint has no pipeline start/stop on the camera page |

### 1.12 Layout contract

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| L-101 | At 1440×900 the picture, the Aim panel **and the Capture column** are all above the fold (`fold.1440.png`) | The picture, the readout strip, the placard and the head of the Capture column are above the fold | present | Aim is beside the picture and inside the fold |
| L-102 | One vertical page scroll; no nested deck scroller; no horizontal overflow (`fullpage.1440.png`) | Held — the gate measures it | present | |
| L-103 | **Every group sits in a fixed column; toggling Stream `Fixed → Adaptive` moves no group heading's x position** (`columns.fixed.png` / `columns.adaptive.png`) | Present — `SLOTS` in `YonderDeck.vue` assigns each group one slot | present | |
| L-104 | Four columns: `[Capture, Stream] [Preview] [Exposure, Colour] [Optics, Rendering, Orientation, Housekeeping]`, Capture first so the viewport contract holds | Present — the same four slots, same order | present | |
| L-105 | At ≤1100 px Aim drops below the picture and groups flow to fewer columns | Present (`camera-live-tablet.*.png`) | present | |

---

## Surface 2 — Camera · Setup

Blueprint: `setup.elp.night.png`, `setup.pocket2.night.png`.
Capture: `camera-setup.night.png` / `.day.png`.

Setup is Live plus four bench-only fields and the Apply/Discard flow. **Every
row from Surface 1 applies here too and is not repeated** — only what differs
is listed.

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| S-01 | A `NAME` text field in the Stream group, defaulting `Cam 1` / `Cam 2`, with the note `shown on this page, in the camera list and on the stream address` | Present, defaulting to the card name (`Front camera`), with the same note | present | The `Cam N` default is R-UI-27's; the console uses the card name instead |
| S-02 | A `HOUSEKEEPING` legend carrying `MAINS FREQUENCY` as a picker (`50 Hz`) | Present | present | |
| S-03 | Setup adds **only** name, mains frequency, record format and sensor size — everything else the camera has is on Live too | Setup also adds `GAIN`, `BACKLIGHT COMPENSATION` and `SHARPNESS`, which the blueprint draws on Live | drifted | **See C-2** — this is L-72/L-73/L-85 restated from Setup's side |
| S-04 | A `RECORD FORMAT` bench-only field | **Absent** | unbuilt | The blueprint's README names it as one of the four; no render shows it on the ELP, and Phase 5 holds the Pocket 2 |
| S-05 | A `SENSOR SIZE` bench-only field | **Absent** | unbuilt | As S-04. An untracked capture `camera-live-sensor-turns.night.png` suggests the other session is working near this |
| S-06 | **A `PENDING CHANGES` panel at the top of the page**, above the picture, with a right-hand qualifier `2 · APPLY OR DISCARD ON THE RAIL` | Present as `Pending changes · 2`, with no qualifier | drifted | |
| S-07 | One row per staged change: **the control's label** (`BITRATE`, `SIZE`), then the requested value | One row per staged change: **the raw draft path** (`previewSize`), then the requested value | drifted | An operator reads labels, not the model's key names |
| S-08 | Each row carries its interruption, right-aligned — `no interruption known`, `may restart the preview branch` — **including the blank case, stated** | Interruptions are drawn as separate lines beneath the list, and a row with no known interruption says nothing | drifted | The blueprint states the blank case on purpose |
| S-09 | The `SETUP` key on Live carries the pending count when read from Live | Present (`Setup · N`) | present | |
| S-10 | The outputs table on Setup with `On │ Off` per row | Present for two of three rows (L-93: no SRT) | drifted | |
| S-11 | The outputs legend carries a right-aligned annunciator `1 UNREACHABLE` | **Absent** | unbuilt | The per-row reachability sentences are present; the count is not |
| S-12 | The rail reads `LIVE · SETUP · STREAM ADDRESS · DISCARD · APPLY`, with `APPLY` in the select tone | The deck rail reads `LIVE │ SETUP │ DISCARD │ APPLY` (Apply in the select tone); `STREAM ADDRESS` is on a second rail with `LIVE │ RE-PROBE` | drifted | As L-95/L-96 |
| S-13 | No `FULL RATE` key on Setup | Correct — it is on Live only | present | |
| S-14 | No Aim group on Setup | Correct | present | |
| S-15 | *(Not in the blueprint)* A stream-address panel with `GSTREAMER`, `GROUND STATION`, `APPLICATION SINK` and `RTSP URL` lines, each with a `COPY` key, and two reachability sentences | Present | drifted | Extra surface. R-VID-15 and R-UI-24 justify it; the blueprint reduces it to one rail key |
| S-16 | *(Not in the blueprint)* A `RE-PROBE` key | Present | drifted | Extra surface |
| S-17 | Confirmation where a change is load-bearing (spec §5) | Not visible in any committed capture | — | Unverifiable; §15 lists the Apply/Discard flow as a blueprint correction, since applied |

---

## Surface 3 — Cameras

Blueprint: `cameras.night.png` (night only — there is no day render).
Capture: `cameras.night.png`, `cameras.day.png`.

| # | The blueprint shows | Today | Class | Note |
|---|---|---|---|---|
| C-01 | A panel legend `CAMERAS` | Present | present | |
| C-02 | A right-hand qualifier `2 FOUND · 2 REJECTED · DETECTED 14:22:06` | `1 FOUND · 4 REJECTED` — **the detection time is absent** | drifted | "When did it last look?" is the question a sweep raises |
| C-03 | A `FLYING` sub-heading over the usable cameras | Present | present | |
| C-04 | **A thumbnail per camera row** | **Absent** — the row's left cell is empty | unbuilt | Related to L-20; Task 34 owns per-camera stills, but nothing names this row's thumbnail |
| C-05 | The camera's name in the row (`Nose`) | Present (`Front camera`) | present | |
| C-06 | Beneath the name, the kind: `USB · UVC`, `USB ACCESSORY` | `USB · /DEV/VIDEO0` — the socket, not the kind | drifted | The socket is already in the detail line |
| C-07 | A format line: `1280×720 · 30 fps · H.264 hardware` / `H.264 re-encoded` | `H264 · 1280×720p30` — **the `hardware`/`re-encoded` qualifier is absent** | drifted | Whether the board is spending CPU on this camera is the row's most operational fact |
| C-08 | **A curated probe summary**: `usb–1.2 · ELP–USBFHD01M · aim: unanswered · zoom: present` | A raw capability dump of twenty-odd `key: value` pairs wrapping over six lines | drifted | Task 24's step 1 says "the probe summary"; what shipped is the whole report |
| C-09 | A state pill: `● STREAMING` (ok tone) / `● IDLE` | `● IDLE` present | present | The streaming tone is unreachable with this fixture |
| C-10 | The row's current rate, `3.0 Mb/s` | `none` | present | Correct for a camera that is not streaming |
| C-11 | A chevron `›` opening the camera | An `OPEN ›` key | drifted | Equivalent affordance, different form |
| C-12 | A `SEEN, AND NOT USABLE` sub-heading with a right-aligned `WHY` | Present | present | |
| C-13 | A rejection row per device with its reason | Present, four rows | present | |
| C-14 | The K-40 explanation as a **second, italic line**: `Listed because it looks like a camera to everything that asks (K-40).` | Folded into the same sentence on every row: `…not a camera; it advertises formats it cannot capture (K-40)` | drifted | The blueprint separates the fact from the reason it is listed at all |
| C-15 | **A `THIS BOARD` panel with an `ENCODING USED` meter**, a segmented track with a marker, reading `21 %` | **Absent — the whole panel** | **unbuilt** | CLAUDE.md rule 7 names this as one of the three that went missing. `YonderBudget.vue` models the uplink only; nothing models encode capacity |
| C-16 | **Beneath the meter, `room for one more 1080p30 stream`** | Absent | **unbuilt** | The meter's actual point: not a percentage, an answer |
| C-17 | An `UPLINK` panel legend with `ALL CAMERAS` | A panel reading `LEAVING THIS AIRCRAFT, AT IP` | drifted | |
| C-18 | The uplink figure `3.4 of 3.2 Mb/s`, in caution when over | `1356.0 of 5.0 Mb/s` | drifted — **and wrong** | Its own breakdown on the line below sums to 4.6 Mb/s. The reading and its parts disagree; worth its own defect number |
| C-19 | A per-source breakdown: `Nose 3.0 Mb/s   Previews 0.4 Mb/s` | `Front camera · rtp 2.1 Mb/s · Front camera · rtsp 2.1 Mb/s · Front camera · preview 0.4 Mb/s` | drifted | Blueprint groups previews; the console lists every output |
| C-20 | **A line saying what starting another camera would cost**: `starting the gimbal would need 2.1 more` | **Absent** | unbuilt | The headroom question again, from the uplink side |
| C-21 | A rail key `DETECT AGAIN` | Present, named `SWEEP AGAIN` | drifted | |
| C-22 | **A rail key `ADD BY ADDRESS`** (spec §5) | **Absent** | **unbuilt** — this is **K-54**'s first half | K-54: "no task in the implementation plan owns it" |
| C-23 | **Any action that configures a detected camera** | **Absent** — the page has one soft key | **unbuilt** — this is **K-54**'s second half | Not drawn in the blueprint either, and it is the commoner case: the board already has the socket, the card name and the format list. **The blueprint is silent here too — see C-4** |
| C-24 | A rail key `APPLY`, in the select tone | **Absent** | unbuilt | Nothing on this page stages anything today, so there is nothing to apply — but the blueprint draws a page that does |
| C-25 | Rows open their camera (spec §5) | Present — `OPEN ›` | present | |
| C-26 | A day palette of this page | The console has one; **the blueprint does not** | — | Blueprint gap, not a console gap |

---

## The four surfaces with no blueprint

Status, Network, Log and Diagnostics ship with no approved picture (finding
B-01). Nothing can be *absent* from a drawing that does not exist, so these
sections do the other half of the job: they inventory what the console draws
today, as checkable claims, so that a blueprint can be drawn against them and
so these rows can be checked the moment one is.

**Read the mask rule first.** `scripts/capture-pages.mjs` paints an opaque
`#8b8f94` block over every reading listed under `masked` in
`scripts/fixtures/specimens.json`, so the committed capture carries no secret
and no value that changes on every run. On these pages the masked set is
`CPU LOAD`, `CPU TEMP`, `MEMORY`, `SIGNAL`, `QUALITY` — five gauges whose
needle and text would otherwise disagree — **and the whole text of the
`CHANGE PENDING` annunciator.** A grey block on these pages is the gate
working, not a rendering fault. See finding B-02 for what that costs.

`specimens.json` also sets every field to its widest honest value
independently, so these pages are **not portraits of one device in one
state**. Contradictory-looking pairs below are that, and are marked.

---

## Surface 4 — Status

Capture: `status.night.png` / `.day.png` (1280×1244), plus
`status-without-modem`, `status-pending`, `status-pending-radio`,
`status-psk-changed`. Day and night are identical in content on all five.

| # | The console draws today |
|---|---|
| ST-01 | An app bar: `YONDER` in the accent, a divider rule, and `Status` on a second line beneath it. The bar is empty right of x≈200 |
| ST-02 | A sidebar: `STATUS · NETWORK · CAMERAS · CAMERA · LOG · DIAGNOSTICS`, `STATUS` selected |
| ST-03 | **`STATUS` is the only sidebar entry with no icon** — blank space where the glyph sits on the other five, in both palettes, selected or not |
| ST-04 | Four group headings: `THIS BOARD`, `REACHABLE BY`, `REMOTE`, `IF YOU LOSE THIS CONSOLE` |
| ST-05 | `THIS BOARD` carries three gauges — `CPU LOAD`, `CPU TEMP`, `MEMORY` — each a track, a coloured band and a **masked** value |
| ST-06 | `THIS BOARD` carries four readouts: `BOARD` `Raspberry Pi Compute Module 4 Rev 1.1`; `UP FOR` `59 minutes 59 seconds`; `YONDER` `1.0.0-rc.1+build.42`; `SYSTEM` `Debian GNU/Linux 12 (bookworm)` |
| ST-07 | `REACHABLE BY` carries a fault-toned pill `NOTHING` with a lamp dot, and beneath it `Ethernet is carrying traffic, and nothing has stood down` — *the pair contradicts itself by specimen design, not by fault* |
| ST-08 | `REACHABLE BY` carries two gauges, `SIGNAL` and `QUALITY`, both **masked** |
| ST-09 | `REACHABLE BY` carries `OPERATOR` `Telefonica Moviles Espana SAU`; `NETWORK` `5GNR`; `ADDRESS` `255.255.255.255` (accent tone) |
| ST-10 | `REMOTE` carries one readout labelled `Remote` reading `Authorised, not reaching the network` — **a heading and its own label are the same word, one under the other** |
| ST-11 | `IF YOU LOSE THIS CONSOLE` carries `JOIN` `yonder`; `PASSPHRASE` `yonder1234`; `AT` `192.168.77.1`; `OR` `yonder.local` |
| ST-12 | Beneath them, verbatim: `Join that network from a phone or a laptop and open this console at either address above, on the port you are using now. Worth photographing before you change anything: it is what gets you back in when this page stops answering.` |
| ST-13 | A foot rail with exactly two keys, `DAY` and `NIGHT`, one divider, and ~74 % of its width empty |
| ST-14 | **The rail shows no selected palette** — `DAY` and `NIGHT` are the same colour as each other in both captures, with no fill, weight, underline or lamp to separate them |
| ST-15 | The rail's group has a rule drawn above it and **no heading text** |
| ST-16 | `status-without-modem`: the two gauges vanish (the page is exactly 120 px shorter) **but the modem's operator, network and address are still printed** |
| ST-17 | `status-pending`: a `CHANGE PENDING` group above `THIS BOARD` with an amber pill whose **entire text is masked**, two paragraphs, and an in-group key row `CONFIRM` (magenta — the only magenta control on any of these pages) and `REVERT NOW` |
| ST-18 | `status-pending-radio`: the same group with different prose and **one key only, `REVERT NOW`** — no `CONFIRM`, no divider |
| ST-19 | `status-pending`: `OR` reads `yonder-under-test.local`; every other status capture reads `yonder.local` |
| ST-20 | `status-psk-changed`: the page is `status` with exactly one cell changed — `PASSPHRASE` reads `changed — the one you set` |

---

## Surface 5 — Network

Capture: five tabs — `network-interfaces`, `network-wi-fi`, `network-zerotier`,
`network-cellular`, `network-activity` — plus five state variants. All
1280×900. Day and night are identical in content throughout.

| # | The console draws today |
|---|---|
| N-01 | The same app bar and sidebar as Status, `NETWORK` selected in all ten captures |
| N-02 | A tab strip: `INTERFACES · WI-FI · ZEROTIER · CELLULAR · ACTIVITY`, the active tab underlined in the accent; the strip's right half is empty |
| N-03 | **No soft-key rail at the foot of the viewport on any Network capture** — where keys exist they sit inside the panel |
| N-04 | `INTERFACES`: three groups, `Ethernet`, `Cellular`, `Wi-Fi`, each with an annunciator and a qualifier sentence |
| N-05 | `INTERFACES` annunciators take five values across the variants: `NOT YET TESTED`, `DOWN`, `READY` (green), `NOT REACHING` (red), `NO INTERFACE` |
| N-06 | `INTERFACES` carries one soft key, `REFRESH`, and one readout, `Address` `255.255.255.255/32` |
| N-07 | `INTERFACES` carries an unlabelled fault-toned line, `The modem reported a failure: esim-without-profiles`, **owned by no heading and no annunciator**, centred here and right-aligned on the Cellular tab |
| N-08 | `INTERFACES`: the annunciator pills are left-aligned to the second column's start, leaving ~355 px of dead space to the panel edge; the `Address` value is right-aligned to x≈925, aligning with nothing |
| N-09 | `WI-FI`: no heading, no readout, no annunciator. Five controls — `USE ACCESS POINT`, `SCAN`, a `Network` picker reading `No options available`, a `Password` field, and `JOIN` |
| N-10 | `WI-FI`: **the `Network` picker draws no chevron**, so it is visually a text field |
| N-11 | `ZEROTIER`: readouts `Status` `Authorised, not reaching the network`; `Path` `Relayed`; `Latency` `9999 ms`; `Network name` `Yonder field operations mesh`; `Network` `8286ac0e47d5f2c1`; `Traffic`; `Throughput`; `Last heard` `59 min ago` |
| N-12 | `ZEROTIER`: `THIS DEVICE` and `ADDRESS` are **empty em-dash rows** whose styling reads ambiguously between a section heading and a readout label |
| N-13 | `ZEROTIER`: a fault state is carried as **plain uncoloured readout text with no annunciator**, where `INTERFACES` gives the same condition a red `NOT REACHING` pill |
| N-14 | `ZEROTIER`: a chart area drawn empty with `not enough data yet`, and an `RX`/`TX` legend; controls `Network ID`, `JOIN`, `LEAVE` — `JOIN` and `LEAVE` both live at once on a joined network |
| N-15 | `CELLULAR`: no group heading at all; an annunciator (`NOT YET TESTED` / `NO MODEM` / `READY`); two gauges `SIGNAL` and `QUALITY`, both **masked** |
| N-16 | `CELLULAR`: nine readouts — `OPERATOR`, `NETWORK`, `REGISTERED`, `RSSI` `−113 dBm`, `RSRQ` `−20 dB`, `APN`, `ADDRESS`, `MTU` `9000`, `COMPOSITION` `MBIM` |
| N-17 | `CELLULAR`: four fields — `APN` `ereseller`, `Dial number` (empty), `Username` `sim-user`, `Password — set, leave blank to keep it` (empty) |
| N-18 | `CELLULAR`: **two different things are both labelled `APN` on one screen** — the readout says `internet.mnc001.mcc234.gprs`, the field says `ereseller` |
| N-19 | `CELLULAR`: an in-panel rail, `TEST NOW` then `CONNECT`, nothing right-aligned |
| N-20 | `network-cellular-without-modem`: the gauges vanish and the readouts dim, **but every modem value is still printed and legible while the pill says `NO MODEM`**; `TEST NOW` and `CONNECT` look enabled |
| N-21 | `network-cellular-pending`: a masked amber pending pill, the same two paragraphs Status uses, and an in-panel `CONFIRM` / `REVERT NOW` rail — **two rails and four keys on one screen**, with no visual ranking between the rollback pair and the ordinary pair |
| N-22 | `The modem reported a failure: esim-without-profiles` **wraps mid-token** (`esim-without-` / `profiles`) wherever it lands in a half-width column |
| N-23 | `ACTIVITY`: a table whose message column **has no header**; six identical rows; **no filter, pause, follow, clear or export** |
| N-24 | `ACTIVITY`: **the last row is clipped by the panel's bottom edge** — its second line is cut entirely and its timestamp sliced through, with no scroll affordance. Verified at magnification |

---

## Surface 6 — Log

Capture: `log.night.png` / `.day.png` (1280×900, viewport height). Day and
night identical in content.

| # | The console draws today |
|---|---|
| LG-01 | One group, `ACTIVITY`, and **no soft-key rail of any kind** |
| LG-02 | One control: a full-width `Search` field with a magnifier glyph, empty |
| LG-03 | Three column headers: `Time (UTC)` — wrapping onto two lines in its cell — `Level`, `What happened` |
| LG-04 | Twelve rows, every one identical: `23:59:59` / `error` / `network: cellular is reaching the internet again at 2026-09-06T23:59:59.999Z; ethernet goes on carrying traffic and cellular is back in the running behind it` |
| LG-05 | **`error` is drawn in the ordinary body tone** — no colour, pill, badge or icon on a fault level, twelve times over |
| LG-06 | **The twelfth row is clipped mid-glyph** by the table's fixed height (table bottom y≈856 inside a 900 px viewport), with no scrollbar or affordance saying more exists |
| LG-07 | No annunciator, pill or badge anywhere on the page |
| LG-08 | No pagination, no rows-per-page picker, no level filter, no download, no clear |

---

## Surface 7 — Diagnostics

Capture: `diagnostics.night.png` / `.day.png` (1280×900). Day and night
identical in content.

| # | The console draws today |
|---|---|
| DG-01 | Two side-by-side panels, `PING A HOST` (left) and `REACHABILITY` (right) |
| DG-02 | `PING A HOST`: a field whose placeholder is `* Host name or IPv4 address` — the asterisk is inside the placeholder — and two keys, `PING` (filled) and `CLEAR` (outlined) |
| DG-03 | `PING A HOST`: three readouts, `Host`, `Replies`, `Round trip (ms)`, all **empty** — blank, not masked; nothing composes a value until a probe runs |
| DG-04 | `REACHABILITY`: the line `Sends a few packets to a public address. A network that blocks them reports no reply while working perfectly well.`, with `no reply` in italics |
| DG-05 | `REACHABILITY`: two readouts, `Probed` and `Replies`, both empty |
| DG-06 | **`Replies` appears twice on one page**, in both panels, with nothing distinguishing them |
| DG-07 | A foot rail with one key, `CHECK REACHABILITY`, no divider, ~83 % empty |
| DG-08 | **No `DAY` / `NIGHT` keys.** The palette toggle is on Status only — Log has no rail at all |
| DG-09 | **The two panels do not align at the bottom** — the left card ends ~107 px lower than the right, though the shape JSON records both groups at the same height |
| DG-10 | 349 px — 39 % of the page height — below the rail is bare background |
| DG-11 | No annunciator, pill or badge anywhere on the page |

### B-02 — the gate cannot photograph the rollback countdown

The `CHANGE PENDING` annunciator is masked in every committed capture, on
Status and on Network alike. It is the annunciator that tells an operator a
configuration change is unconfirmed and how long is left before the device puts
the old one back — **the surface of R-CFG-03 and R-NET-07, the two
load-bearing safety mechanisms in the product.**

The mask is right: the countdown changes on every run, and an unmasked capture
would churn the repository for ever. But the consequence is that **no committed
picture has ever shown that annunciator's words**, and the one mechanism that
could compare the console to a drawing is blind to it. There is no blueprint
render of it either (B-01), so it has never been drawn and can never be
photographed.

**The call for the operator:** how the confirmation timer gets a fidelity check
at all — a substituted specimen that freezes the countdown, a separate
unmasked artifact the gate keeps out of git, or a blueprint render it is
compared to by hand.

---

## Conflicts — the operator's to decide

Each of these collides with something. Both sides are stated; none is
resolved.

### C-1 · The ELP shutter conversion may be wrong in the blueprint itself

**The blueprint says** raw × 100 µs, step 100 — raw 156 reads `15 600 µs` —
and its README records this as spec §15's correction, applied to both mockups.

**Spec §15 says** the conversion was wrong in both mockups and must be
corrected; the README says it has been. **`docs/superpowers/specs/…§15` is the
list of corrections the blueprint still owed**, so a reader cannot tell from
the two documents alone whether the current renders are the corrected ones.

**The console** cannot be compared either way: the shutter is gated in every
committed capture, so no capture shows a converted value.

**The call:** whether §15's shutter item is closed, and if so whether the spec
should say so. Until it is closed, `descriptors.ts` and the blueprint could
drift again with nothing to catch it.

### C-2 · `setupOnly` puts three Live controls on Setup

**The blueprint says**, in its own README of settled decisions: "**Live carries
every control the camera has.** Setup adds only four bench-only items: name,
mains frequency, record format, sensor size." `live.elp.night.png` draws
`GAIN`, `BACKLIGHT` and `SHARPNESS` on Live.

**The console says**, in `YonderDeck.vue`'s own comment: "`setupOnly` marks the
four housekeeping controls this deck draws only on Setup — mains frequency,
backlight compensation, gain and sharpness: real settings, rarely touched, that
do not need to compete for space with Exposure and Colour on the page an
operator watches while flying."

Both are reasoned. The console's reason is a real one — deck density on a page
watched in flight. But it was decided in a code comment, against an approved
picture that says the opposite, and no requirement records it.

**The call:** either the three controls come back to Live, or the blueprint's
README and the renders change and a requirement records why.

### C-3 · Sidebar section headings may be beyond the substrate

**The blueprint says** the sidebar carries a `CAMERAS` heading with one entry
per camera beneath it, and a `SYSTEM` heading above `LOG` and `DIAGNOSTICS`.

**The console** has a flat list of six pages declared in `flows/flows.json`.
Node-RED Dashboard 2.x owns the sidebar; whether it can render section headings
and dynamically-added pages **was not verified in this audit** (the package is
not installed in this worktree). If it cannot, this is a substrate limit and
the blueprint asks for something the shell cannot give.

**The call:** verify what Dashboard 2.x's navigation supports, then either
build L-02/L-03/L-04 or record the limit against R-UI-03 and redraw the
sidebar. **Do not let "probably not supported" close it** — that is exactly the
unowned deferral rule 7 was written about.

### C-4 · Adopting a detected camera is in no picture and no requirement

**The operator hit this** (K-54): a second camera attached, the Cameras page
showed it, and nothing could be done with it.

**The blueprint draws** `ADD BY ADDRESS`, which reads as adding a *network*
camera by URL — a camera the board cannot detect at all. It does **not** draw
an action for adopting a camera the board has already found.

**Spec §5 names** three things the page must do: "Rows open their camera;
Detect again; Add by address." Adopting a detected camera is none of them.

So this gap is not merely unbuilt: **the blueprint is silent about the commoner
case**, and a manifest built from the blueprint alone would not have caught it
either. That is a limit of this file worth stating plainly.

**The call:** whether adopting a detected camera is one action or two
alongside `ADD BY ADDRESS`, what it is called, and a requirement to hang it on.

### C-5 · Task 29 claims an outcome the flow does not show

**The plan says** Task 29 step 1: "one Dashboard page per detected camera
(R-UI-03)". **Commit `75f8c46`** is titled "a camera's name is the operator's;
**one page per camera**; the stream address".

**The flow has** one static `ui-page` named `Camera`, and no code anywhere in
`packages/` or `scripts/` creates a `ui-page`.

Either the requirement is met by a single page that opens whichever camera was
pressed — in which case the plan's wording and the blueprint's sidebar are both
wrong — or the task is not done and was recorded as done.

**The call:** which of those it is. This is not a code question; it is a
question about what R-UI-03 requires.

---

## The two filed defects, confirmed against the blueprint

**K-52 — the ground station's stream has no resolution or frame-rate control.
Confirmed, and since closed.** `live.elp.night.png` and `setup.elp.night.png`
both draw a `RESOLUTION` picker in the Stream column reading `1280×720 · 30
fps`, directly beneath the bitrate bar; `columns.adaptive.png` draws it in
Adaptive too, so it is not a mode-conditional control. No committed capture
showed it, and `YonderDeck.vue` staged no `width`, `height` or `framerate`.

It is now built — **as two pickers rather than one, which the operator decided
under rule 8**; the reasoning and the record are under §1.7's table. K-52's
smaller case was **L-51**, `CAPTURE FORMATS 10` stating a number where R-CAM-14
asks for the formats: that row is gone, because those formats are what the two
pickers now offer.

**K-54 — a detected camera cannot be configured from the console. Confirmed,
and it is two gaps, not one.** `cameras.night.png` draws a rail of three keys,
`DETECT AGAIN · ADD BY ADDRESS · APPLY`; the console draws one, `SWEEP AGAIN`.
So `ADD BY ADDRESS` is **C-22, unbuilt, no owner** and `APPLY` is **C-24**. The
case the operator actually hit — adopting a camera the board has *already*
found — is **C-23**, and the blueprint does not draw it either: see **conflict
C-4**. K-54's own reading is the right one, and this manifest could not have
caught the second half of it.

---

## How these were missed

Five mechanisms, each visible more than once above.

**1 · A deferred concern with no owner.** K-52's resolution picker was named by
Task 28's own implementer, recorded in the plan's ledger, and picked up by
nobody. L-17, L-23, L-92, L-93, S-04, S-05, S-11, C-04, C-15, C-16, C-20,
C-22 and C-24 are all in the same state now: real gaps, no owner, invisible to
every diff.

**2 · The gate photographs one capability state.** The camera pages are
captured against a single fixture whose camera answers `aim: none` and gates
shutter, focus and temperature. The blueprint draws four states across two
cameras. Most of the Aim panel, every `advertised` reading, and the whole Photo
path are outside anything the gate has ever rendered — so a regression in them
would not change a single committed pixel.

**3 · A capture that is stale against its own code.** The committed
`camera-live.*.png` predate the Orientation commits. An auditor reading
committed captures alone would have filed Orientation as unbuilt. **A capture
is evidence only if it was rendered from the commit it sits in**, and nothing
enforces that.

**4 · A gate assertion whose wording does not test what it names.** Task 27's
step 3 says the gate asserts "the rail's box inside the viewport at scroll
bottom (the sticky rail)". A rail that is simply the last thing on the page
satisfies that sentence exactly as well as a sticky one does. The gate passes
at 160/0, the assertion is written down, and the rail is not sticky (L-97). An
assertion that cannot fail reads, in every review, like one that can.

**5 · The mask hides the thing most worth checking.** The rollback
confirmation annunciator is masked in every committed capture, correctly, and
so has never been seen in a picture anybody reviews (B-02).

---

## Summary

| Surface | Elements | Present | Absent (unbuilt) | Absent (owned) | Drifted | Deferred | Not checkable |
|---|---:|---:|---:|---:|---:|---:|---:|
| Camera · Live | 105 | 41 | 11 | 15 | 34 | 3 | 1 |
| Camera · Setup | 17 | 5 | 3 | 0 | 8 | 0 | 1 |
| Cameras | 26 | 8 | 7 | 0 | 10 | 0 | 1 |
| **Compared against a blueprint** | **148** | **54** | **21** | **15** | **52** | **3** | **3** |
| Status | 20 | — | — | — | — | — | 20 |
| Network | 24 | — | — | — | — | — | 24 |
| Log | 8 | — | — | — | — | — | 8 |
| Diagnostics | 11 | — | — | — | — | — | 11 |
| **Inventoried, no blueprint** | **63** | — | — | — | — | — | **63** |
| **Total** | **211** | **54** | **21** | **15** | **52** | **3** | **66** |

**Conflicts: 5** (C-1 … C-5), listed above. They are counted in their
surface's other columns as well, where they describe a concrete difference.

**L-56 is counted *present*, and it is the one row where that word needs a
qualification.** It is built and it does not match the render: one combined
picker in the blueprint, two on the console, the operator's decision under rule
7's own escape hatch in rule 8. Counting it *drifted* would file a decided
divergence with the accidents, and counting it *unbuilt* would be false. The
row and the note under §1.7 carry what the count cannot.

Rows are counted once. *Deferred* is Phase 5 only — the Pocket 2, which the
operator has already deferred until the camera returns; those elements are
recorded against the blueprint anyway and are not excused. *Not checkable* is
either a reading no committed capture can show (a gated control, a masked
value) or, for the last four surfaces, finding **B-01**: there is no picture to
check against.

**Owned gaps, by task**

| Task | What it owes this manifest |
|---|---|
| 31 — the rate controller and the size ladder | L-13 (the step line's cause) |
| 32 — viewers and the preview-state message | L-10, L-11, L-12, L-13, L-24, L-26, L-27, L-63 |
| 33 — board recording, stills and the captures panel | **Done.** L-16, L-18, L-43, L-44, L-45, L-46, L-47 built; L-48 built as a panel rather than a popover, for the operator to accept or reverse |
| 34 — the stills strip, per viewer | L-20, L-21, L-22 |
| Phase 5 (deferred, Pocket 2) | L-52, L-79, L-83 |

**Unbuilt, with no owner — nineteen rows**

*(L-18 and L-43 left this list in Task 33b, built rather than deferred: under
rule 7 an element the blueprint draws needing another feature built is a
reason to build that feature, and the shutter's own route was that feature.)*

Under CLAUDE.md rule 7 these are not deferred. They are missing, and until each
has a named owner or is built, no camera surface is finished.

| Row | What is missing |
|---|---|
| L-02, L-03 | `CAMERAS` and `SYSTEM` section headings in the sidebar |
| L-04, L-05 | One sidebar entry per camera, and its selected state (R-UI-03) |
| L-17 | `DRAG TO SLEW · RELEASE TO STOP` on an aimable picture |
| L-23 | The `● CONFIRMED` pill on the camera page's strip |
| L-92 | `stop or start them on Setup ›` on Live |
| L-93 | The `SRT` output row |
| L-97 | The sticky rail |
| S-04, S-05 | The `RECORD FORMAT` and `SENSOR SIZE` bench-only fields |
| S-11 | The outputs legend's `1 UNREACHABLE` count |
| C-04 | A thumbnail on each Cameras row |
| C-15, C-16 | **The `ENCODING USED` meter and `room for one more 1080p30 stream`** |
| C-20 | `starting the gimbal would need 2.1 more` |
| C-22 | **`ADD BY ADDRESS` — K-54** |
| C-23 | **An action that adopts a detected camera — K-54, and see C-4** |
| C-24 | The Cameras page's `APPLY` key |

Three of those — L-56, C-15/C-16 and C-22/C-23 — are the three CLAUDE.md rule 7
names as the reason this file exists. **L-56 is now built** (as two pickers, the
operator's decision — see §1.7); the other two are still open. The remaining
seventeen rows are the same shape and had not been found before this audit.

## Touch cockpit — approved September 2026 extension

The approved cockpit behavior is recorded in [the integration design](../../cockpit-integration-design.md).
It preserves the existing authored PFD and mission controls in the native
`ui-yonder-cockpit` widget. This table covers the new page; it does not close older
camera-page findings above.

| ID | Approved behavior | Implementation / evidence |
|---|---|---|
| F-01 | One PFD with translucent instruments, measured VSI, HSI/CDI and reported flight-director cues | `PrimaryFlightDisplay.vue`; telemetry/context tests and cockpit browser matrix |
| F-02 | Left mission inset and right satellite/hybrid moving map; expand with the same PFD still present | `YonderCockpit.vue`, `YonderCockpitMap.vue`; landscape/portrait browser checks |
| F-03 | Tap instruments for references/settings, distinguish local bugs from actual autopilot targets | Preserved PFD control forms and `cockpit-state.mjs` adapter |
| F-04 | Import/edit/export Mission Planner missions, contextual waypoint/map actions, explicit review before transmission | Preserved mission catalog/forms; authenticated operation service and byte-level tests |
| F-05 | Real ADS-B map/vision targets with selected range, stale state and observed trails | `TrafficFeed`, map/vision components; geometric datum and timestamp regressions |
| F-06 | Detailed terrain with source/age/coverage, smooth independent pose updates | Prepared USGS ground/surface pack, retained Terrarium renderer and bounded tile service |
| F-07 | Fixed ELP camera selection and registered terrain overlays | Existing Yonder camera stream plus calibrated projection component. Physical lens/mount and frame-time verification remains required; unavailable registration is stated |
| F-08 | Time/distance projected path and waypoint ETE | Original prediction adapter. No invented autopilot turn countdown; source-missing intent is unavailable |
| F-09 | Authenticated production page and ongoing config-revert indication | Shipped `page-cockpit`, `group-cockpit-pending`; routing and flow contract tests |
| F-10 | Source fidelity without importing restricted simulator assets | Attribution file beside cockpit components; retained permissive/GPL assets and original behavior adapters |

The component fixture explicitly identifies synthetic telemetry and has no vehicle
transport. Browser imagery is an artifact, not a committed pixel reference. The
normal page uses the daemon's actual telemetry and authenticated operations.
