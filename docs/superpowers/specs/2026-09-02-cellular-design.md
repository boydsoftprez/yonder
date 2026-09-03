# Cellular — design

**Milestone:** M3 · **Date:** 2026-09-02 · **Status:** agreed, not yet planned

The roadmap places cellular after remote access and says what it must do: tethered
appliances, APN-configured modems, mode detection, signal reporting, and reconnection
without an operator. It does not settle how a modem is driven, what the console shows when
a link reports success and moves nothing, whether Yonder changes a modem's own
configuration, or what happens when a preferred path stops working. This document settles
those and records the evidence each was decided on.

Everything below was measured on a Raspberry Pi 4 running Debian 13 (trixie) arm64, with a
Quectel EC25-AF and a live SIM, on 2026-09-02. Where a status word, a number or an address
appears here it was read off that board.

This design assumes the tabbed Network page from
[the remote-access design](2026-09-02-remote-access-design.md) §6, which M2a builds. M3
adds one tab to that strip and one panel to an existing tab. It introduces no new console
structure.

---

## 1. What drives the modem

### Evidence

With ModemManager absent, `wwan0` exists as a link and NetworkManager cannot see it at
all — it is not in `nmcli device status`, because NetworkManager reaches modems only
through ModemManager. The modem is inert rather than broken, and nothing says so.

ModemManager is in Debian trixie main at `1.24.0-1+deb13u1`. Installing it, and then
creating an ordinary connection, was enough:

```
nmcli connection add type gsm ifname cdc-wdm0 apn ereseller
→ Connection successfully activated
   wwan0  10.31.95.33/30  2600:382:859c:df48:…/64   mtu 1430
   default via 10.31.95.34 dev wwan0 proto static metric 700
```

Detail that only ModemManager has:

```
operator 310410 "Dark Star" · registration home · access tech lte · packet service attached
rssi -61 dBm   rsrq -14 dB   rsrp -99 dBm   s/n 16 dB
```

### Decision

**NetworkManager owns the connection; ModemManager is read for everything it alone
knows.** No new control surface: a cellular link is an `nmcli` connection like the Ethernet
and Wi-Fi ones, so it inherits the existing renderer shape, the route metrics
`network.priority` will generate, apply and rollback, and the injected-runner seam that
makes all of it testable. [ADR-0006](../../adr/0006-nmcli-not-dbus.md) already argued this
case for NetworkManager and its reasoning carries over unchanged; `mmcli` is read the same
way, with `--output-keyvalue` as its terse machine mode.

**ModemManager is installed by `ensure_pkgs` in `10-base.sh`, beside `dnsmasq-base`.** It is
a Debian package and the installer already installs Debian packages in a chroot that has a
network. None of the offline-payload machinery R-VPN-08 needed applies: there is no
fingerprint to pin, no publisher signature to check and no custom role, because nothing is
being fetched from outside Debian.

### Three names that are not the obvious ones

Each of these was found by getting it wrong first, and each will be got wrong again by
anyone who does not know:

- **The device is `cdc-wdm0`, not `wwan0`.** `cdc-wdm0` is what NetworkManager lists, what
  a connection is bound to and what `nmcli` reports state for. `wwan0` is what holds the
  address, carries the traffic and appears in `ip route` and every other tool. Both names
  are correct for different questions and neither is correct for both.
- **The connected bearer is not bearer 0.** The modem reports two. Bearer 0 is the
  network's own initial bearer — `apn: nxtgenphone`, `connected: no` — and it is also what
  the modem reports as `3GPP EPS | initial bearer apn`. Bearer 1 is the one Yonder created,
  `apn: ereseller`, `connected: yes`, on `wwan0`. Code that reads the first bearer reads a
  bearer that is not in use and an APN nobody configured.
- **The coarse signal percentage is not the signal.** `modem.generic.signal-quality` read
  60% and later 29% while the four real numbers moved by two or three dB. It is not used.

### Installing ModemManager does not claim a modem that is already plugged in

The udev rules that tag modem ports ship *with* the package, so ports enumerated before the
install carry no `ID_MM_CANDIDATE`. `mmcli -L` answered `No modems were found`, which is
indistinguishable from unsupported hardware, and the journal said nothing beyond starting.

Re-triggering udev is required, and **a subsystem-filtered trigger is not enough.** A
trigger over `tty`, `net` and `usb` got the modem claimed but left `cdc-wdm0` untagged, and
ModemManager fell back to a modem whose primary port was `ttyUSB2 (at)` with
`wwan0 (ignored)` — which is a modem with no data port but PPP. Only a full `udevadm
trigger`, which reaches `usbmisc` where `cdc-wdm0` lives, followed by restarting the
service, produced the working arrangement:

```
primary port: cdc-wdm0 (mbim)
ports: cdc-wdm0 (mbim), ttyUSB0 (ignored), ttyUSB1 (gps), ttyUSB2 (at), ttyUSB3 (at), wwan0 (net)
```

On a freshly flashed image this cannot arise: udev runs after the package is installed. It
arises on every upgrade of an existing device, and the failure is silent and looks like
unsupported hardware. **The install role triggers udev and restarts ModemManager, and says
in a comment why.**

---

## 2. A link that reports success and carries nothing

This is the finding the milestone is built around.

### Evidence

Joining with `apn nxtgenphone` — AT&T's documented APN, and the one the network itself
names as the initial bearer — succeeded by every indicator available:

```
registered · home · lte · signal -69 dBm · bearer connected
wwan0  10.57.188.101/30 + a global IPv6 /64
default via 10.57.188.102 dev wwan0 proto static metric 700
```

And it carried nothing. `TX 56842 bytes / 142 packets`, `RX 1374 / 13`. Three pings to
`8.8.8.8`, none returned. Not `rp_filter`, which is loose on that interface; not the
firewall, whose only table is the access point's own. Making it the *preferred* default
route rather than the second one changed nothing.

Changing one field — `gsm.apn` to `ereseller` — fixed it completely, with no other change
of any kind:

```
wwan0  10.31.95.33/30
3 packets transmitted, 3 received, rtt avg 124 ms
public address 68.216.66.63 (v4), 2600:387:15:5337::7 (v6)
```

**So every reading a modem offers can be healthy while the link is useless, and the
difference is one word in a text field.**

### Yonder does not guess the APN

Debian's `mobile-broadband-provider-info` (`20250613-2`) is the obvious answer and it is the
wrong one. For this SIM's carrier (MCC 310, MNC 410 and 280) it lists, in order:

```
NXTGENPHONE · ENHANCEDPHONE · NRPHONE · broadband · RESELLER
```

`NXTGENPHONE` is first, and it is the value that attached and moved nothing. `ereseller`
does not occur anywhere in the file. So a lookup would have offered the broken answer with
confidence, and trying every candidate in turn would have spent minutes of a metered link
and still failed.

**The APN comes from the operator. The interface offers no suggestions and no candidate
list, and the package is not a dependency.**

### Decision

**Yonder tests the link with real traffic once, when it comes up, and says plainly whether
traffic is getting through.** Afterwards it watches the interface byte counters, which the
kernel keeps whether or not anyone reads them and which cost nothing on a metered link:
traffic leaving with nothing returning is the same signature that exposed this, and it is
free to observe. A `Test now` control is available whenever a fresh answer is wanted.

Nothing is tested on a timer. A healthy aircraft spends no data on health checks.

### What this gives up

A link that is up and idle — nothing sending over it — produces no counter movement, and is
not distinguishable from a dead one without an active test. That is why the connect-time
test exists, and why the manual control does. It is recorded rather than left to be
discovered.

---

## 3. Yonder does not reconfigure the modem

### Evidence

The EC25-AF arrived in MBIM composition (`AT+QCFG: "usbnet",2`) and **works in it.** The
failure in §2 was the APN throughout; the composition was never implicated. No modem in
hand needs a mode switch.

### Decision

**R-CEL-04's quirk table is not built in M3.** The requirement stands, unbuilt, at
priority 2, and the first entry is written when a modem that needs one exists to write it
against. A table whose only entry is a no-op teaches a contributor nothing about what a
real entry looks like, and would likely be reshaped by the first real one.

**R-CEL-03 is built**, because it is what makes the absence safe: Yonder reports the
composition and the ports a modem came up on, so a difficult modem is visible as an
unfamiliar arrangement rather than as an unexplained failure.

This was reconsidered once. The measurement that motivated switching compositions turned
out to be the APN, and the decision was retaken against the corrected evidence rather than
carried forward on the original premise.

Rule 4 was checked and does not bear on this either way: it forbids Yonder *originating*
commands to an aircraft, and a modem's own configuration is device configuration. Had the
answer gone the other way, the rule would not have stood in its path.

---

## 4. The modem an operator names

### Evidence

None. There is no tethered-appliance modem on this bench, and there is therefore nothing
measured in this section — which is itself the reason for what it decides.

What is known from the requirement and from the shape of the problem: such a modem
presents as an ordinary network adapter, holds the SIM and dials by itself, and exposes
neither signal, operator nor radio technology to the host. It is also indistinguishable
from a plain USB network adapter without a list of device identifiers.

### Decision

**Automatic detection covers the modems ModemManager claims, and nothing else. A tethered
appliance is named in configuration.** `mode: auto` means "use the modem ModemManager
found"; `mode: appliance` takes the adapter's name from `interface` and brings it up with
DHCP.

This needs no device-identifier list — which would be written from documentation, could not
be tested here, and would mistake an unlisted appliance for nothing at all and a plain USB
adapter for a modem. It can be exercised today with any USB network adapter.

**The interface says what it cannot report.** An appliance has no signal, no operator and
no radio technology, and the Cellular tab shows their absence as a property of that kind of
modem rather than as missing data. R-CEL-05 is answered in full for a modem ModemManager
drives and answered honestly for one it does not.

### Handling

```yaml
network:
  modem:
    enabled: false            # a device with no modem configured runs no modem
    mode: auto                # auto | appliance
    interface: null           # the adapter's name, when mode is appliance
    apn: null
    username: null
    password: { secret: modem_psk }
    dial: null                # a serial connection only; unused on this modem
```

`hilink` and `stick` are dropped from the sketch in `configuration.md` in favour of `auto`
and `appliance`. `hilink` is a vendor's word for its own product, which rule 1 excludes;
`appliance` is R-CEL-01's own. Both retired keys are listed in `configuration.md`'s
retired-keys table rather than rejected, per R-CFG-09 — a device that arrives with the
sketched spelling is named in the journal and carries on.

The password lives in `/etc/yonder/secrets.yaml` at mode `0600` and is handed to
NetworkManager as a connection property, never on a command line. It is redacted from logs
by the same mechanism the network renderer already applies.

**`enabled: false` is the default, and it means no modem is configured — not a modem that
is configured and idle.** A board with a stick plugged in and nothing in `config.yaml`
brings up no cellular connection, and the Cellular tab says a modem was found and is not
configured.

---

## 5. Signal, and where it goes

### Evidence

Detailed signal must be armed. Out of the box only the coarse percentage is available; the
four real numbers appear after a polling interval is set on the modem, which is a
privileged operation:

```
mmcli -m 0 --signal-setup=2
→ rssi -61 dBm  rsrq -14 dB  rsrp -99 dBm  s/n 16 dB
   rssi -63 dBm  rsrq -14 dB  rsrp -100 dBm s/n 14 dB
   rssi -71 dBm  rsrq -12 dB  rsrp -100 dBm s/n 16 dB
```

Ten dB of RSSI movement in ten seconds, on a bench, stationary.

**Across five polls the interface's receive counter did not move.** Signal is read from the
modem, not from the network, so displaying it at 1 Hz costs nothing off a data plan.

### Decision

**Yonder arms signal polling when the link comes up**, rather than leaving an operator to
discover that the numbers are absent because nobody asked for them.

**All four numbers are published, as named live values on the daemon's socket**, in the
same way as every other piece of device state. The Cellular tab reads them. A cockpit
instrument reads the same values later, with no second collection path to drift from this
one.

RSSI is reported because it is asked for, but it is the weakest of the four: it is total
received power including interference. RSRP is the strength of the serving cell and SINR is
its cleanliness, and SINR is the number that predicts whether a video link holds up. An
instrument built on this data should be built around SINR.

Trends and history are not built here. M3 publishes live values; the milestone that builds
the cockpit builds the chart, once.

---

## 6. A path that stops reaching anything

### Evidence

Route metrics are how preference is expressed, and they behave as R-NET-06 needs. Measured
on the board: Ethernet `100`, cellular `700`, the access point's `wlan0` `600` with a link
route and no default of its own.

Removing Ethernet's default route moved everything to cellular immediately — public address
`68.216.66.63`, three pings of three at 94 ms — and `nmcli device reapply eth0` restored it.
Setting `ipv4.route-metric` on the cellular connection and reactivating it reordered the two
defaults in both directions.

So the case the milestone is named for already works: **with Ethernet and Wi-Fi gone,
cellular is the only default route and takes over with nothing to decide.**

The case that does not work is the one in between. A cable plugged into something with no
route out keeps its carrier, keeps its metric of 100, and wins — while a working cellular
link sits at 700 doing nothing. It is §2's failure again, one layer up: every indicator
healthy, nothing working.

### Decision

**A path that stops reaching anything is stood down, and traffic moves to the next one that
works.** This was decided deliberately, against the alternative of reporting the condition
and leaving the operator to act, and the reasoning for the alternative is recorded here
because it is the cost being accepted: an aircraft that changes how it is reachable while
nobody is watching, on the strength of a test that can itself be wrong.

Four constraints make that cost bearable, and none of them is optional:

- **Configuration decides preference; health decides only participation.** `network.priority`
  remains the sole statement of what outranks what, and `config.yaml` remains the single
  writer of configuration, which everything about rollback rests on. Health can take a path
  out of the running and put it back. It can never reorder them.
- **It costs nothing while things work.** The path in use is judged by its byte counters.
  Only when the path in use stops receiving does Yonder test — that path first, then the
  alternatives.
- **Slow to move, quick to return.** A carrier hiccup must not move an aircraft. Some number
  of consecutive failures demotes and a smaller number of successes restores, and **those
  numbers are measured against a real cellular dropout on hardware, not chosen at a desk.**
  The plan carries that as a task with an outcome, not as a constant.
- **Every change is a sentence in the log** naming what stopped working, what traffic moved
  to, and when.

Rule 4 was checked. This is Yonder managing its own network, not originating a command to
an aircraft; the access-point fallback (R-NET-07) already performs automatic network
recovery, and this is the same kind of act one step further. It is not a control loop over
anything the autopilot owns.

### The hole this closes in R-NET-07

R-NET-07 says the access point comes up if no configured network **carries traffic**.
`FallbackWatchdog.check()` implements that as "some interface other than the access point
holds an IPv4 address", and says so in its own comment: a connected but idle Ethernet link
carries no traffic and is perfectly reachable, so byte counters looked like the wrong test.

§2 breaks that reasoning. A cellular link with a wrong APN holds an address, satisfies the
check, and reaches nothing. A device configured that way from the boot partition, with no
other path, never raises its access point and is unreachable until somebody pulls the card.
That is rule 6, and cellular is what opens it, because it is the first path that can be
configured wrong before first boot with nothing to fall back on.

The requirement was right and the implementation compromised for a reason that no longer
holds — the same signal that drives §2 and this section distinguishes *idle* from *dead*.
**The watchdog is moved onto it.** Recorded as K-40; no requirement changes.

---

## 7. Requirements

Rule 3: these are added to `docs/requirements.md` in the same change that implements them.
The R-CEL block currently ends at R-CEL-08 and R-NET at R-NET-12.

| ID | Requirement | P |
|---|---|---|
| R-CEL-09 | **A cellular link that reports itself connected is shown to be carrying traffic, or shown not to be.** Registration, signal, an assigned address and an installed route can all be correct while no packet completes, and the difference can be a single character in the APN — so the interface states which of the two is true rather than reporting the indicators and leaving the operator to conclude. The link is tested with real traffic when it comes up and on request; between those it is judged by the interface's own byte counters, which cost nothing on a metered link. Nothing is tested on a schedule. **No APN is ever suggested, completed or tried on the operator's behalf**: the published database's first answer for the SIM this was measured on was the value that failed, and the value that worked was absent from it | 1 |
| R-CEL-10 | **Signal is reported in full, and Yonder turns it on.** Where a modem exposes detailed measurements behind a setting, Yonder applies that setting when the link comes up rather than reporting only what is available by default — a coarse quality percentage is not a substitute and is not shown. The measurements are published as live values on the same interface as all other device state, so that a later instrument consumes them without a second collection path. Reading them must not consume the operator's data | 2 |
| R-CEL-11 | **A modem that does not present itself for automatic detection is named in configuration, and the interface says what such a modem cannot tell it.** Automatic detection covers modems the system's modem service claims. A modem that appears only as a network adapter is indistinguishable from an ordinary one, so it is identified by the operator rather than by a list of device identifiers written from documentation. For such a modem the absence of signal, operator and radio technology is shown as a property of that kind of modem, not as data that failed to arrive | 2 |
| R-NET-13 | **A path that stops reaching anything is stood down, and traffic moves to the next path that works.** Configuration states preference and remains the only writer of it; reachability decides only whether a path participates, never its order. A path in use is judged by its own byte counters, and active testing happens only once a path in use stops receiving — a device that is working spends nothing on finding that out. Demotion requires repeated failure and restoration requires less, so that a momentary loss does not move an aircraft, and **the thresholds are established by measurement against a real link loss rather than chosen in advance**. Every change of path is recorded as a log entry naming what failed, what traffic moved to, and when | 2 |

**No new ADR.** ADR-0006 settles the control surface and its reasoning extends to
ModemManager unchanged; the reasoning for §3 and §6 belongs in requirement text, as
R-CFG-10 and R-CFG-11 already do for decisions of that kind.

**R-CEL-04 is not implemented in M3** and is not withdrawn. It is correct and unbuilt.

**One known issue is added.** K-40: the fallback watchdog accepts an interface that holds
an address as proof of reachability, which a misconfigured cellular link satisfies while
reaching nothing (§6).

---

## 8. Where it goes in the console

Three places, and only one of them is new.

**A `Cellular` tab**, in the strip M2a builds — `Interfaces · Wi-Fi · ZeroTier · Cellular ·
Activity` — named for the thing it configures, as the ZeroTier tab is. It carries the
connection status and whether traffic is getting through, the four signal numbers with
RSRP and SINR given bars, operator, network, registration and addresses, and the connection
form: APN, dial number, username and password, and a `Test now` control. The dial number is present
because R-CEL-02 requires it and absent from the path this modem uses — `gsm.number` was
empty and the bearer needed no dial step. It applies only to a serial connection.

**A `Way out` panel on the `Interfaces` tab**, listing every path in configured order with
its state and a sentence saying why it is in that state. It belongs there rather than on
the Cellular tab because it is about all three paths, and Interfaces is the tab that
already covers all three.

**A `Reachable by` panel on the Status page**, under `This board`, in that page's existing
idiom: the same meter-and-value-box as CPU load and the same divided strip of small
labelled values. One word for how the aircraft is reachable now, and a line for what
changed and when. Status uses plain words — `SIGNAL`, `QUALITY` — where the Cellular tab
uses RSRP and SINR. Same values; a glance and a detail view.

### The state words

Five, and they map onto the four registers `console/command.ts` already defines
(R-UI-05, ADR-0005). No new visual vocabulary:

| Word | Register | Meaning |
|---|---|---|
| `IN USE` | good | Traffic is leaving by this path |
| `TESTING` | waiting | This path stopped receiving and is being tested now |
| `STANDING BY` | neutral | Works, but something above it in the order is in use |
| `NO ROUTE OUT` | bad | Stood down — reached nothing when tested |
| `ACCESS POINT` | neutral | The radio is serving the access point |

`ACCESS POINT` replaces what would otherwise be `OFF` for Wi-Fi on a single-radio board.
`OFF` is wrong twice: the radio is on, and it is doing the one job that keeps the device
reachable. The sentence beneath it — that one radio cannot also join a network — puts
M1b-2's arbitration (R-NET-12) somewhere an operator reads it before it costs them their
console, rather than only at the moment it does.

`TESTING` is a moment, not a condition, and its sentence says so: what triggered it (a stall
in received traffic, not a guess) and that a test is running now.

### What R-UI-12 requires of this

The Cellular tab is captured in both palettes like every other tab. **The `Way out` panel is
captured in more than one state**, and that is not a formality. Building these screens
surfaced a defect visible in exactly one data shape: the interface name right-aligned inside
its own column, because `.nrdb-ui-text-value` carries `text-align: right` and the name had
been given that class — which showed only when the qualifier beneath it was the wider line.
One capture in one state would have passed.

### One panel the layout corrected

The `Interfaces` panel's value column mixed an address, a prose phrase and a compound of
both. The rule is now that **the value column holds an address and nothing else**: anything
else becomes a quiet qualifier under the interface name, an interface with no address shows
a dash in the muted tone rather than a sentence dressed as a value, and the column reads as
a column. `Hostname` left the list — it is not an interface and holds no address — and sits
below the divider as `NAME`, which is also where mesh addresses will want to go.

---

## 9. Shape of the code

```
packages/yonder-core/src/net/
├── modem/
│   ├── mmcli/          # client + parser, fixtures captured from the board
│   ├── state.ts        # one state for the console to render
│   ├── signal.ts       # arming, and the four values
│   └── renderer.ts     # the gsm connection, or the named adapter
└── reach/
    ├── probe.ts        # counters, and the active test
    └── standing.ts     # what participates, and the hysteresis
```

`packages/node-red-contrib-yonder-modem/` becomes real — it is currently a `.gitkeep` — and
holds thin adapters over the daemon's socket, with the instruments in
`node-red-dashboard-2-yonder` and `flows/flows.json` as wiring only, per rule 2.

`reach/` is deliberately not inside `modem/`. It is about every path, the watchdog depends
on it (§6), and a module that decides which way an aircraft is reachable should not live
under the name of one of the options.

Fixtures come from this board and are captures, not inventions — ADR-0006's consequences
section is explicit about the cost of the alternative, and two of its four Wi-Fi fixtures
are still hand-written for want of doing this.

## 10. Split

**M3a — the link.** Configuration drives the modem; no console. Testable by editing
`config.yaml` and the daemon's socket, as M1a was.

**M3b — the console.** The Cellular tab, the `Way out` panel, the `Reachable by` panel.

**R-NET-06 moves out of M3.** The roadmap places egress preference here because cellular is
the first second path. The mechanism is measured and works, but implementing it touches the
Ethernet and Wi-Fi renderers that are already merged and whose cold boot M1a still owes. It
is its own change with its own test, not a passenger inside cellular.

---

## Evidence

Board: Raspberry Pi 4, Debian GNU/Linux 13 (trixie), aarch64.
`NetworkManager 1.52.1`, `ModemManager 1.24.0-1+deb13u1`, `libqmi 1.36.0`,
`mobile-broadband-provider-info 20250613-2`.
Modem: Quectel EC25-AF, USB `2c7c:0125`, firmware `EC25AFFAR07A08M4G`, MBIM composition
(`AT+QCFG: "usbnet",2`), ports `cdc-wdm0 (mbim) · ttyUSB1 (gps) · ttyUSB2/3 (at) · wwan0 (net)`.
SIM: IMSI `310280…`, operator `310410` "Dark Star", APN `ereseller`.
Bearer: `ipv4v6`, MTU 1430, reported 50 Mbit up / 100 Mbit down.
Date: 2026-09-02.
