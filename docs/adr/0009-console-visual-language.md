# ADR-0009 — The console's visual language

**Status:** accepted · **Date:** 2026-09-02
**Amends:** [ADR-0005](0005-console-substrate.md)

## Context

M1b shipped four pages that work and look like nothing. The palette in `theme.ts` was
sound — a near-white ground for sunlight, a warm night mode, tabular figures, 44 px
targets, four command tones — and the pages built on it still read as an unstyled admin
panel. The cause was not taste. Three things were missing and each is structural:

1. **A token set is not a visual language.** `theme.ts` decided colour, type scale and
   spacing. It made no decision about what a container *is*, how an edge is drawn, or what
   the recurring motif should be. A near-white surface with a 1 px grey border and a 4 px
   radius is the default of every framework in existence, so everything composed from it
   arrived looking like a default.

2. **The identity was never written down.** The direction — aviation, an instrument panel,
   a glass cockpit — was settled in conversation and recorded nowhere. `theme.ts` was
   therefore built from the *constraints* alone. Constraints without an identity produce a
   competent grey box every time, and there was nothing in the repository for a reviewer,
   or a future contributor, to hold a page against.

3. **The widget layout model was never questioned.** Dashboard's grid gives a group a
   column count, and a widget occupies whole rows of it. **A widget cannot be smaller than
   one row.** So an action is a slab because an action is a row; five readings cost five
   rows of a page whether or not they need them; a control cannot sit beside the value it
   changes, and a chip in a panel header is not expressible. This is identical in
   Dashboard 1.x and 2.x, and no stylesheet can reach it — shrinking a button inside its
   cell only adds empty space around it.

The third point deserves emphasis because it inverts an assumption. Products built on
Dashboard that *do* have visual identity get it by not using the widget layer for the
screens that carry the identity — the whole surface is one hand-written component. The
substrate was never the ceiling. Declining to use its escape hatch was.

## Decision

**One visual language: a glass cockpit display mounted in a carbon panel.** It is
specified here, implemented once in `node-red-dashboard-2-yonder`, and every page is
composed from it (R-UI-08).

### The surface

- **The display is the reading surface.** A near-black ground, panes divided by hairlines,
  and saturated data colours used only for meaning: white for a primary value, cyan for
  something addressable or selected, green / amber / red for the state of a reading,
  magenta for the single action on a page that takes the page away from the operator.
- **The chrome is the airframe.** The display is mounted in carbon — a 2×2 twill drawn
  from offset gradients with a raked sheen — carrying placarded legends in letterspaced
  caps and fasteners at the corners. Texture appears on chrome and never behind text.
- **Day and night are one design in two materials** (R-UI-07). Night is the display at
  night brightness; day lifts the levels. The layout does not change between them. This is
  the choice a real multi-function display makes, and it is why the two palettes cannot
  drift apart into two designs.

### The instruments

Each is a component, and the kind of data chooses the instrument. One horizontal bar for
every quantity was the mistake this decision replaces.

| Object | For | Rule |
|---|---|---|
| **Engine bar** | a bounded quantity | Label, zoned track, pointer, digital value. Caution and limit bands are drawn under the track, so the band is legible without reading the number (R-UI-09). The track has a fixed width and never stretches to its container |
| **Tape** | a quantity being watched | A vertical scale with a fill, a bug at the current value, and a boxed reading. Limits marked on the scale |
| **Annunciator** | command state | The four tones from `command.ts` as a lit caption (R-UI-11) |
| **Data bar** | facts | Label in small caps, value beside it, on one row. Six facts fit where one stock widget held one string |
| **Soft keys** | every action | A rail along the foot of the display. The *select* tone for a command, the *irreversible* tone for one that takes the page away. **No action lives anywhere else on a page** (R-UI-10) |

### The rules that follow

**Navigation is not in the rail**, though an earlier draft of this table said
it was. R-UI-03 requires navigation to be built from detected hardware — a
camera that is not present has no section — and that is exactly what
Dashboard's dynamic page creation gives us. A hand-built rail of page links
would have to be regenerated from the same detection and would fight the
framework to arrive at the same place. So the rail carries actions, the page
list stays Dashboard's, and the two do not overlap.

**The tones are named for their roles, not their colours.** `select` and
`irreversible` rather than cyan and magenta: night pulls away from blue for
dark adaptation (R-UI-07), so a token called `--yonder-cyan` holding an amber
would be a stylesheet that lies about itself.

- A bounded quantity is never a bare number (R-UI-09).
- No action is full-width above a narrow viewport, and a page has at most one primary
  action (R-UI-10).
- State is an indicator, never coloured body text (R-UI-11).
- Material is generated from stylesheet and vector rules, never shipped as raster
  (R-UI-13). This is stricter than R-UI-01, which only forbids *fetching* an asset: a
  shipped image would satisfy R-UI-01 and still be wrong, because it cannot follow the
  palette or scale to a display.
- Every page is captured in both palettes on every build, and a page that changes shape
  fails until somebody looks (R-UI-12). This is the part that survives being in a hurry.

## What this amends in ADR-0005

ADR-0005 drew the boundary as *"settings are widgets, the cockpit is bespoke"*, and said
visual identity would be settled in M1 to the level of palette and shell with **"full
polish waits for M8"**.

Both are superseded:

- **The boundary moves.** Pages are composed from Yonder's own components; stock widgets
  are the exception, used where a plain form is genuinely all that is wanted. ADR-0005
  already named custom Vue components "a first-class pattern rather than an exception" and
  budgeted a CI build step for them — this spends that budget rather than adding a new
  cost.
- **The deferral is withdrawn.** M8 is reproducible images; it contains no interface work
  and was never going to catch this. Polish that arrives after the pages do means
  restyling every page built without it, which is the duplicated work this project cannot
  afford.

ADR-0005's other decisions stand: Dashboard 2.x remains the substrate, and the
command-state language remains built once in `yonder-core` and shared.

## Consequences

- **A build step for Vue components in CI**, as ADR-0005 anticipated. The components ship
  as a UMD bundle built by Vite, discovered by Dashboard through the package's
  `node-red-dashboard-2` manifest.
- **A naming exception.** Dashboard 2.x discovers third-party widgets by the package name
  `node-red-dashboard-2-*`. The library is therefore `node-red-dashboard-2-yonder` rather
  than `node-red-contrib-yonder-*`. The convention's purpose — a name the host discovers —
  is served, by a different discoverer.
- **`flows/` stays wiring only.** Presentation moves *into* a reviewable package rather
  than into flow JSON, so this strengthens CLAUDE.md rule 2 rather than bending it.
- **A page can now be wrong in a new way.** Composing from the language is not automatic;
  R-UI-08 and R-UI-10 are enforced by tests over `flows.json` and by the capture gate in
  R-UI-12, because a rule a reviewer has to notice is a rule that lapses.
- **The instruments have to be right on hardware.** Every dimension here was chosen
  against a browser on a desk. A tablet at arm's length in sunlight is the condition that
  matters, and it has not been tried.

## Resolved — the third palette exists

**Answered by building it.** Day stays a lifted version of the display, and a third mode,
`sunlight`, was added for the condition the other two cannot cover: in direct sun a dark
screen is a mirror at *any* brightness, and no amount of contrast recovers a reflection of
the sky.

It is the same instrument in a different material, and that is the whole of it. Nothing
moves, no element appears or disappears, and an operator stepping out of the shade is
looking at the console they already know.

**The material is the chart.** Sunlight is the one mode that is read the way a sectional
is read, so it is drawn that way: warm chart paper for the faces — never white, because a
page in sunlight should not be a light source of its own — sectional blue for anything
addressable, sectional magenta for the one control that takes the page away, and the
ground is what a chart is *of*. Broad hypsometric washes, low green through buff to tan,
under faint contour rings and the graticule ticks a sectional carries. Terrain from above
on a clear day, generated from gradients like the carbon and held just as quiet, because
it is ground and the instruments bolted to it are what get read.

A first attempt made this mode brushed aluminium with neutral grey panels. It satisfied
every requirement and had no chart in it at all, which is the same failure this ADR was
written to stop: the constraints met, the identity absent.

Recorded as **R-UI-14**, and `ui.theme` now takes `day`, `night` or `sunlight`. The
capture gate photographs all three on every run.

Two things this exposed, both worth keeping in mind for the next mode:

- **The list of valid themes existed twice** — once as the schema enum, once as a literal
  in `ui/theme.ts`. Adding the third to the schema alone shipped a console that offered a
  control the route refused. There is now one list, in the schema, re-exported.
- **A test's own list of themes went stale without failing.** `theme.test.ts` held
  `["day", "night"]`, so every assertion in it silently stopped covering a third of the
  console. It derives the list from `PALETTES` now. A hand-written list of the things
  under test is a list that rots quietly.

## Open

Nothing outstanding in this decision. What remains is not a design question but an
unverified one: none of these three palettes has been read on a board, in the light it is
named for.
