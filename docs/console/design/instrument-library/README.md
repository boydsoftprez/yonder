# The instrument library, drawn in the real code

The **interactive mockup** that settled the camera pages for
[the instrument library spec](../../../superpowers/specs/2026-09-04-console-instrument-library.md).
Unlike [the camera view's HTML mockups](../camera-view/README.md) these are Vue
components that read `var(--yonder-*)` and nothing else, rendered against the
`theme.css` that `yonder-core` actually writes to a device, in the console's own
shell. Every value on the ELP pages is what `/dev/video0` on the bench board
reports; the Pocket 2 pages are drawn from the command matrix in
[`docs/hardware/dji-pocket-2-over-usb.md`](../../../hardware/dji-pocket-2-over-usb.md).

Committed for the reason the camera-view mockups were: that set was written to a
scratch directory and came within one cleanup of being lost.

## Run it

```
cd docs/console/design/instrument-library/gallery
npx vite build --outDir dist --emptyOutDir && cp theme.*.css dist/
python3 -m http.server 18930 --bind 127.0.0.1 --directory dist
```

Then open `http://127.0.0.1:18930`. Needs `npm install` and `npm run build` at
the repository root first (the gallery mounts the real components from
`packages/node-red-dashboard-2-yonder/src/ui/` and reads `yonder-core`'s built
theme generator). `shot2.mjs`, `shot4.mjs`, `shot5.mjs` and `shot6.mjs` render
the PNGs here; `probe2.mjs` exercises the rail, the shutter key and Recentre
headlessly, and `probe3.mjs`–`probe6.mjs` are the exploratory sessions that
settled the drafts, the cost breakdown and the viewport measurement (task 12,
console-instrument-library plan). The strip along the top of the page is the
harness — palette, page, link and camera switches — not the design.

**Two things had to be fixed before any of that would run**, neither of them
this task's own subject, both blocking every render without them:

- `main.js`, `deck.js` and `vite.config.mjs` imported
  `packages/node-red-dashboard-2-yonder/...` one `../` short — a relative
  path that only worked before this `gallery/` moved a directory level
  deeper. Vite's build failed outright without the fix.
- `shot2.mjs`, `shot4.mjs` and `probe3.mjs` looked for a button named
  "pocket 2" or "ELP" — a selector from before the sidebar settled on
  `Cam 1`/`Cam 2`, and never actually the accessible name of anything in
  the nav (the icon svg alongside the label leaves the button's own
  accessible name empty; only its rendered text matches). Fixed to the
  `.d-nav__i`/`hasText` pattern `shot5.mjs` already used correctly.
  `probe2.mjs` and `probe4.mjs` carry the same stale selector and were left
  as found — nothing committed renders from them.

**A `position:sticky` element frozen mid-page in a screenshot is a capture
artefact, not a layout bug.** Chromium's screenshot path for an element or
page taller than the viewport does not recompute `.d-rail`'s stuck position
correctly; every full-shell and full-page PNG here neutralises the rail's
`position` for the capture only (see the comment beside each
`addStyleTag` call). The real, scrolled behaviour is independently measured
— not screenshotted — in `shot6.mjs`'s viewport-contract block, and it is
what `fold.1440.png` (a genuine, unscrolled viewport capture, immune to the
artefact) shows.

## What is here

| | |
|---|---|
| `gallery/DraftPicker.vue` | One value from what the device answered. Present, advertised, gated. A real `<select>` underneath |
| `gallery/DraftSegmented.vue` | Two or three exclusive choices. A maximum width; it never stretches |
| `gallery/DraftSetBar.vue` | A bounded continuous value. One track, up to three marks — where the device is, what was commanded, and — hollow, the third — what a Live edit has drafted but not applied. Snaps to the device's own step |
| `gallery/DraftReadout.vue` | Label, value, unit, stacked |
| `gallery/DraftColumn.vue` | A titled group with a right-hand qualifier |
| `gallery/DraftAimDial.vue` | Pan and tilt. White where it is, cyan where you push. Drag sets a rate; release stops. An axis that will not answer stays on the dial, struck |
| `gallery/DraftPicture.vue` | The picture with its overlays and the drag-to-slew layer. Orb only, measured from where the finger landed. A photo's white flash and `SAVED · to <destination>` are a timestamp prop, not a route the deck has to know about |
| `gallery/DraftTextField.vue` | The camera's name. Defaults `Cam 1`, `Cam 2` |
| `gallery/DraftShell.vue` | The console's shell, wearing Dashboard's class names so the real `theme.css` rules draw it |
| `gallery/DraftIndex.vue` | The Cameras page: camera rows and rejection rows |
| `gallery/DraftCaptures.vue` | The captures panel (§8.3, R-CAM-18): board-saved stills only, view · download · delete. A popover beside the shutter key — the deck's 252px columns have no room for a thumbnail, two dates and three keys side by side |
| `gallery/DraftRangeFinder.vue` | The Setup step that gives the aim guard its envelope (§8.7): one axis at a time, five degrees a step, the limit flag watched — a hand-toggled stand-in for the device's own push, never assumed from the angle |
| `gallery/cameras.js` | The two capability reports, with `proven` recording what the bench has actually driven; `openValues` on every gate states which of its own values leave the controls it holds live |
| `gallery/deck.js` | The deck. Composes columns from the report; Live and Setup are one component in two modes; owns the shared draft, the recorded envelope and the board captures list, each a module-level store keyed by camera so a Live↔Setup or camera switch — which remounts this component — does not lose them |
| `live.pocket2.night.png`, `live.pocket2.poor.png`, `live.pocket2.day.png`, `live.elp.night.png` | Live, both cameras, both palettes, the link degraded |
| `setup.elp.night.png` | Setup, the ELP: the four bench-only fields, no Aim group — this camera has no motor |
| `setup.pocket2.night.png` | Setup, the Pocket 2: two pending changes listed with their interruptions, `DISCARD`/`APPLY` on the rail, the range finder not yet run |
| `rangefinder.pocket2.png` | The range finder after both axes are recorded — pan and tilt each −5°…+0° here — the Aim panel's inhibition lifting is what recording one does |
| `photo-and-captures.elp.png` | Photo mode's flash and board-saved confirmation, captures popover open, the new still first in the list |
| `cameras.night.png` | The Cameras page |
| `stage.poor.1512.png` | The picture and Aim side by side, link degraded |
| `fold.1440.png`, `fullpage.1440.png` | The viewport contract (§5) as a measurement: the picture, Aim and Capture above the fold at 1440×900 (`fold.1440.png`, a genuine unscrolled viewport capture); the whole page, one scroll, no horizontal overflow, no nested scroller (`fullpage.1440.png`) |

## Spec §15's corrections, applied

The blueprint's job is to be looked at, and it was reviewed against §15 of
the spec before this task. What was wrong is fixed; what §15 said was
missing is drawn — both are here now, not just described:

- **The ELP shutter is raw × 100 µs, step 100** — raw 156 is `15 600 µs` —
  matching `packages/yonder-core/src/video/descriptors.ts`'s
  `DESCRIPTORS.exposure` rather than restating the factor a second time.
  The same conversion is drawn on the Pocket 2's shutter bar too (still
  `proven: false` — `camera/0x28` is untried), because the display
  convention belongs to the kind of control, not to one device.
- **`Auto exposure` offers exactly `Aperture priority | Manual`**, menu ids
  3 (the fixture's default) and 1 — read straight off
  `probe/fixtures/list-ctrls-menus-globalshutter.txt` and its
  `-manual` sibling. Nothing else is drawn as a choice.
- **The ELP's zoom carries no unit.** No × ratio has been established for
  it; the Pocket 2's zoom keeps its `×`, because that one is a calibrated
  1.0–10.0 digital crop the bench actually proved.
- **Gating reads `openValues` off the gate control itself**, not "the
  second option" or a literal `"4"`. The Pocket 2's shutter and ISO open
  under Manual *and* Shutter priority — a fact `descriptors.ts`'s own
  comment states for this camera — which a two-state assumption could
  never have drawn correctly.
- **The shared draft** (§7): a Live edit to any Stream or Preview field
  stages in a per-camera store instead of writing straight to the applied
  report. A bar draws the draft as a third, hollow mark with *Pending ·
  apply on Setup* beneath; a picker or segmented control shows the
  requested value with the same note. The rail's `Setup` key carries the
  pending count when read from Live; Setup lists every change with its
  interruption (blank where none is known) above `DISCARD` and `APPLY`,
  now real keys on the rail rather than decoration. The store is
  module-level, keyed by camera, because `main.js` remounts the whole deck
  on every Live↔Setup flip and camera switch — component state would not
  have survived either.
- **Preview's Fixed bitrate is a real bar**, not folded into `Going out`;
  `Smallest`/`Largest automatic size` appear with Auto; **Stream** gained
  its own `Floor`/`Ceiling`, shown in Adaptive — all four new fields, all
  part of the same draft.
- **ELP Photo mode** exists now (`Video | Photo`), landing `to this board`
  like Video does — the same fallback §8.3 describes, on a camera with no
  native still capture. The shutter key's free-space line reads photos
  free in that mode, minutes free in Video.
- **The captures panel** (`DraftCaptures.vue`) lists board-saved stills —
  view, download, delete — reachable beside Capture on Live and Setup.
  Camera-card photos (the Pocket 2's own, today) never appear in it,
  because Yonder cannot list, view or fetch a file it never receives.
- **Capture is now the first column**, ahead of Stream, so the viewport
  contract holds: at 1440×900 the picture, Aim and Capture are all above
  the fold, measured (`fold.1440.png`), not eyeballed. `DraftShell.vue`'s
  `.d-main` padding and a few of `DraftColumn.vue`'s spacings (trimmed from
  `gallery.css`, since that file is not itself in scope to edit) gave back
  the last ~18px the reorder alone did not close.
- **The rail is sticky** (`position: sticky; bottom: 0`) so it stays
  reachable while the deck scrolls, satisfying §5's "one vertical page
  scroll; no nested deck scroller or horizontal overflow" — verified as a
  measurement (`shot6.mjs` prints the fold and page-size numbers,
  including an explicit nested-scroller scan) rather than claimed from the
  CSS alone.
- **The range finder** (`DraftRangeFinder.vue`) is a Setup step for a
  gimbal camera: one axis, ≤ 5° per press (a step further into an already-
  lit limit is refused, the same rule the production guard states),
  the limit flag watched and recorded per axis. Until both axes are
  recorded, the Aim panel is drawn inhibited — dial dead, badge reading
  *envelope unknown* — with *envelope unknown — run the range finder*
  where `Recentre gimbal` would be; recording flips it live. The Pocket 2
  starts every session with no envelope recorded, because that is the
  bench's actual, current state (§15's remaining-evidence note), not a
  state chosen for the screenshot.
- **Cost is drawn as three numbers**: *This viewer*, *Shared encode*,
  *Path total* — replacing the single simulated two-encode sum §15 named
  outright. They read identically on a good link and diverge under
  `link poor`/`link lost`, where this viewer has fallen back but the
  shared encode (stated for whoever else needs it — this mockup does not
  render a second viewer as a visible fact) has not.

## Decisions the mockup carries that the spec does not yet

The spec at `docs/superpowers/specs/2026-09-04-console-instrument-library.md`
predates these and must be brought up to them:

- **One plan**, not three.
- **Live carries every control the camera has.** Setup adds only four
  bench-only items: name, mains frequency, record format, sensor size.
- **Aim sits beside the picture**, with its mode keys and Recentre.
- **One shutter key that follows Video/Photo mode.** `○ RECORD` becomes
  `● RECORDING 00:13:47`; in Photo mode it reads `PHOTO`. Beneath it, where a
  recording lands (R-CAM-17): the camera's card, or this board.
- **Record and Recentre live beside the things they act on**, a deliberate
  exception to R-UI-10's "every action on the rail" — as does the captures
  toggle, beside Record. The rail carries `LIVE · SETUP · STREAM ADDRESS`
  (and, on Setup, `DISCARD · APPLY` for the shared draft — see §15 below).
- **"Receive line" is "Stream address".**
- **Sizing is notebook-first**: 36 px keys, 220 px tracks with a hit zone a
  finger can still land on, 10.5 px labels. Not 44 px everywhere.
- **Groups flow into balanced columns** rather than a grid, so a short group
  packs under a shorter one and nothing is stranded on a second row.
- **Two encodes, each with a mode.** `STREAM · to the ground station` is Fixed
  by default; `PREVIEW · to this browser` is Adaptive by default, with a floor,
  a ceiling, and a Size picker whose `Auto` steps down the ladder with the link
  and whose other rungs hold a size while the bitrate keeps adapting
  (R-VID-07, R-VID-08, R-VID-13). In Adaptive the bar is a readout, `GOING OUT`.
- **The picture wears its own state** — `ADAPTIVE`, `AT THE FLOOR`, `HELD`,
  `FULL RATE`, `STILLS` — as an overlay, not in the strip beneath it, because
  in Cockpit the picture is there and the deck is not. A step down the ladder
  shows a brief line, top-right. `LINK · DROP` moved to the bottom-right corner.
- **`FULL RATE` is back**, a hold-key at the right of the rail (R-VID-13).
- **The strip's uplink counts both encodes** and turns to caution when over:
  `3.3 of 3.2 Mb/s · over — the ground station's stream comes first` (R-VID-11).
- **One sidebar entry per camera** under a `Cameras` heading — `Cam 1`,
  `Cam 2` — and a **strip under the picture** with the other cameras as
  periodic stills and the cost of all of it (`multi-camera-v2.html` option 1,
  R-UI-03). A press on a thumbnail switches; the sidebar follows.
- **Capacity follows the link** in the strip's uplink reading, and the reading
  says when the encodes exceed it (R-VID-11).
- **The Aim panel draws pan and tilt against their bounds** (R-UI-09) under a
  *Reported position* heading, with *Commanded rate* as its own block, axis
  labels on the pad, `RATE CONTROL` stated at the head, a sentence under the
  gimbal mode saying what the mode does, and `Recentre gimbal` — **in the
  alternative's visual idiom**: one thin ring, a crosshair, a haloed puck,
  sentence-case sub-headings, an outlined badge for the control model. Adopted
  from `../instrument-library-alternative/` at the operator's direction. The
  struck axis for an advertised state stays, because it is a state from
  `capability-states.html`, not decoration.
- The harness has a **link** switch — good / poor / lost — so the states can
  be seen. **Nothing measures the link yet**: R-VID-07 is unbuilt, and the
  round-trip figure is typed in.

## Known gaps in the mockup

- The Cameras page's uplink bar is over capacity and drawn in the select tone.
- Several Pocket 2 controls are drawn from command ids the bench has not
  driven: sensor size, record format, focus mode, shutter. Press **mark
  unproven** in the harness to see them tagged.
- The range finder records one envelope per camera, not per mounting and
  mode — spec's fuller granularity (§8.7: "recorded per mounting and mode")
  is not separately modelled here; there is one mounting and one mode in
  this mockup, so the distinction has nothing to show against yet.
- The Pocket 2's shutter figures (12 500–800 000 µs) are the same
  raw-×-100 convention the ELP's shutter uses, applied for consistency —
  not a range the bench has measured. `camera/0x28` is still untried.
- "Shared encode" in the cost breakdown is a stated number, not a second
  viewer this mockup actually renders — there is one browser session here,
  and the figure is what a concurrent one watching full video would read.
- The captures panel's `View` and `Download` keys are visual only; only
  `Delete` actually removes an item from the list, matching how much of
  the rest of this harness is wired versus decorative.
- The range finder's `Limit flag` is a hand-operated toggle standing in for
  the device's own push (`gimbal/0x05` byte 10, 20 Hz) — a deliberate
  choice, not a shortcut: the point of the procedure is that a person
  watches a real signal, and this mockup has no bench connection to watch.
