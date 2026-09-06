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
| `telemetry-not-mavlink.html` | Bytes at every speed, none of them a frame — something is reaching the receive pin and cannot be read. **This does not clear the wiring**: a fault that corrupts rather than silences looks the same, and nothing has exercised the transmit wire |
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

**Five of those six are what the gate captures, and the sixth is a different one.** When
the page was wired to the daemon the six became `telemetry`, `telemetry-stopped`,
`telemetry-searching`, `telemetry-not-mavlink`, `telemetry-pending` and
`telemetry-ingest-open`. *Sent* is not among them and *a change pending* is, for one
reason: **nothing on the built page changes when `Send telemetry here` is pressed.** There
is no reading for it to move — the row beside the button that would say a change is unsent
was designed and never drawn — and there is no route behind it either, so the press has
nothing to report. A picture of it would be the linked page under a second name. *A change
pending* is a real second shape of this page, it is the one `R-UI-15` asks to be visible on
every surface, and pressing `ANY NETWORK` reaches it through the daemon like every other
state here. The spec's own list of six — linked, searching, not-MAVLink, stopped, ingest
open, a change pending — is the one the gate follows.

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
| Receiving | `ui-yonder-annunciator` | The headline for the group: `good` anything answering · `neutral` nothing to send / not sending |
| Last answered | `ui-text` row-spread | **Names the station** — `GCS 0 · 0.3 s ago`. Once each row carries its own state, "last answered" without a name is a question the page raises and does not answer |
| Each station's own state | **`ui-yonder-annunciator` × 3** | **This replaces the row's `ui-text` label.** The lamp carries that endpoint's state and the caption carries its name, so the row's identity and its condition are one instrument rather than two widgets. `good` answering · `waiting` silent — it answered before and has gone quiet · `neutral` no reply yet, or not set |
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

## The per-station marks came from the bench, and these files predate them

The three per-row annunciators are not in the HTML below. They were added on **2026-09-05**,
after `mavlink-router` was built on a board and asked what it knew.

The design here assumed the console could report *that* a ground station was answering but
not *which*, reasoning that the control plane sees one merged loopback copy in which every
ground station identifies itself identically. That reasoning is correct about the merged copy
and beside the point: **the attribution does not have to come from the traffic, because the
router already keeps it.** With `ReportStats = true` it prints a named block per endpoint —
measured with two configured and one answering, the answering one's received count tracked
its replies exactly and the silent one stayed at zero.

So an operator with one dead ground station out of three is now told which one. The evidence
is in [the hardware note](../../../hardware/an-autopilot-on-the-uart.md); the design decision
is §6 of the spec.

**Where the files below disagree with the built page, the built page is right** — it is the
one that carries the measurement.

## The path check's rows are two lines now, and the built page is right

The drawings' `Path check` rows were written to fit the box as first drawn — `OK · 1.0 Hz`,
`OK · 3.1 kB/s`, `OK · 0.3 s ago` in `flows/flows.json`'s own former mocks for
`tel-chain-1..3`, each comfortably one line. `mav/check.ts`'s real sentences were always
going to be longer than that: its own docstring calls a mock's payload "a rough placeholder
for a page layout" and says the real sentences are "longer and more specific", because each
one also carries the *reason* `R-DIA-04` asks for, not the mark alone. Wired to the device,
the same three rows read `OK · Heartbeat at 1.0 Hz, 57 600 baud`, `OK · 3.1 kB/s leaving, one
ground station configured` and `OK · Answering, last heard 0.3 s ago` — and a sentence that
explains itself is longer than one that does not.

Each row is one `ui-text`, so the extra words wrap: the captured shape
(`docs/console/shape/telemetry.day.darwin.json`) has the three `yonder-qualifier` rows at
108px tall where the drawings show 48px, and the button below them moved down to match, the
same box growing taller rather than the page being rearranged around it.

**The owner inspected the built page and chose the longer wording over the shorter box.**
Every row now explains itself without sending an operator looking elsewhere on the page for
what `OK` or `✕` means, and nothing else on the page had to move to make room for the extra
height it costs. So the built page's wording stays exactly as it is, and the drawings below,
not yet redrawn, are the ones that predate it — the same relationship the per-station marks
above have with theirs.

## Where the drawings and the built page still disagree

Recorded rather than quietly resolved, because each is a real limit rather than a slip.

**The unset host box does not say `not set`.** The drawing renders it as dimmed placeholder
text and `R-UI-17` is what it is drawn from. `yonder-mav-endpoints` emits `""` for an unset
row and must: putting the words in the *value* would let an operator press **Send telemetry
here** with `not set` as a host. The right place is a placeholder, and **Dashboard 2.x's
`ui-text-input` has none** — its widget passes `label`, `type`, `rules`, `clearable` and the
four icon slots to Vuetify's text field and never a `placeholder`, so the property would sit
in `flows.json` doing nothing. `label` would show the words but would then caption the two
*filled* boxes with them as well. Closing this needs either a Yonder instrument for the row
or the property upstream; until then an unset box is empty, and the lamp beside it says
`GCS 2 · not set` in words.

**The TCP server line says `Off · ingest is this device only` where the drawing says
`:5760 · 1 client`.** The drawing is of a device with the TCP server actually running, and
on the shipped defaults there is none: `router/config.ts` writes `TcpServerPort = 0` unless
`tcp_server.enabled` **and** `ingest.loopback_only: false`, because a MAVLink TCP server
binds every interface and an accepted connection is an unauthenticated command path to the
vehicle (R-MAV-07). The page showed `:5760 · no clients` on a board with nothing bound — a
port an operator could hand a ground station, beside a client count for a socket that does
not exist. It now says that it is off, and which setting would turn it on.

**On a device where the server *is* running, the count still reads `no clients` where the
drawing says `1 client`.** Nothing has measured how a connected TCP client appears in
`mavlink-router`'s own statistics — as its own block, as a counter on the server's, or not
at all — so `LinkState.tcpClients` is `null` and stays that way until a bench session with a
client attached says what to count. A number nobody measured is the one thing this page must
not print.

**The Status page's flow strip names its destination by count, not by address, and carries
no uptime.** `LinkState` has neither field: an endpoint's host and port are configuration,
read by a different node, and `mavlink-router`'s uptime is not exposed at all. Both are said
at length in `state.ts`'s own comments, and neither is worth inventing.

## What these files are not

A record, not a build input. They are hand-written HTML with the generated stylesheet inlined,
they are not wired to anything, and nothing imports them. When the built page and these
disagree, the disagreement is the interesting thing: say which is right and why, and change
one of them.
