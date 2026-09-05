# The cellular console — design

**Milestone:** M3b · **Date:** 2026-09-03 · **Status:** agreed, not yet planned

M3a built the link and gave it no interface. The daemon reports what the modem says and
which way out is working; nothing renders either. This document settles what the operator
sees, what they can do about it, and what the daemon must gain for them to do it.

It supersedes §8 of [the cellular design](2026-09-02-cellular-design.md) where the two
differ. That section was written before any of it ran on hardware, and the board changed
three things: what the panels say, which instruments they are built from, and the fact that
being told a link is broken is worth little without a way to fix it from the same screen.

---

## 1. What M3a left, and what is missing

`GET /modem/state` and `GET /reach/state` are served and correct. There is no Cellular tab,
`packages/node-red-contrib-yonder-modem/` is a single `.gitkeep`, and the console's
flows mention the word `modem` zero times.

Two things the interface needs have no route behind them:

- **Nothing can ask for a test.** R-CEL-09 says the link is tested "when it comes up **and
  on request**". M3a built the first half.
- **Nothing can write `network.modem`.** The Wi-Fi tab has `/net/join`; M2a added
  `/remote/join` and `/remote/leave`. An APN typed into a form has nowhere to go.

**M3b builds both.** Being told an APN is wrong while having to fix it over `ssh` is most of
the value thrown away: the recovery is the point, and the console is where the operator
already is when they find out. A modem change is reachability-affecting, so it inherits the
confirmation timer and the rollback engine unchanged — which is what makes a wrong APN
typed into a form recoverable rather than fatal.

---

## 2. Built from the instruments that exist

The instrument library already carries everything this needs, and the exercise of drawing
the tab against it changed the design for the better:

| Instrument | What it carries here |
|---|---|
| `ui-yonder-annunciator` | The verdict — carrying traffic, or not (R-UI-11) |
| `ui-yonder-gauge` | RSRP and SINR, against their bands (R-UI-09) |
| `ui-yonder-databar` | Operator, network, registration, addresses, MTU, the lesser signal numbers |
| `ui-yonder-softkeys` | `TEST NOW` in the action tone, `CONNECT` in the irreversible one (R-UI-10) |

**No new instrument is added.** The verdict in particular stops being a headline and becomes
a lit caption, which is what R-UI-11 asks for and what the earlier mockups got wrong.

### The gauge has to learn which direction is bad

`ui-yonder-gauge` lays its bands good → caution → bad from left to right and fills as the
value climbs. That is correct for temperature and load, and backwards for signal, where
higher is better. Inverting the scale puts the bands in the right place and leaves the bar
filling as the link dies — a full gauge meaning a failing link, which is the opposite of
what anyone glancing at it would read.

**The gauge is taught both senses**, and told which applies. Signal is not the last
higher-is-better quantity this project will draw — battery charge, link margin and
throughput headroom all read the same way — and solving it in the instrument once is what a
shared visual language is for. Everything already using the gauge keeps its present
behaviour; the new sense is opt-in.

R-UI-09 already names **signal** among the quantities that must be drawn against their
bounds, so this is that requirement being met properly rather than a new one. **R-UI-09
gains a sentence** saying which direction is bad is a property of the quantity and is
stated, not assumed. The ID does not change.

### The bands

Standard cellular thresholds, because a number that looks alarming here must look alarming
in every other tool an operator might check, including a carrier's support desk:

| | good | marginal | bad |
|---|---|---|---|
| RSRP (`SIGNAL`) | above −90 dBm | −90 to −105 | below −105 |
| SINR (`QUALITY`) | above 13 dB | 0 to 13 | below 0 |

The board this was designed against reads RSRP −99 to −103 and SINR 11 to 19 — marginal on
strength, good on quality, and working. The gauge saying "marginal" there is correct: it is
a bench with a small antenna.

RSSI and RSRQ are shown as values, not gauges. RSSI is total received power including
interference and is the weakest of the four; SINR is what predicts whether video holds up,
and it and RSRP are the two that earn a band.

---

## 3. The Cellular tab

**Two columns**, three titled panels: `Cellular`, `Signal`, `Connection`.

`Cellular` carries the annunciator, a sentence naming the likely cause when nothing is
getting through, and the facts — operator, network, registration, address, public address,
MTU, composition. `Signal` carries the two gauges, the two lesser numbers, and the line
saying the readings cost no cellular data. `Connection` carries the form — APN, dial number,
username, password — and the softkey rail.

The tab holds three different kinds of content: a verdict, a set of measurements, and a
form. Each earns its own title, which one panel cannot give them, and the whole tab fits
without scrolling. It is also what the Network page looked like before it was tabbed.

**The ZeroTier tab beside it is a single full-width column and will not match.** That is
accepted, and the direction of the fix is to bring ZeroTier into line later rather than to
narrow this one — recorded as a follow-up, **out of scope for M3b**, because it means
reopening merged work and recapturing its references for a change nobody has asked for.

**No APN is suggested, completed or offered as a list** (R-CEL-09). The published carrier
database's first answer for the SIM this was built against was the value that failed, and
the value that worked was absent from it.

---

## 4. The Interfaces tab

**`Way out`** lists every path in the operator's configured order. Each row is the path's
name, its standing as a **lit annunciator**, and a sentence saying why it is in that state.
The annunciator rather than coloured text is R-UI-11: the lamp is read before the word.

It belongs on Interfaces rather than on Cellular because it is about all three paths, and
Interfaces is the tab that already covers all three.

Its wording is what hardware forced, and it is three states rather than two:

| | |
|---|---|
| reaching | `Ready — traffic is not going out over cellular` |
| not reaching | `Reached nothing when it was last tested, and is still in the running` |
| untested | `Up, and not yet tested — nothing has established that it reaches anything` |

The third is the one that matters. A path nobody has tested must not claim to be ready —
the same distinction between *not yet condemned* and *working* that the fallback watchdog
had to learn, showing up at the display layer.

The `Interfaces` panel beside it holds addresses and nothing else: the value column is an
address, anything that is not one is a quiet qualifier under the interface name, and an
interface with no address shows a dash rather than a sentence dressed as a value.
`Hostname` is not an interface and sits below the divider as `NAME`.

---

## 5. The Status page

This section is larger than "add a cellular panel", and two of the three things in it are
not cellular at all. They are here because the page is being rebuilt anyway and doing that
twice costs more than doing it once, and because designing the cellular panel is what
surfaced them. Each carries its own requirement.

### `REACHABLE BY`

A sibling of `THIS BOARD`, in that panel's idiom — gauges over a labelled strip — because
it is the same kind of thing: a few live measurements and the facts that identify them. It
is **not** a sibling of `REMOTE`, which is a one-line summary.

Full width, directly below `THIS BOARD`, so the page reads *the board → how you reach it →
the mesh → the way back in*. The gauge track is twice its width on the Cellular tab, which
is the reason for the full-width placement: at that size the amber and green bands separate
at a glance, which is the whole point of a banded gauge on a page that is glanced at.

**It degrades rather than breaks.** On a board with no modem the gauges are absent and the
panel is an annunciator over a strip. Nothing shows an empty gauge or a dash where a signal
would be: a gauge with no needle reads as a fault, and *there is no modem* is not a fault.

Status uses plain words — `SIGNAL`, `QUALITY` — where the Cellular tab uses RSRP and SINR.
Same values, a glance and a detail view.

### `CHANGE PENDING`, and the page it is missing from

The confirmation timer is what makes this device unbrickable (R-CFG-03). The apply engine
tracks the pending change and its deadline, and the contrib nodes render it — **on the page
where the change was made, and nowhere else.** Make a change on the Network page, navigate
to Status, and nothing tells you that the configuration reverts in ninety seconds unless
you confirm it.

**A banner at the top of Status, present only when a change is pending**, carrying the
countdown, what changed, and the two actions. `Confirm` takes the irreversible tone;
reverting does not, because reverting is the safe direction.

Its wording does not threaten the operator with the revert. The revert is the thing that
rescues them, and the sentence says so: *if you do not confirm it, the device puts the
previous configuration back by itself — which is what gets you back in if this change was
the wrong one.*

### `IF YOU LOSE THIS CONSOLE`

The one thing an operator needs when nothing else on the page is true any more: which
network to join, the passphrase, the address, the name. Status is the page they will be
looking at while it goes wrong, so the way back in belongs on it.

**The passphrase is printed only while it is the published default.**
[ADR-0007](../../adr/0007-credential-boundary.md) makes the shipped passphrase deliberately
public — a per-device one could only be read from the device you are locked out of, so it
guarded nothing and locked out the legitimate operator. Once an operator changes it, it is
theirs, and printing it would be a credential in an API response (R-SEC-10). The panel says
it has been changed, and does not show it.

### What is deliberately not added

MAVLink streaming state, video status, autocast controls and telemetry endpoints are M5 and
M4. Yonder has no flight-controller link and no video pipeline, and a panel for a subsystem
that does not exist is a panel that will be wrong when it does. The layout leaves room, and
`REMOTE` is already the worked example of a one-line summary of a subsystem.

`APPEARANCE` is removed. It explained why two palettes exist, which is an argument that
lands once, on a page an operator returns to. With it gone, everything on Status is about
the aircraft. `THIS BOARD` becomes full width as a consequence and its gauges widen to
match, so all four gauges on the page read at one scale.

---

## 6. What the daemon gains

Two routes, in the shape M2a set:

- **`POST /modem/configure`** takes the form's fields, merges them into `network.modem` of
  the loaded configuration, and hands the whole document to the apply engine — exactly as
  `/remote/join` does. Nothing is stored anywhere else. The password goes to
  `secrets.yaml` through the existing path and never appears in a response (R-SEC-10).
- **`POST /reach/test`** names one path — `ethernet`, `modem` or `wifi_client` — tests that
  one, and returns when its answer is known, so the caller can show a result rather than
  hoping the next poll carries one. It refuses a path this board does not have. This is
  R-CEL-09's "on request", and it is the only way a standing-by path gets re-tested: M3a
  probes such a path once when it comes up and never again, deliberately, because a path
  nothing routes over costs nothing to leave alone.

  **It is not a second way to decide anything.** The result goes through the same
  `Standing` the automatic probes feed, so a test an operator asked for and a test the
  device ran itself are the same evidence, and one cannot contradict the other.

Both are behind the administrator password like every other configuration route
(R-SEC-04, R-SEC-09).

---

## 7. Requirements

Rule 3: added to `docs/requirements.md` in the same change that implements them. R-CEL ends at
R-CEL-11, R-UI at R-UI-14, R-SEC and R-CFG at 12.

**The way back in shipped as R-UI-18, not the R-UI-16 this document first gave it.** Two
defects found on the board while M3b was being built took R-UI-16 and R-UI-17 first — the
contrast measurement and the seeded form — and IDs are never reused (rule 3), so the way
back in took the next number. Its row below carries the text now in `docs/requirements.md`,
which gained a third clause after this was written: a device that cannot establish which
passphrase its access point is on says so.

| ID | Requirement | P |
|---|---|---|
| R-UI-15 | **A change that will revert is visible wherever the operator is, not only where it was made.** While a configuration change is in force and unconfirmed, every surface of the console shows that it is, how long remains before it reverts, and offers the means to confirm or revert it now. The confirmation timer is what makes the device unbrickable, and an operator who has navigated away from the page they changed something on is exactly the operator about to lose a working configuration to a timer they cannot see. The wording states the revert as the thing that recovers them, not as a threat | 1 |
| R-UI-18 | **The device shows how to get back to it.** The console names the access point, its address and the name it answers to, on the page an operator looks at when something is wrong. **The access-point passphrase is shown only while it is the published default** — that value is deliberately public and is what makes a locked-out operator's way back in usable at all; one the operator has set is theirs, and the interface says it has been changed rather than printing it. **A device that cannot establish which passphrase its own access point is on says so**, rather than naming the published default at an operator for whom it will not work (R-SEC-01, R-SEC-10) | 2 |
| R-CEL-12 | **The interface that reports a broken link is the one that can repair it.** Where the console shows that a cellular link is not carrying traffic, the settings that would fix it are editable from the same surface, and the change goes through the ordinary confirmation and rollback path so that a second wrong value is recoverable rather than fatal. Reporting a fault an operator must then leave the console to correct is most of the value of reporting it thrown away | 2 |

**R-UI-09 gains a sentence rather than a new ID.** It requires a bounded quantity to be
drawn against its bounds, and names signal among them; it does not say which direction is
bad. An instrument that assumes one direction draws signal backwards — a full bar for a
dying link. The requirement is extended to say that which direction is bad is a property of
the quantity and is stated rather than assumed. The ID does not change.

**No new ADR.** [ADR-0009](../../adr/0009-console-visual-language.md) settles the visual
language and this adds nothing to it; the gauge change is that language being applied to a
quantity it already named.

---

## 8. Shape of the code

```
packages/node-red-contrib-yonder-modem/     # currently one .gitkeep
├── src/
│   ├── state.ts        # polls /modem/state and /reach/state
│   ├── format.ts       # units, phrases, band arithmetic — pure
│   ├── configure.ts    # POST /modem/configure
│   ├── test.ts         # POST /reach/test
│   └── red.ts
packages/node-red-dashboard-2-yonder/
└── src/ui/YonderGauge.vue                  # the second sense
flows/flows.json                            # wiring only, per rule 2
```

It mirrors `node-red-contrib-yonder-remote` — `state.ts`, `format.ts`, an action node per
route, `red.ts` — because that package is the worked example of this shape and a second
shape would be a second thing to learn.

`format.ts` is where the band arithmetic lives, and it is pure and tested: turning
−99 dBm into a fraction and a tone is exactly the kind of thing that is wrong by a sign
somewhere and invisible on a screenshot.

---

## 9. What R-UI-12 requires of this

Every tab captured in both palettes, and **the `Way out` panel captured in more than one
state.** That is not a formality. Building these screens the first time surfaced a defect
visible in exactly one data shape — an interface name right-aligning inside its own column,
because it had been given a class carrying `text-align: right`, which showed only when the
qualifier beneath it was the wider line. One capture in one state passed it.

The three path states in §4 are three shapes. Capture them.

**Status has two shapes of its own and both must be captured**, for the same reason: the
pending banner exists only while a change is pending, and `REACHABLE BY` loses its gauges
entirely on a board with no modem. A page captured only in its quiet, fully-populated state
is a page whose other states nobody has looked at — and the pending banner is the one an
operator sees exactly when something has gone wrong, which is the worst moment to discover
it renders badly.

That is five shapes across three surfaces, in two palettes. It is more capture than any
milestone so far has added, and it is the cost of a milestone that is mostly interface.

---

## Evidence

Instruments read from `packages/node-red-dashboard-2-yonder/src/ui/` at `70ab902`.
Daemon routes read from `packages/yonder-core/src/daemon/routes.ts` at the same commit.
Console layout read from the deployed `/var/lib/yonder/console/flows.json` on a Raspberry
Pi 4, whose Network page carries `Interfaces | Wi-Fi | ZeroTier | Activity` and no mention
of a modem. Signal figures from that board's own EC25-AF on a live SIM, 2026-09-03.
Every screen in this document was rendered against the generated `theme.ts` stylesheet and
the real instrument components before it was written down, in both palettes and in each
state the panels have.
