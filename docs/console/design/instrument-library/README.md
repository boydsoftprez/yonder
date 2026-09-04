# The instrument library, drawn in the real code

These are the **drafts that settled the layout** for
[the instrument library spec](../../../superpowers/specs/2026-09-04-console-instrument-library.md),
and unlike [the camera view's mockups](../camera-view/README.md) they are not
hand-written HTML with invented colours. They are Vue components that read
`var(--yonder-*)` and nothing else, rendered against the `theme.css` that
`yonder-core` actually writes to a device.

They are committed for the reason the camera-view mockups were: that set was
written to a scratch directory and came within one cleanup of being lost.

## What is here

| | |
|---|---|
| `DraftPicker.vue` | One value from what the device answered. Present, advertised and gated |
| `DraftSegmented.vue` | Two or three exclusive choices. **A maximum width; it never stretches** |
| `DraftSetBar.vue` | A bounded continuous value. One track, two marks — where the device is, and what was commanded |
| `DraftReadout.vue` | Label, value, unit, stacked. Not the data bar, which is horizontal |
| `DraftColumn.vue` | A titled group with an optional right-hand qualifier |
| `deck.night.png`, `deck.day.png` | The Live deck assembled from them. **Every value is what `/dev/video0` on the bench board reports** |
| `instruments.night.png` | The eleven components that already exist, mounted against the same theme |

The deck draws **shutter** and **temperature** *gated* — dashed track, em-dash
value, *"while auto exposure is on"* — and **aim** *advertised*, in the caution
tone with its reason. Same camera, three different states, three different
treatments. That is the distinction the whole design turns on and this is the
first time it has been drawn.

## What they are not

Not components of the package: no tests, no node registration, no editor form.
The plan moves them into `packages/node-red-dashboard-2-yonder/src/ui/` with
tests, and grows the gallery that renders them into the build (R-UI-25). Until
then they are a blueprint for layout, spacing and state, and nothing is wired
to anything.

## What building them already found

Four defects, standing alone, with no page and no board — which is the argument
for R-UI-25 in one paragraph:

- **`YonderDataBar` truncates in the component.** `1280 × …`, `3000 kb…`, and
  two cells past its own edge. The defect seen on the board, reproduced with
  nothing else on the screen.
- **The soft-key rail runs off its edge.** Six keys do not fit, and it neither
  wraps nor scrolls, so three keys were simply not drawn.
- **`YonderBudget` has no space** between its label and its value:
  `IN USE0.0 of 3.2 Mb/s`.
- **A unit rendered against its number** — `3Mb/s` — because a leading space
  inside a tag is collapsed. Written and caught inside a minute, because it was
  rendered beside eleven other things.
