# The Telemetry page, as it was designed

These are the mockups from the brainstorming session that produced
[the telemetry plumbing design](../../../superpowers/specs/2026-09-03-telemetry-plumbing-design.md).
They are the agreed visual target, and they are committed here for the reason
[the camera view's mockups](../camera-view/README.md) are: they were written to a scratch
directory that `.gitignore` covers, and a plan that points at a scratch directory is a plan
whose blueprint is one cleanup from gone.

They were built against the **real generated stylesheet** — `themeCss()` run out of
`yonder-core`, not an approximation of it — so every colour, type size, material and button
treatment is the console's own. Each file is one resolved state with that stylesheet inlined
and no script, so it opens in a browser and shows exactly one screen.

## Start here

**`page-anatomy.html`** is the blueprint. It poses the arrangement question, draws the three
answers, marks the chosen one, and then takes the chosen one apart: **click any control and it
names the node that draws it**, with the reason. That is the file to open first and the file to
build from.

**Arrangement A is the one chosen** — readings in a main column, actions in a rail — on the
grounds that it is the arrangement the Status page already uses, that it keeps the autopilot's
state and the path check visible at the same time, which is exactly when you need both, and
that below 1024 px the rail drops under the readings without anything being rearranged, so
there is one page to design and one page for the capture gate to photograph.

## What is here

| File | The state it shows |
|---|---|
| `page-anatomy.html` | **The blueprint** — three arrangements, the chosen one, and every control named |
| `telemetry-linked.html` | An autopilot found and answering, telemetry flowing |
| `telemetry-nothing-on-the-wire.html` | The sweep found silence — the wiring case, naming the pins |
| `telemetry-not-mavlink.html` | Bytes at every speed, none of them a frame — the autopilot's port is set to something else |
| `telemetry-stopped.html` | `R-MAV-09`: the operator stopped it. Autopilot half alive, ground-station half deliberately dead |
| `telemetry-ingest-open.html` | `R-MAV-07` turned off — the amber boundary and what it costs |
| `telemetry-sent.html` | The moment after **Send telemetry here**, with no countdown |
| `telemetry-linked-night.html` | The same page in the other material |
| `status-telemetry-flowing.html` | The Status page's new flow strip: from, through, to |
| `status-telemetry-no-autopilot.html` | The same strip with nothing attached — dashed legs, grey arrows |
| `log-telemetry.html`, `log-telemetry-night.html` | The activity log narrating a whole session, including the two `warn` rows |

**Six states, not one.** `R-UI-12` requires a surface that hides part of itself to be
captured in each of those parts, and M3 built the machinery — `verify-pages.sh` drives real
states through the daemon and captures each under its own name. This page has six, and they
are enumerated here so the capture gate has a list to work from rather than a judgement to
make.

## Every control is an instrument, and here is the list

**This section exists because of what happened to the camera view.** Its spec described the
deck's *behaviour* and never named the instruments; the plan inherited the gap and filled it
with what Dashboard already ships, and eleven of twenty-three widgets came out as stock
controls — the thing [ADR-0009](../../../adr/0009-console-visual-language.md) exists to
prevent. The lesson is written down in that page's own README. This is the same page's worth
of decisions made in advance instead.

### Telemetry page — `Autopilot`

| What it shows | Node | Notes |
|---|---|---|
| Link | `ui-yonder-annunciator` | `good` linked · `waiting` searching · `bad` not-MAVLink · `neutral` stopped |
| The diagnosis | `ui-text`, `className: "yonder-warning"` | Only in the two failure states. The band treatment the generated stylesheet already defines as *the boundary you have to understand before you cross it* |
| Port · Speed · Vehicle · Heartbeat · Last heard | `ui-text` row-spread | The readout row the theme styles, as Status and Network already use it |
| Speeds tried · Bytes received · Valid frames | `ui-text` row-spread | Failure states only |

### Telemetry page — `Ground stations`

| What it shows | Node | Notes |
|---|---|---|
| Receiving | `ui-yonder-annunciator` | `good` answering · `neutral` nothing to send / not sending |
| Last answered | `ui-text` row-spread | |
| Three host + port pairs | `ui-text-input` × 6 | Stock is right for text entry — the Cellular tab enters an APN the same way. **`R-UI-17`: each opens carrying its configured value**, and an unset one says `not set` |
| Send telemetry here | `ui-button` | The page's one primary action (`R-UI-10`) |
| Unsent / sent | `ui-text`, `className: "yonder-qualifier"` | |
| TCP server | `ui-text` row-spread | |
| Throughput | `ui-yonder-sparkline` | RX solid, TX dashed, ceiling and span marked (`R-UI-09`) |

### Telemetry page — rail

| What it shows | Node | Notes |
|---|---|---|
| State | `ui-yonder-annunciator` | |
| At boot · Accepting from | `ui-text` row-spread | |
| This device / Any network | `ui-yonder-softkeys` | **A `caution` tone is added to the component** — it has `act` and `warn` today and neither means *deliberately on and hazardous*. Amber, matching the band |
| The ingest warning | `ui-text`, `className: "yonder-warning"` | |
| Stop / Start telemetry, Check the path | `ui-button` | |
| The path chain | `ui-text` × 3, `className: "yonder-qualifier"` | Mark, claim, reason. A link nobody attempted shows a dash, never a cross |

### Status page — `Telemetry`

| What it shows | Node | Notes |
|---|---|---|
| Feed | `ui-yonder-annunciator` | |
| From → through → to | **`ui-yonder-flow` — a new instrument** | Three cells and two legs; a leg with no traffic draws a dashed grey arrow. Below 1024px it turns vertical |
| At boot · Accepting from · Last heard · Vehicle | `ui-yonder-databar` | The four-cell strip |

**One new instrument and one new tone**, and both are argued rather than assumed. The flow
strip is the only thing on either page that no existing widget draws: it is a directional
relationship, and every instrument in the set today draws a single quantity or a single
state. The soft-key `caution` tone is a gap in an existing component, not a new component.

### And on every node of this page

`className` also carries **`yonder-pending`** where `R-UI-15` applies. Two settings on this
page are *not* exempt from the confirmation window — `mavlink.serial` and `mavlink.ingest` —
so changing either one pends, and the requirement is that a pending change is visible on
every surface, not only the one it was made on.

## What these files are not

A record, not a build input. They are hand-written HTML with the generated stylesheet inlined,
they are not wired to anything, and nothing imports them. When the built page and these
disagree, the disagreement is the interesting thing: say which is right and why, and change
one of them.
