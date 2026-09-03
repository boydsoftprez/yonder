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

## 4. The other two surfaces

**`Way out`, on the Interfaces tab.** Every path in the operator's configured order, with
its standing and a sentence saying why. It belongs on Interfaces rather than on Cellular
because it is about all three paths, and Interfaces is the tab that already covers all
three.

Its wording is what hardware forced, and it is three states rather than two:

| | |
|---|---|
| reaching | `Ready — traffic is not going out over cellular` |
| not reaching | `Reached nothing when it was last tested, and is still in the running` |
| untested | `Up, and not yet tested — nothing has established that it reaches anything` |

The third is the one that matters. A path nobody has tested must not claim to be ready —
the same distinction between *not yet condemned* and *working* that the fallback watchdog
had to learn, showing up at the display layer.

**`Reachable by`, on the Status page.** Under `This board`, in that page's existing idiom:
the same meter-and-value-box as CPU load and the same divided strip of small labelled
values. One word for how the aircraft is reachable now, and a line for what changed and
when. Status uses plain words — `SIGNAL`, `QUALITY` — where the tab uses RSRP and SINR. Same
values; a glance and a detail view.

---

## 5. What the daemon gains

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

## 6. Requirements

Rule 3: added to `docs/requirements.md` in the same change that implements them. R-CEL ends
at R-CEL-11, R-UI at R-UI-14.

| ID | Requirement | P |
|---|---|---|
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

## 7. Shape of the code

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

## 8. What R-UI-12 requires of this

Every tab captured in both palettes, and **the `Way out` panel captured in more than one
state.** That is not a formality. Building these screens the first time surfaced a defect
visible in exactly one data shape — an interface name right-aligning inside its own column,
because it had been given a class carrying `text-align: right`, which showed only when the
qualifier beneath it was the wider line. One capture in one state passed it.

The three path states in §4 are three shapes. Capture them.

---

## Evidence

Instruments read from `packages/node-red-dashboard-2-yonder/src/ui/` at `70ab902`.
Daemon routes read from `packages/yonder-core/src/daemon/routes.ts` at the same commit.
Console layout read from the deployed `/var/lib/yonder/console/flows.json` on a Raspberry
Pi 4, whose Network page carries `Interfaces | Wi-Fi | ZeroTier | Activity` and no mention
of a modem. Signal figures from that board's own EC25-AF on a live SIM, 2026-09-03.
