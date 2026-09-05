# Telemetry, the plumbing — design

**Milestone:** M5a · **Date:** 2026-09-03 · **Status:** agreed, not yet planned

[`roadmap.md`](../../roadmap.md) puts telemetry in M5 and lists eighteen things in it, from
a baud sweep to a moving map to a camera that speaks its own protocol. That is three
milestones wearing one number. This document splits it, settles the first slice, and says
where the result lands in the console.

**Read this differently from the remote-access spec.** That one opened by saying every
number in it was read off a board. This one cannot. **Nothing here has been run on
hardware.** No autopilot has been attached to the development board, `mavlink-router` has
never been built for it, and no MAVLink frame has crossed it. What follows is a design
argued from the requirements, from what the console already does, and from the shape of the
protocol — and §10 lists the three places where that is a genuine risk rather than a
formality, with what changes if each assumption turns out to be wrong.

---

## 1. The slice

M5 as written contains three separable jobs that share only a milestone number:

| | | Depends on |
|---|---|---|
| **M5a** | The plumbing: find the autopilot, fan its telemetry out, report the link | Nothing outside M1 |
| **M5b** | The Cockpit: instruments, moving map, overlay on the video | M5a, and M4 for the overlay |
| **M5c** | The DJI Pocket 2 — R-CAM-15 | M4's pipeline |

M5's exit criterion — *telemetry and video over cellular from beyond line of sight* — needs
M3 and M4. **M3 has since landed**; M4 has not. **M5a needs neither.** It needs an autopilot
on three pins and the console that exists, which is why it could be designed while the
milestones it nominally follows were still empty — and why the cellular half of its exit
criterion is now real rather than hypothetical.

This is the same split M1 and M2 already took: the invisible layer first, proven on a board,
and the pages that read it after. It has a pay-off of its own — **at the end of M5a you fly
with Mission Planner over the mesh, from another network, with no instrument drawn by us at
all.**

**M5a reads nothing but heartbeats.** That is the boundary, and it is chosen to defer a
decision rather than to make one: which MAVLink library, which dialect, v1 or v2, signed or
not. Recognising one message type needs none of that. Everything that turns bytes into an
attitude indicator is M5b's, and so is the library question.

M5a is `R-MAV-01` through `R-MAV-10`, plus `R-DIA-04`, plus the one requirement §7 adds
(`R-MAV-13`). It is not any of `R-TEL`.

---

## 2. The wire

**Pins 6, 8 and 10 — ground, transmit, receive.**

| Header pin | Pi signal | To the autopilot |
|---|---|---|
| 6 | GND | GND |
| 8 | GPIO 14 — UART0 TXD | **RX** |
| 10 | GPIO 15 — UART0 RXD | **TX** |

No power wire: the autopilot has its own supply and both ends are 3.3 V logic. These are
the same three pins on a Rockchip board, where they carry `UART2` instead, so one wiring
diagram covers both families even though M5a is proven only on the Pi.

**Two things have to be taken away from that wire before an autopilot can have it.** On a
Raspberry Pi those pins carry a login console by default, which will answer the autopilot's
traffic; and the good serial hardware — the PL011, whose baud rate is independent of the
core clock — is given to the Bluetooth radio, leaving the header with a mini-UART whose
timing drifts with that clock and which is unreliable at 921 600, the rate a fast telemetry
link is usually set to.

**Decision: take the PL011 and switch Bluetooth off.** The installer removes the serial
console from the kernel command line and disables the Bluetooth radio, so `/dev/ttyAMA0` is
UART0 on pins 8 and 10.

The alternative — moving Bluetooth to the mini-UART and keeping it, in degraded form
needing the core clock pinned — buys a radio that appears in no requirement in this
repository, at the cost of a boot configuration with more moving parts. The other
alternative, one of the Pi 4's spare UARTs on different pins, exists on the Pi 4 and 5 and
not on the Pi 3, the Zero 2 W or the compute modules, so it would mean a different wiring
diagram and a different boot configuration per board, against `R-HW-04`'s one image per
family.

The installer owns one marked stanza in `config.txt` and never touches the rest, following
the pattern `scripts/pocket2/enable-gadget-mode.sh` already established for the USB-C port.

**What this gives up** is the serial console as a recovery path. That is a real loss and it
is stated rather than left to be discovered: a board that will not boot can no longer be
questioned over those pins with a USB-TTL adapter. The access-point floor (`R-NET-07`)
remains the designed way back in, and it does not depend on the serial port.

---

## 3. Finding the autopilot

`R-MAV-01` says detect automatically, sweeping four rates. **The sweep is the only
mechanism** — a UART must be told a speed before it can turn a wire into bytes, so there is
nothing to sense and nothing to be clever about. Everything worth improving is around it.

### Leave a wrong speed the moment it proves wrong

The ordinary implementation dwells a fixed two seconds on each rate, waiting to see whether
a heartbeat turns up. That is backwards. At the wrong speed **bytes still arrive** — plenty
of them, and all malformed — and malformed bytes are proof of a mismatch in a few hundred
milliseconds. The full wait is only owed to a rate at which *nothing at all* arrives.

### Stop on the first good frame

A MAVLink frame carries a known start marker and a checksum. One frame whose checksum
passes is certainty; noise does not produce that by accident. At the right rate that is one
heartbeat interval, so under a second.

Together these take the worst case from about eight seconds to under three, and the ordinary
case to under one.

### Three outcomes, not two

The reason to read the kernel's per-port count of framing errors is not speed. It is that
it separates three situations a plain sweep reports with one word:

| What arrives | What it means | What the console says |
|---|---|---|
| Nothing, at any speed | Nothing is transmitting on that wire | Check pin 8 to the autopilot's RX, pin 10 to its TX, ground on pin 6. A swapped pair looks exactly like this |
| Bytes and framing errors at every speed | Something is talking, in a protocol that isn't MAVLink or at a rate outside the four | The autopilot's port is probably set to another protocol or another speed — check its `SERIALn_PROTOCOL` and `SERIALn_BAUD`. The wiring is fine: a swapped or missing wire gives silence, not noise |
| A frame that checksums | Found it | The port, the speed, the vehicle type and the system id |

The middle row is the one worth having. It rules the wiring *out*, which is the inference an
operator would otherwise spend an evening making with a multimeter. This is `R-CAM-12`'s
*say what was rejected and why*, applied to a serial port, and it is the reason for the new
requirement in §7.

**This rests on an assumption — see §10.1.**

### The answer is remembered, never configured

Every boot tries the port and speed that worked last time first, which in the ordinary case
finds the autopilot in under a second and never sweeps at all. If that fails, it sweeps.

**The remembered value lives in a state file, not in `config.yaml`.** `R-CAM-06` was
withdrawn for exactly this: writing a probed result into configuration fails twice, because
the installer seeds `config.yaml` only when absent so the value goes stale on upgrade, and
an image built in a chroot on a build host would carry the build machine's answer into every
board. The same reasoning applies unchanged to a serial port. Swapping an autopilot or
changing its baud rate then heals itself on the next boot with no operator action and
nothing stale left behind.

An operator may still pin `mavlink.serial.device` and `mavlink.serial.baud` explicitly, and
an explicit value always wins over both the hint and the sweep. That is what `auto` in
[`configuration.md`](../../configuration.md) already promises.

### Nothing found is not a failure

The common case on a bench is that the board is powered before the autopilot is. If
detection ran once at boot and gave up, plugging the autopilot in afterwards would do
nothing until a reboot.

**So it keeps looking, every 30 seconds, and stops the moment it finds something.** This
costs nothing, because the router is not running while nothing has been found — there is no
traffic to interrupt and no port being held. The console shows what it is doing and how long
it has been doing it.

---

## 4. The router owns the port

**`mavlink-router` runs as its own service and fans telemetry out directly.**

```
Autopilot ──pins 8/10──► UART0 ──► mavlink-router ──┬── UDP → gcs0  :14550
                                                     ├── UDP → gcs1  :14551
                                                     ├── UDP → gcs2  :14552
                                                     ├── TCP server  :5760
                                                     └── UDP → 127.0.0.1:14559 → yonder-core
```

This is `R-MAV-06`: raw MAVLink never passes through the control plane on its way to a
ground station, so a Node-RED restart is invisible to Mission Planner. `yonder-core` is a
consumer of a loopback copy and a producer of commands, never a link in the chain.

### Boot order, because the port is contended

The router opens the serial port and keeps it. Detection needs the same port. So they are
ordered rather than raced:

1. `yonder-core` starts and reads the configuration.
2. If the port or speed is `auto`, detection runs — remembered hint first, then the sweep.
3. The renderer writes `mavlink-router`'s configuration with what was found.
4. The router starts.
5. The loopback listener opens on `:14559`.

If nothing is found, step 3 never happens and the router never starts, which is what makes
the retry in §3 free.

**Re-detecting while the router is running means stopping it**, which interrupts every
ground station. So re-detection is an operator action with a warning, never something Yonder
decides to do on its own — the same instinct as `R-NET-12`, where the console says the
access point is about to drop before it drops it.

### One writer, as everywhere else

`/etc/mavlink-router/main.conf` is generated from `config.yaml` and rewritten from scratch
on every apply. Editing it by hand survives until the next apply and then disappears. This
is the rule that makes rollback possible and it is not relaxed here.

**`R-CFG-13`, added with M3, makes the sharper half of that explicit:** what is generated
matches the configuration *including what the configuration no longer says*. An operator who
clears `gcs1` must find that endpoint block gone from `main.conf`, not standing at its old
value — otherwise telemetry keeps arriving at an address nobody asked for it any more.
Generating from scratch satisfies this by construction, which is exactly why it is done that
way, and it is asserted rather than assumed.

**Packaging is an open cost — see §10.2.**

---

## 5. A telemetry change is kept, not held

`R-CFG-03`'s confirmation timer reverts *and reboots* when a change goes unconfirmed. That
is exactly right for a Wi-Fi change: it is what stops a typo bricking a board.

Applied to a telemetry change it is a different animal. **An operator adds a second ground
station mid-flight, their console link is marginal for two minutes, and the companion
computer reboots in the air.** The autopilot flies on — that is `R-CMD-04` working — but the
video, the telemetry and the mesh all drop and come back a minute later, because somebody
typed a port number.

`R-CFG-12` already has the rule: a change that cannot cost reachability is kept, not held.
A ground-station address touches no interface, no route and no radio. It cannot take the
console away from anyone.

**Decision: the telemetry fields that cannot cost reachability are exempt from the
confirmation window — named one leaf at a time.**

`affectsReachability` names leaves, never subtrees, and `reachability.ts` is explicit about
why: deleting `remote.zerotier` whole would hand the exemption to every field added under it
later, with nobody deciding it should have one. Its own worked example is `allow_default`,
the one ZeroTier setting that *can* replace the default route — which would have shipped
kept, with no window and no rollback timer, under a subtree exemption.

So the exempt set gains **`mavlink.endpoints`, `mavlink.autocast`, `mavlink.tcp_server.enabled`
and `mavlink.tcp_server.port`**, individually. **`mavlink.serial` and `mavlink.ingest` are
deliberately left load-bearing**: the first moves which wire the router opens, and the second
opens an unauthenticated command path to the vehicle (`R-MAV-07`). Neither has been shown to
be safe to keep, and `R-CFG-12` treats what has not been shown to be safe as load-bearing.

**The console still warns before it acts.** Applying an endpoint change restarts the router,
which interrupts the ground stations already receiving for as long as that takes. The page
says so before the operator presses the button, the way the network page already does before
moving the radio.

**An endpoint change shows no countdown, deliberately.** The Network page shows a
confirmation timer because a Wi-Fi change can lock you out. An endpoint change shows none
because it cannot. The absence is the design, and the log line says why in words an operator
reads: *kept without a confirmation window — a telemetry change cannot cost reachability*.

**But two changes on this page are not exempt, and they do pend.** `mavlink.serial` and
`mavlink.ingest` were deliberately left load-bearing above, which means changing either one
goes through the ordinary window — and `R-UI-15`, added with M3, requires that *while a
change is in force and unconfirmed, every surface of the console shows that it is and how
long remains*. So the Telemetry page needs a pending state, and it is the same one the Status
page now carries. Saying "this page has no countdown" without that qualifier would be false
for the most consequential control on it.

---

## 6. What the console may claim about a ground station

MAVLink is bidirectional, and ground stations heartbeat back. Mission Planner and
QGroundControl both send their own heartbeat to the vehicle for as long as they are
connected. **So the aircraft is not limited to saying "I sent packets to this address" — it
can know whether anything is there.**

That distinction is the one the ZeroTier work already had to make and named: *configured is
not connected*. A client reports a network as configured long after it can reach anything.
A list of three ground-station addresses is the same illusion — three green rows and nobody
listening.

**Decision: the console reports that a ground station is answering, and when it last did.
It does not claim which one.**

The router hands `yonder-core` one merged copy of everything, including traffic arriving
from ground stations, and every ground station identifies itself the same way — so which of
three answered cannot be recovered from the traffic alone. Per-endpoint attribution would
have to come out of the router's own counters.

**What this gives up** is telling a working endpoint from a dead one when more than one is
configured. An operator with three ground stations configured and one answering sees
"answering", not which. That is stated here rather than left as a surprise, and §10.3 says
what would change it.

What is reported instead is every part that *is* measured: the heartbeat arriving from the
autopilot and its rate, the vehicle type and system id the heartbeat carries, whether
anything has ever answered and when it last did, the byte rate in each direction, and the
TCP server's connected client count.

---

## 7. Requirements to add

Rule 3: these are added to [`requirements.md`](../../requirements.md) in the same change
that implements them. The R-MAV block currently ends at R-MAV-12.

| ID | Requirement | P |
|---|---|---|
| R-MAV-13 | **When no flight controller is found, say which kind of nothing it is.** A sweep that ends without a link distinguishes three outcomes and reports the one it reached: nothing transmitting on the wire at any speed, which is also what a swapped or missing pair looks like and is reported with the pins to check; bytes arriving at every speed that never form a valid frame, which rules the wiring out and points at the autopilot's own protocol and baud settings; or a link. Detection continues on a cadence rather than giving up, because a board is routinely powered before the aircraft it is wired to, and the interface says how long it has been looking and when it will look again. **The port and speed a probe found are never written to the configuration** — they are remembered as a hint that is tried first and discarded when it fails, so replacing a flight controller heals on the next boot rather than needing a file edited (the reasoning R-CAM-06 was withdrawn for, applied to a serial port) | 1 |

**`R-CFG-12` gains further exemptions rather than a new ID.** Its text is extended the way
`R-VPN-07` extended it for a mesh join, and to the same standard: four leaves are named —
`mavlink.endpoints`, `mavlink.autocast`, `mavlink.tcp_server.enabled` and
`mavlink.tcp_server.port` — on the grounds that none of them touches an interface, a route or
a radio, and that the window's own remedy is to revert *and reboot*, which would take the
video, the telemetry and the mesh off a flying aircraft in exchange for protecting nothing.
`mavlink.serial` and `mavlink.ingest` are named as deliberately *not* exempt, so that a later
reader knows they were considered rather than missed.

**No new ADR.** ADR-0001 already settles that this logic lives in node packages; the
architecture document already names `mavlink-router` and the loopback copy. Nothing here
reopens a settled decision.

---

## 8. Where it goes in the console

**A new page, `Telemetry`, between Network and Log.** Not a tab on an existing page: it is
its own subject, and the Network page is already four tabs deep.

The layout follows the Status page — a main column and a rail — rather than the Network
page's tabs, because everything on it is one subject read at once rather than four
alternatives.

| Panel | Holds |
|---|---|
| **Autopilot** (main) | Link state; port; speed; vehicle type and system id; heartbeat rate; last heard. Or, when there is no link, the §3 diagnosis as a `.yonder-warning` band naming the pins or the autopilot parameters |
| **Ground stations** (main) | Whether anything is answering and when it last did; the three endpoints as fields with one commit action; the TCP server and its client count; a throughput sparkline |
| **Telemetry** (rail) | Running state; autocast; where incoming MAVLink is accepted from; start/stop |
| **Path check** (rail) | `R-DIA-04`, as a three-link chain rather than a verdict |

### Five things the design settles by being looked at

**The endpoints needed a verb.** Three fields with no action was the first version and it
had no way to enable anything. The console's own idiom supplied the answer: the ZeroTier tab
puts a Network ID field and a Join button in one group, so readouts and controls in one panel
*is* the house style — the panel was missing its verb, not its separation. The button reads
**Send telemetry here**, matching the register of Refresh, Scan, Join and *Use access point*.

**An edited field says it is edited, and a sent one says it is sent.** `K-25` is already open
against a control showing a value the device rolled back. An unsent change outlines the field
in the addressable colour and says so beside the button; after applying, the outline clears
and the line reports what is now true.

**The path check reads as a chain, and a link nobody attempted shows a dash rather than a
cross.** When the autopilot is missing, *Yonder to ground stations* is "nothing to send" and
*Ground station to Yonder* is "not checked" — grey for never-attempted, not red for failed.
The same distinction the Status strip makes.

**The path check lives here rather than on Diagnostics**, though `R-DIA-04` is a diagnostics
requirement. When telemetry is broken this is the page the operator is already on, and it is
the page that just told them something was wrong; sending them elsewhere to ask why serves
the requirement list rather than the operator.

**Stopped is not broken.** `R-MAV-09`'s stopped state keeps the autopilot half of every
instrument alive and takes the ground-station half to neutral grey — *stopped by you* — and
the sparkline falls to the floor rather than holding a stale rate.

**One thing §5 specifies has not been drawn.** The warning that applying an endpoint change
briefly interrupts the ground stations already receiving is described there and appears on no
screen yet. It belongs beside the commit action, in the same register the network page uses
before it moves the radio, and it is the one piece of this page still owed a picture.

### The Status page gains a Telemetry group

One glanceable answer to *is it flowing, from where, and to where*, as a flow of three cells
with the rate on each leg: the autopilot and the port it answered on, Yonder, and the
destination with its address and TCP client count. When there is no autopilot the strip does
not blank or go red — the first cell names what is missing, the arrows go dashed and grey,
and the legs read "no heartbeat" and "nothing to send". The destination stays as it is,
because it is still configured; it simply is not receiving.

This is the same instrument as the path check, in one line instead of three, and it is drawn
from stylesheet and vector rules like every other instrument (`R-UI-13`).

### Opening the command path

`R-MAV-07` keeps incoming MAVLink on loopback. Turning that off is the most consequential
switch on the page, and it gets the treatment `R-NET-12` established: say what will happen
before it happens. Two soft keys, and a warning band that states the consequence without
softening it — *MAVLink carries no password; every device on every network Yonder is joined
to, the mobile network and the mesh included, can arm it, change its flight mode and write
its parameters, with no credential at all* — and then the honest qualifier, that the
autopilot still checks every command and Yonder still logs each one, and neither of those is
authentication.

**The mark is amber, not red and not magenta.** Red means failed, and this has not failed.
Magenta is spent on the one control that takes the page away from the operator, and this does
not. Amber already carries "the boundary you have to understand before you cross it" in the
generated stylesheet, which is exactly what this is. Considered and rejected: a fourth tone
meaning *deliberately on and dangerous*. It would apply again to arming and to payload
outputs in M7, so it may yet be right — but inventing it here, for one control, ahead of the
milestone that would use it three times, is the wrong order.

### The Log

Telemetry writes to the activity log at `info`, and twice at `warn`: when a sweep ends with
no autopilot, carrying the §3 diagnosis; and when incoming MAVLink is opened to the network,
which `R-MAV-07` requires be logged. The endpoint-change line states why there was no
confirmation window, so the `R-CFG-12` exemption reaches the operator instead of remaining an
invisible policy.

### One thing the page uncovers about R-UI-12

`R-UI-12` captures every page in both palettes and fails the build when one changes shape
unreviewed, and it was already extended once — for the tabbed Network page — to say that a
surface hiding part of itself is captured in each of those parts.

**The Telemetry page hides part of itself without being tabbed.** It has six mutually
exclusive states — linked, searching, not-MAVLink, stopped, ingest open, and a change
pending — and a capture run against whichever fixture the harness happens to supply proves
nothing about the other five.

**M3 has since answered the mechanical half of this.** `verify-pages.sh` now drives real
states through the daemon and captures each under its own name — `status-without-modem`,
`status-pending`, `status-psk-changed` — and `capture-pages.mjs` reasons explicitly about a
panel drawn from live state hiding its other states. So there is nothing to invent: this page
is captured in each of its six states the way the Status page already is in four.

What M3 did *not* do is amend `R-UI-12`, whose text still speaks only of tabs. The practice
has moved ahead of the requirement. That is worth closing — but it is a requirements change
of its own and it belongs to whoever next touches `R-UI-12`, not to this milestone.

### Four requirements M3 added that this page must meet

None of these existed when the screens were drawn, and all four land on them.

- **`R-UI-15` — a pending change is visible everywhere.** Covered above: the page needs a
  pending state, because opening ingest is not exempt.
- **`R-UI-16` — every piece of text on a control is legible against what is behind it, in
  both palettes, and *the build measures it*.** Not reviewed by eye. The flow strip's cells
  and captions, the annunciators and the soft keys are all new surfaces and all must pass
  that measurement rather than a reviewer's judgement.
- **`R-UI-17` — a field that edits a setting opens showing that setting.** The three endpoint
  fields open carrying the configured host and port, and an unset one says so. The screens
  already do this; it is now a requirement rather than a preference.
- **`R-UI-19` — every node type the shipped flows use is provided by a package the install
  path installs, and the build fails when one is not.** The flow strip and the four
  `yonder-mav-*` nodes have to be in the install payload, not merely in the repository.

### Widths

Laptop is the target. Below 1024 pixels the rail stacks under the main column, the drawer
collapses, and the flow strip turns vertical with its arrows pointing down. This is a reflow,
not a second design, and it is what `R-UI-04` — *remain usable on a tablet in the field*, P2 —
actually asks for. Checked at 768 and 390.

---

## 9. Shape of the code

```
packages/yonder-core/src/mav/
├── detect.ts        the sweep: fast-fail, first-good-frame, three outcomes
├── frame.ts         pure: enough MAVLink to recognise a heartbeat and read its identity
├── hint.ts          the remembered port and speed — state, never configuration
├── router/
│   ├── config.ts    mavlink-router's configuration, rendered from config.yaml
│   └── fixtures/    recorded real output, committed
├── link.ts          pure: heartbeats and counters -> the one link state the console renders
└── renderer.ts      MavlinkRenderer implements Renderer

packages/node-red-contrib-yonder-mavlink/   nodes: thin adapters over the daemon socket
packages/node-red-dashboard-2-yonder/       the flow strip, as a component
flows/flows.json                            wiring only: the Telemetry page
```

This follows `src/net/` and `src/remote/` exactly, including the parts that carry the most
weight:

- **Nothing shells out except the renderer**, through the injected `CommandRunner`
  ([ADR-0006](../../adr/0006-nmcli-not-dbus.md)). No test starts `mavlink-router` and no test
  opens a serial port.
- **`frame.ts` and `link.ts` are pure**, which is where most of the logic and most of the
  tests live. `frame.ts` is deliberately small: a start marker, a length, a checksum, and the
  handful of fields a heartbeat carries. It is not a MAVLink library and must not grow into
  one — that decision belongs to M5b.
- **Fixtures are recorded real bytes**, as `src/net/nmcli/fixtures/` already are, and the
  awkward ones are the point: a sweep that finds nothing, a sweep that finds noise at every
  rate, a heartbeat from a vehicle type nobody expected.

The flow strip is a Vue component in `node-red-dashboard-2-yonder`, not markup in a
`ui-template` — rule 2, and `R-UI-13`, which is also what lets it follow both palettes
without a second set of files.

---

## 10. What this document rests on

Three assumptions. Each is one bench evening to settle, none changes the shape of M5a, and
two change a detail inside it.

### 10.1 That the kernel reports framing errors per port

`R-MAV-13`'s middle outcome — *something is talking but it isn't MAVLink* — needs a per-port
count of malformed bytes, which Linux exposes through `TIOCGICOUNT`. Whether the Pi's PL011
driver populates it usefully has not been checked on the board.

**If it does not**, the outcome does not vanish, it gets cruder: bytes arriving that never
parse is still detectable by counting bytes received against frames accepted, without knowing
they were malformed at the hardware level. That is very nearly as good and the console's
wording would not change. **If neither is available**, `R-MAV-13` reduces to two outcomes —
found and not found — and the wiring advice is given in both cases rather than only the one
where it applies. The requirement should be written to allow that, and this is the check to
do first.

### 10.2 That `mavlink-router` can be built and carried offline

It is not in Debian. It is a Meson build from source, so M5a needs it compiled for arm64 and
carried in the offline payload with a pinned version and a recorded fingerprint — the shape
`R-VPN-08` already defines and M2a already proved for ZeroTier, on a board, with `apt`
pointed at a dead proxy.

**Nothing about the design changes if this is harder than expected**, but the plan does: it
is a CI build step and an installer role that do not exist, and it is the only part of M5a
whose cost is genuinely unknown. **If it turns out to be unworkable**, the fallback is a
small dedicated forwarder in its own process — which satisfies `R-MAV-06` by being a separate
process, and costs us a proven component in exchange for one we would have to prove.

### 10.3 That the router will not attribute traffic per endpoint

§6 reports "a ground station is answering" rather than which one, partly because the merged
loopback copy cannot distinguish them and partly because nobody has checked what
`mavlink-router` reports about its own endpoints.

**If it does expose per-endpoint counters usably**, the better design becomes available and
the page changes very little — the single *Receiving* row becomes a state per row, and each
endpoint field gains a live-or-silent mark beside it. The layout was drawn to accommodate
that: the rows already exist and already have space to their left.

Worth checking on the same evening as 10.2, because it is the same binary.

---

## Evidence

**None.** This document is argued, not measured — which is the opposite of the remote-access
spec it sits beside, and the difference is stated here rather than left to be assumed.

What it is argued from: the requirements in [`requirements.md`](../../requirements.md); the
decisions already recorded in [`architecture.md`](../../architecture.md) §3.1 and
[`configuration.md`](../../configuration.md); the console's own generated stylesheet and
component set, which supplied every visual answer in §8 and settled at least one question the
design had got wrong; and the reasoning behind `R-CAM-06`'s withdrawal, `R-CFG-12`'s
exemption rule and `R-NET-12`'s warn-before-you-act, each of which this milestone reaches for
a second time.

The screens in §8 were built against the real generated stylesheet — `themeCss()` run from
`yonder-core`, not an approximation of it — and rendered at 2× in both palettes and at three
widths before being agreed. That is evidence about the design, and none at all about the
board.

**They are committed, in [`docs/console/design/telemetry/`](../../console/design/telemetry/README.md),
and its README names the node type behind every control.** That is not tidiness. The camera
view's spec described its deck's behaviour and never said "every control is an instrument, and
here is the list"; the plan inherited the gap and filled it with what Dashboard already
shipped, and eleven of twenty-three widgets came out as stock controls — the thing ADR-0009
exists to prevent. §8 below says what each panel *holds*, which is the same prose that failed
there, so the binding list lives beside the mockups and the plan builds from that.
