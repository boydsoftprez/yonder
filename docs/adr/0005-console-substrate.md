# ADR-0005 — Dashboard 2.x as the console substrate, with a deliberate escape hatch

**Status:** accepted, amended by [ADR-0009](0009-console-visual-language.md) · **Date:** 2026-08-31

## Context

[ADR-0001](0001-node-red-as-core.md) put Node-RED at the core, so the console is served by
it. That leaves a real choice about what the console is *made of*, and it has to be made
before M1 because M1 builds the shell.

The console must satisfy constraints that are not matters of taste:

- Readable on a tablet in sunlight (R-UI-04)
- Usable over a link with hundreds of milliseconds of latency (R-UI-06)
- Navigation generated from detected hardware, not hard-coded (R-UI-03)
- Every command must show *accepted or rejected*, not merely *sent* (R-UI-05, R-CMD-09)
- Served entirely from the device, no asset fetched at runtime (R-UI-01)

Three candidates:

1. **Dashboard 1.x** — the original, built on AngularJS.
2. **Dashboard 2.x** — the FlowFuse rebuild, Vue-based, Apache-2.0.
3. **A custom single-page app** served from Node-RED via `httpStatic`, with Node-RED as
   backend only.

## Decision

**Dashboard 2.x**, with custom Vue components as a first-class pattern rather than an
exception.

- Sections that are forms and status readouts — network, modem, update, relays — use stock
  widgets.
- The cockpit is a **custom Vue component** delivered through a `ui-template` node.
- The boundary is explicit: *settings are widgets, the cockpit is bespoke.*
  **Superseded by [ADR-0009](0009-console-visual-language.md):** pages are composed from
  Yonder's own components and stock widgets are the exception. The reason is recorded
  there — a widget cannot be smaller than a row of its group, so this boundary made every
  action a slab and every reading a row, and no stylesheet can reach that.

## Rationale

**Dashboard 1.x is out.** It depends on AngularJS, which is unmaintained upstream. A
project that expects to be alive in five years cannot start on a dead framework.

**A custom SPA is more freedom than we need, at a cost in the wrong place.** It would mean
hand-writing every settings form — the highest-volume, lowest-value UI in the product —
and it discards the assembly speed that made Node-RED the right core in the first place.
Paying that cost to gain design freedom on screens that are fundamentally *forms* is a bad
trade.

**Dashboard 2.x is not a cage.** A `ui-template` node accepts a complete Vue component, and
dashboard styling can be overridden wholesale with our own CSS. So the constraint is
**local rather than global**: conventional where conventional is correct, bespoke where it
matters. The cockpit — live video, a telemetry overlay and a map in one dense view — is the
one screen a widget grid would genuinely fight, and it is exactly the screen we can hand-
build.

Supporting points: Apache-2.0 and so GPL-3.0 compatible; actively developed; dynamic page
creation makes hardware-generated navigation (R-UI-03) straightforward.

## Consequences

- We take a dependency on FlowFuse's release cadence for the widget layer. Acceptable —
  it is Apache-2.0 and forkable if that ever goes wrong.
- Custom Vue components need a build step in CI, which M0 must account for.
- **Two UI idioms in one product.** This is the real risk. If the boundary blurs, the
  console will feel like two applications stitched together. The boundary is stated above
  and belongs in review.
- **The command-state language must be built once and shared.** Pending, confirmed and
  rejected states have to look and behave identically whether they come from a stock
  widget or a hand-written component. Implemented as shared CSS and a small component
  library used by both idioms, in M1, before there are many controls to retrofit.
- ~~Visual identity is settled in M1 to the level of palette, typography and the shell.
  Full polish waits for M8, when every section exists and we know what the UI actually
  contains.~~ **Withdrawn by [ADR-0009](0009-console-visual-language.md).** M8 is
  reproducible images and contains no interface work, so the deferral pointed at nothing.
  Polish arriving after the pages means restyling every page built without it.
- **Day and night are two first-class modes, not a theme and its inversion** (R-UI-07).
  Day is the default: in direct sunlight a dark screen becomes a mirror, which is why
  every electronic flight bag ships day-first. Night exists because the same aircraft gets
  flown after dusk. Both are designed, both are selectable by the operator, and the choice
  persists — it is never inferred from the browser or the host.

## Open

Whether the cockpit layout survives contact with Dashboard 2.x's grid, or whether it needs
to be a full-page route outside it. To be answered by building it in M1, not by guessing.
