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
theme generator). `shot2.mjs` renders the PNGs here; `probe2.mjs` exercises the
rail, the shutter key and Recentre headlessly. The strip along the top of the
page is the harness — palette, page and camera switches — not the design.

## What is here

| | |
|---|---|
| `gallery/DraftPicker.vue` | One value from what the device answered. Present, advertised, gated. A real `<select>` underneath |
| `gallery/DraftSegmented.vue` | Two or three exclusive choices. A maximum width; it never stretches |
| `gallery/DraftSetBar.vue` | A bounded continuous value. One track, two marks — where the device is, what was commanded. Snaps to the device's own step |
| `gallery/DraftReadout.vue` | Label, value, unit, stacked |
| `gallery/DraftColumn.vue` | A titled group with a right-hand qualifier |
| `gallery/DraftAimDial.vue` | Pan and tilt. White where it is, cyan where you push. Drag sets a rate; release stops. An axis that will not answer stays on the dial, struck |
| `gallery/DraftPicture.vue` | The picture with its overlays and the drag-to-slew layer. Orb only, measured from where the finger landed |
| `gallery/DraftTextField.vue` | The camera's name. Defaults `Cam 1`, `Cam 2` |
| `gallery/DraftShell.vue` | The console's shell, wearing Dashboard's class names so the real `theme.css` rules draw it |
| `gallery/DraftIndex.vue` | The Cameras page: camera rows and rejection rows |
| `gallery/cameras.js` | The two capability reports, with `proven` recording what the bench has actually driven |
| `gallery/deck.js` | The deck. Composes columns from the report; Live and Setup are one component in two modes |
| `live.pocket2.*.png`, `live.elp.night.png`, `setup.elp.night.png`, `cameras.night.png` | The renders |

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
  exception to R-UI-10's "every action on the rail". The rail carries
  `LIVE · SETUP · STREAM ADDRESS` (and `APPLY` on Setup).
- **"Receive line" is "Stream address".**
- **Sizing is notebook-first**: 36 px keys, 220 px tracks with a hit zone a
  finger can still land on, 10.5 px labels. Not 44 px everywhere.
- **Groups flow into balanced columns** rather than a grid, so a short group
  packs under a shorter one and nothing is stranded on a second row.

## Known gaps in the mockup

- **The browser preview has no controls.** Its size, rate and bitrate are in
  `config.yaml` and were settable on the old Setup page; here it is a readout.
  The stream's bitrate bar does not say which of the two encodes it is.
- **`FULL RATE` is missing** — the hold-key that shows the full-quality stream
  while held, built and proven on the board, is not on the rail.
- The Cameras page's uplink bar is over capacity and drawn in the select tone.
- Several Pocket 2 controls are drawn from command ids the bench has not
  driven: sensor size, record format, focus mode, shutter. Press **mark
  unproven** in the harness to see them tagged.
