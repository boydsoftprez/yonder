# Verifying M1a on real hardware

M1a — the access point, the Wi-Fi client and Ethernet profiles, the apply/rollback engine
used for real, and the access-point fallback — is built and unit-tested. Every one of those
tests runs against a fake `nmcli`: an injected command runner that returns whatever string
the test hands it. This procedure is what runs the same code against a real one.

Nothing below can be replaced by a better unit test. It requires a Raspberry Pi, a real
NetworkManager, a real Wi-Fi radio, a second device to observe from, and a real reboot.

## What a board has already told us

<!-- yonder:hardware-observed -->

A first boot has happened. It did not get as far as Step 2 — the service could not start at
all — but it captured `nmcli` output and it exposed two defects that no unit test had. A
later boot, with those fixed, got the service running and exposed a third: the radio itself
is shipped disabled. All three are fixed; what the board actually printed is recorded here,
and the fixtures in `packages/yonder-core/src/net/nmcli/` are those captures rather than
hand-written guesses.

| Field | Observed |
|---|---|
| Board | Raspberry Pi 4, aarch64, 905 MB usable RAM |
| OS | Raspberry Pi OS Lite, Debian 13 (trixie) |
| Kernel | `6.18.34` |
| NetworkManager / `nmcli` | 1.52.1, the version Debian 13 ships |
| Radio at daemon start | `wlan0`, present and `unavailable` |
| Radio out of the box | Soft-blocked by the kernel *and* disabled in NetworkManager's state file — see Defect 3 |
| Date | 2026-09-01 |

**`network-manager`, `dnsmasq-base` and `ca-certificates` are already present on Raspberry
Pi OS Lite.** `ensure_pkgs` reported all three as such. `10-base.sh` also asks for `curl`,
which this boot did not record either way — so "the base role needs no network on this
image" is true of three packages out of four and not yet of the role. That does not make the
explicit `dnsmasq-base` line redundant — an
installer that only works because the image happened to carry a package is an installer that
breaks on the next image — but it does mean the base role is not where an offline install
gets stuck.

### What `device status` printed

```
lo:loopback:connected (externally):lo
eth0:ethernet:unavailable:
wlan0:wifi:unavailable:
```

Two shapes here that the hand-written fixture did not have, and both matter:

- **A state containing a space and parentheses.** `connected (externally)` is one field, not
  two. `parseTerse` walks the line character by character and splits only on unescaped
  colons, so it was already right — but nothing had ever asked it, and any reader written to
  split on whitespace, or to match a bare word, would have lost the record.
- **Devices in state `unavailable`.** NetworkManager registers a device before it can act on
  it. This is a cold boot caught in the act, and it is the state behind Defect 2 below.

### What `device show` printed

```
GENERAL.DEVICE:lo
IP4.ADDRESS[1]:127.0.0.1/8

GENERAL.DEVICE:eth0

GENERAL.DEVICE:wlan0

```

This settles the one question `parseDeviceShow` was written blind against. **A device
holding no address emits no `IP4.ADDRESS` line at all** — not `--`, not `(none)`, not an
empty value. It occupies a single `GENERAL.DEVICE` line, and a blank line separates each
device's block. The field-stream shape the parser assumed is correct, and the indexed
spelling `IP4.ADDRESS[1]` is what this version emits.

The placeholder handling in `parseDeviceShow` stays regardless. One board on one
NetworkManager version does not speak for the versions this has still never run against, and
the cost of keeping it is a string comparison while the cost of being wrong is a device that
believes it is reachable when it is not.

Read the way `FallbackWatchdog.check()` reads it, that capture is a board with nothing
reachable but loopback — so its access point must come up.

### The defects a real board exposed

**1. The service could not find Node.**

```
yonder-core.service: Unable to locate executable '/usr/bin/node': No such file or directory
yonder-core.service: Failed at step EXEC spawning /usr/bin/node
yonder-core.service: Main process exited, code=exited, status=203/EXEC
yonder-core.service: Scheduled restart job, restart counter is at 3.
```

The install itself was perfect: bundled Node installed, prebuilt tree used, config seeded,
service enabled. But the unit hardcoded `/usr/bin/node`, which is true only on the route that
installs the distro package — the offline route unpacks its runtime to `$YONDER_PREFIX/node`
and puts it on `PATH` for the installer's own run, and systemd inherits none of that.
`ExecStart` is an absolute path systemd resolves against nothing.

Fixed by giving systemd one fixed path: the installer's `link_node` creates
`/usr/local/bin/yonder-node` pointing at whichever Node it resolved, and the unit names that.
`assert_unit_exec` is the post-condition that would have caught it before the board booted —
after the unit is installed, the binary its `ExecStart` names must be the one the installer
prepared, and must be executable.

**2. A slow radio meant no access point, and no way to recover one.**

The capture above is the daemon's own starting conditions: `wlan0` present and `unavailable`.
`startServer()` rendered once and never looked again, and the start-up render is the only
thing that writes the `yonder-ap` profile. `nmcli connection up yonder-ap` fails on a radio
that is not ready — and fails with `unknown connection` if the render found no wifi interface
at all — while raising that same profile is the fallback watchdog's *only* action. So a board
whose radio was a few seconds behind came up unreachable, which is the exact failure R-NET-07
exists to prevent.

Fixed by `NetworkRenderer.waitForRadio()`: a bounded, `Clock`-driven wait for a usable Wi-Fi
device, run in the background *after* the socket binds, followed by one more render if the
radio appeared. The fallback's deadline is unchanged; its action waits on that bounded wait
so it cannot fire at a profile no render has written yet.

**3. The Wi-Fi radio ships disabled, behind two independent locks.**

A later boot, with the service running, still raised no access point. The radio was off, and
off twice over:

```
$ rfkill list
1: phy0: Wireless LAN
        Soft blocked: yes

$ nmcli radio all
WIFI-HW   WIFI
enabled   disabled

$ journalctl -u NetworkManager
manager: rfkill: Wi-Fi enabled by radio killswitch; disabled by state file
```

The kernel's rfkill soft block is one lock. NetworkManager's own `WirelessEnabled` property
— persisted in its state file, and entirely separate from rfkill — is the other; that
journal line is NetworkManager saying so in as many words. Clearing either alone leaves
`wlan0` in state `unavailable`, which looks exactly like Defect 2 and is nothing like it: a
block does not clear on its own, so the bounded wait expires and the board still has no
access point. Running both by hand moved `wlan0` from `unavailable` to `disconnected`, and
everything worked.

A freshly flashed Raspberry Pi therefore never reached a joinable state on its own, which is
R-CFG-08 broken on the boot the requirement is written about.

Fixed in the network renderer, before it reads the device list: `enableWifiRadio` issues
`rfkill unblock wifi` and then `nmcli radio wifi on`, neither of which can fail a render —
`rfkill` is a separate binary that some boards do not carry, and a board with no radio at
all is legitimate. It runs on every render rather than once at install, because a block is
persistent state a board can acquire at any time, and it is gated on the configuration
wanting a radio at all so that an operator who has turned Wi-Fi off is not overruled
(`radioWanted`, R-NET-08).

**4. The configured DHCP pool was never in force.**

With the radio up and the access point on the air, a client joined and was handed
`192.168.77.154` — inside the subnet, and nowhere near the `192.168.77.2`–`.50` the
configuration asked for. The reason was on the dnsmasq command line NetworkManager had
built:

```
/usr/sbin/dnsmasq … --dhcp-range=192.168.77.10,192.168.77.254,3600 \
                    --conf-dir=/etc/NetworkManager/dnsmasq-shared.d
```

The drop-in Yonder wrote into that conf-dir *was* being read. It simply lost: a range on
the command line takes precedence over one in a conf-dir file. So `network.ap.dhcp` decided
nothing while looking as though it decided the pool, which is worse than not offering the
key at all.

Removed, rather than documented as inert. What remains true is what R-NET-02 now says:
clients get addresses inside the access point's own subnet, because NetworkManager derives
that range from the access point's address. K-15 records what a configurable pool would
cost — a dnsmasq of our own to run and supervise, not a drop-in.

## Still to confirm on a board

**`nmcli connection modify` has still never been executed.** The first boot never reached a
render, so the one remaining piece of grammar written from the documentation is still
unproven, and it is load-bearing.

| What to confirm | Command | Why it matters |
|---|---|---|
| That `connection modify` rejects add-only options | `nmcli connection modify yonder-ap type wifi` | `type` and `ifname` belong to `connection add`. If `modify` accepted them the code would be over-cautious; if it rejects them, as expected, every render after the first would have failed had they still been sent. |
| That an empty value resets a property rather than storing one | `nmcli connection modify yonder-modem gsm.apn ""` then `nmcli -t -f gsm.apn connection show yonder-modem` | This is how a setting an operator has cleared is removed from the device rather than left dialling (R-CFG-13). If the property comes back empty, the mechanism is right. If it comes back as a literal empty string the bearer then tries to use, the profile has to be recreated instead. Written from the documentation; no nmcli has run it. |
| What `connection show` prints in its TYPE column | `nmcli -t -f NAME,UUID,TYPE,DEVICE connection show` | `addOrModify` compares that column against the type it is about to write, and replaces the profile when they differ — which is the only way to change a `yonder-modem` from `gsm` to ethernet. The map from nmcli's two spellings (`wifi` in, `802-11-wireless` out) is written from the documentation, and a spelling not in it is deliberately read as "cannot tell" so the access point is never dropped on a guess. |

**M1b-2 added three things that are unproven on hardware and cheap to check while a board is
on the bench.** Each is written as an assumption in the code that makes it, and each has a
comment saying so:

| What to confirm | Command | Why it matters |
|---|---|---|
| That `<hostname>.local` resolves from the device an operator is holding | Join the same network as the board, then `ping yonder.local` from a laptop and from a phone | The console tells an operator to look there after joining a network. A printed instruction that does not work costs them the time to discover it is wrong, which is why the page currently says the name *may* work and gives the router's client list as the answer that always does. If it resolves reliably, that hedge can go. |
| What a scan returns while the radio is serving the access point | `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes` with `yonder-ap` up | This is the ordinary case for `GET /net/scan` on a single-radio board — the operator is scanning over the access point they are connected through. Whether NetworkManager scans in AP mode, returns a stale cache, or refuses is unobserved (K-13). |
| That the access point comes back after a failed join | Enter a deliberately wrong Wi-Fi password from the console | Three things should produce this, in order: the renderer raising the access point when the client will not come up, the confirmation window expiring, and the fallback watchdog. Only the first is unit-tested against a fake nmcli. |

**The `/proc` and `/sys` fixtures in `packages/yonder-core/src/system/fixtures/` are
constructed, not captured.** They are built to each file's documented format and to the board
recorded above — a Pi 4 with 905 MB — because the machine M1b-2 was written on is not Linux
and has no `/proc` at all. That is the opposite of the `nmcli` fixtures beside them, and the
distinction is the whole value of the convention: a constructed fixture proves the parser
handles the shape someone believed the file has. Replacing them with a real
`cat /proc/meminfo`, `cat /proc/loadavg`, `cat /proc/uptime`,
`cat /sys/class/thermal/thermal_zone0/temp` and `cat /proc/device-tree/model | xxd | tail -1`
from a board is a five-minute job and is worth doing on the same bench visit.

**If a real board disagrees, the code is wrong and the fixture is right.** Fix the parser or
the argv, replace the fixture with what the board actually printed, and say so in the Results
section. Do not reshape a capture to fit what is written here.

## What this verifies, and why it can't be verified any other way

| Requirement | What the fake `nmcli` could never tell you |
|---|---|
| R-NET-01, R-SEC-01 — access point with the published setup passphrase | A fake `nmcli` always reports success. It cannot tell you whether a real phone can complete a real WPA2 handshake against `yonder1234`. |
| R-NET-02 — DHCP for access-point clients | A fake `nmcli` cannot hand a real device a real lease. Nothing before this procedure has ever offered an IP address to anything. |
| R-NET-03, R-NET-04 — Wi-Fi client and Ethernet | The renderer has only ever been told "the command exited 0." It has never watched a real radio fail to associate, or a real cable fail to carry a DHCP offer. |
| R-CFG-03 — apply behind a confirmation timer, revert if unconfirmed | Every existing test drives the confirmation timer with a fake clock that jumps straight to "120 seconds later" (see `advance(ms)` in `packages/yonder-core/src/net/watchdog.test.ts` and the equivalent in `apply/engine.test.ts`). This is the first time the timer runs against the real one, for a real two minutes, while a real `nmcli` is told to build and tear down real connections. |
| R-NET-07 — access-point fallback | The fallback watchdog has only ever been asked "if you called `activeIpv4()` right now, what would you say?" against a canned string. It has never been asked that by a process that just rebooted, on hardware whose radio may or may not have finished initializing yet. This is the requirement M1a exists to satisfy, and Step 6 below is the whole point of this document. |

There is no web console yet — that's M1b. Everything here talks to `yonder-core` directly,
either through `nmcli` or through its Unix-socket HTTP API.

### Reference: paths, environment variables, and timers

The daemon (`packages/yonder-core/src/daemon/server.ts`) reads exactly four environment
variables, all in its `main()` function. Nothing else is configurable from the environment,
and the shipped `systemd/yonder-core.service` sets none of them — so a board running the
installed service always uses the right-hand column below.

| Variable | Default | What it is |
|---|---|---|
| `YONDER_SOCKET` | `/run/yonder/core.sock` | The Unix socket the HTTP API listens on |
| `YONDER_CONFIG` | `/etc/yonder/config.yaml` | The single source of truth for device state |
| `YONDER_JOURNAL` | `/var/lib/yonder/apply.json` | The pending-apply record `recover()` reads at startup |
| `YONDER_SECRETS` | `/etc/yonder/secrets.yaml` | The device's secrets, mode `0600`. Seeded with `ap_psk` only |

Three different timers matter below and it's easy to conflate them:

| Timer | Length | Where it comes from | Configurable? |
|---|---|---|---|
| Apply confirmation window | 120 s | `ApplyEngine`'s own hard-coded default (`timeoutMs` in `apply/engine.ts`) | No environment variable reaches it. Only code that constructs `ApplyEngine` directly (the test suite) can override it. |
| Render timeout, per renderer | 60 s | Same file, `renderTimeoutMs` | `ServerOptions.renderTimeoutMs` exists, but `main()` never sets it from the environment, so the shipped daemon always uses 60 s. |
| Access-point fallback | 90 s, measured from the moment the daemon process starts | `network.ap.fallback.timeout` in `config.yaml` (schema range 30–600 s) | Yes — it's a config value, not a build constant. |

## Prerequisites

- A Raspberry Pi running Raspberry Pi OS with NetworkManager as the network backend (the
  current default), and a Wi-Fi radio — built in or attached.
- Node.js 20 or newer, by one of two routes.
  `installer/roles/20-yonder-core.sh` calls a `require_node 20` check and deliberately
  aborts rather than build against anything older — `yonder-core` is ESM with NodeNext
  resolution and declares `engines.node >= 20` in its `package.json`. Raspberry Pi OS
  Bookworm's own `nodejs` package is major version 18, so `sudo ./installer/install.sh`
  stopping with `error: node 18 is too old; yonder-core needs node 20 or newer` is a real,
  expected outcome on a stock image, not a broken installer. Either put a Node.js 20+
  runtime on `PATH` before running the installer, or vendor one at `vendor/node` and let
  `install_bundled_node` unpack it — which is what an offline payload does.

  Whichever route runs, the installer then creates **`/usr/local/bin/yonder-node`** pointing
  at the Node it resolved, and that fixed path is what `systemd/yonder-core.service` names.
  A unit's `ExecStart` is an absolute path systemd resolves against nothing — not against
  `PATH`, and certainly not against the `PATH` the installer set for its own run — which is
  how a perfect offline install produced a service that crash-looped on `203/EXEC`. If
  `systemctl status yonder-core` reports `Unable to locate executable`, check that symlink
  first.
- A second device with a Wi-Fi radio (laptop or phone) to join the access point from, and
  to run `ping`/scan/SSH against the board.
- Root on the board. The installer requires it, and the daemon runs as root with no
  `User=`/`Group=` in its unit (filed as known issue K-01 in `docs/known-issues.md`), so the
  socket ends up owned `root:root` mode `0660` — every `curl` against it needs `sudo` too.
- Physical access to the board (keyboard + HDMI, or a serial console), **or** a network path
  to it that is independent of the interfaces this procedure reconfigures.

> **This procedure will repeatedly and deliberately disrupt networking on the board.** Steps
> 5 and 6 exist specifically to break reachability and then prove it comes back. Do not run
> this over the only link you have to the board unless you can also reach it physically, or
> over an interface this procedure isn't touching. If your only path in right now is the
> board's own access point or its Wi-Fi client link, expect to be disconnected more than
> once, and make sure you have another way back in before Step 5.

## Step 1 — Capture real `nmcli` fixtures

On the board (replace `wlan0` if your radio has a different interface name), run each of
these individually:

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
```

```bash
nmcli -t -f NAME,UUID,TYPE,DEVICE connection show
```

```bash
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes
```

```bash
nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show
```

These four calls are the entire real interface between `yonder-core` and NetworkManager —
see `NmcliClient` in `packages/yonder-core/src/net/nmcli/client.ts`, which issues exactly
these four commands (`devices()`, `connections()`, `scan()`, `activeIpv4()`) and nowhere
else. Each has a fixture file, all four parsed in
`packages/yonder-core/src/net/nmcli/parse.ts`:

| Command | Fixture file | Parser | Where it came from |
|---|---|---|---|
| `device status` | `fixtures/device-status.txt` | `parseTerse`, 4 fields | **Captured from a board** |
| `connection show` | `fixtures/connection-list.txt` | `parseTerse`, 4 fields | Hand-written |
| `device wifi list` | `fixtures/wifi-scan.txt` | `parseTerse`, 3 fields | Hand-written |
| `device show` (`IP4.ADDRESS`) | `fixtures/device-show-ip4.txt` | `parseDeviceShow`, a field stream | **Captured from a board** |

(Paths are relative to `packages/yonder-core/src/net/nmcli/`.)

Two of the four are now real captures — see *What a board has already told us* at the top of
this document for what they printed and what it settled. The other two are still guesses,
because the boot that produced the captures never got as far as creating a connection or
scanning for one. **Replace them, and re-capture the first two on your own board too:** a
second NetworkManager version disagreeing with the first is exactly the kind of finding this
step exists for.

`device show` is still the one to look at hardest. It is the call the fallback watchdog in
Step 6 depends on, so a misreading of it is a device that never raises its access point, or
one that raises it on every boot forever. Four things to check against `parseDeviceShow`,
with what the captured board did:

- Field names are **section-qualified**: `GENERAL.DEVICE`, not the bare `DEVICE` that
  belongs to `device status`. If your `nmcli` rejects the field list outright, that is the
  finding. (Accepted, on 1.52.)
- Output is a **stream** of `FIELD:value` lines — one line per property, per device — not
  one record per device. A device with no address should occupy one line; a device with two
  addresses, three. (Confirmed, with a blank line between each device's block.)
- Addresses appear as `IP4.ADDRESS[1]` (indexed) or `IP4.ADDRESS`. Record which. (Indexed.)
- What a device holding **no** address actually prints for `IP4.ADDRESS`, if anything at
  all — an omitted line, an empty value (`IP4.ADDRESS[1]:`), or a placeholder such as `--`
  or `(none)`. **On the captured board: nothing at all.** No line is emitted. If your
  version emits one, that is a finding worth recording — `parseDeviceShow` treats any value
  that does not itself look like an IPv4 address as "no address" precisely so a placeholder
  cannot be misread as one, and that handling is deliberately kept for versions nobody has
  run it against.

Replace all four fixture files with what you captured. Redact real SSIDs and connection
UUIDs if you want to — a UUID or an SSID string doesn't need to be genuine — but **preserve
the exact escaping and field structure**: `nmcli -t` escapes a literal colon or backslash
inside a value with a backslash, and both parsers walk the string character by character to
undo exactly that (see the comments in `parse.ts`). A redacted SSID like `Guest\:Wifi` has to
keep its backslash; collapsing it to `Guest:Wifi` changes the field count `parseTerse` sees.

**If your board's output disagrees with either parser — a different field count, a different
field name, a different shape — the parser is wrong, never the fixture.** Fix
`packages/yonder-core/src/net/nmcli/parse.ts` (and its tests in `parse.test.ts`) to handle
what your NetworkManager version actually emits. Do not truncate, reshape, or hand-edit the
captured output to make it fit the parser as it stands today — the entire point of this step
is to find out where a real `nmcli` disagrees with what the parser assumed.

Once the fixtures are in place, from the repository root:

```bash
npm test
```

Confirm it's still green before moving on — `parse.test.ts` reads all four fixture files
directly and asserts on their shape (see `packages/yonder-core/src/net/nmcli/parse.test.ts`).

### And confirm what `connection modify` will not accept

This one needs a connection to exist, so run it after Step 2 and come back here to record
the answer. `NmcliClient.addOrModify` creates a connection with `nmcli connection add
con-name … type … ifname … setting.property value …`, and updates one with
`nmcli connection modify … connection.interface-name … setting.property value …`. The
difference is deliberate: `type` and `ifname` are `connection add` common options, and a
connection's type cannot be changed at all.

```bash
sudo nmcli connection modify yonder-ap type wifi
```

**Expect this to fail.** Record the exact error. A success here would mean `modify` is more
permissive than the manual says, which is worth knowing but changes nothing — the code does
not send it either way.

```bash
sudo nmcli connection modify yonder-ap connection.interface-name wlan0
```

Expect this to succeed silently (substitute your radio's interface name). This is the form
the renderer actually sends on every render after the first, so a failure here is a real
defect in `addOrModify` — fix `packages/yonder-core/src/net/nmcli/client.ts`.

## Step 2 — Install, and watch the access point come up

```bash
sudo ./installer/install.sh
```

This runs every role under `installer/roles/` in order: `10-base.sh` installs
`ca-certificates`, `curl`, `network-manager` and `dnsmasq-base` — the last explicitly,
because NetworkManager only *Recommends* it and this installer passes
`--no-install-recommends`, and without it `ipv4.method shared` has no DHCP server to run —
and creates `/etc/yonder` (mode `0750`), `/var/lib/yonder` and `/opt/yonder`;
`20-yonder-core.sh` resolves a Node, links it at `/usr/local/bin/yonder-node`, installs or
copies in `yonder-core` at `/opt/yonder/packages/yonder-core`, checks that its entry point
and everything it imports actually load, copies `systemd/yonder-core.service` into place,
checks that the binary the unit's `ExecStart` names is actually executable, seeds
`/etc/yonder/config.yaml`, and runs `systemctl daemon-reload`, `enable` and `restart`.

Nothing creates `/etc/NetworkManager/dnsmasq-shared.d`. It arrives with the
`network-manager` package, and Yonder no longer writes into it at all — the DHCP drop-in
that needed it decided nothing and has been removed (K-15).

On Raspberry Pi OS Lite the role asks for four packages and expects to install few of them.
Boot 1 recorded `network-manager`, `dnsmasq-base` and `ca-certificates` as already present —
`packages already present: …` rather than an `apt-get` line. `curl` was not recorded either
way, so **do not assume this role needs no network until a boot says so for all four.**

**The installer leaves the service running and the device configured.** There is nothing to
write by hand: `config/defaults/config.yaml` — generated from `DEFAULT_CONFIG` and identical
to the reference configuration in `docs/configuration.md` — is copied into place when, and
only when, no configuration exists. Re-running the installer on a board you have configured
leaves your file exactly as it is. The daemon seeds the same content itself if it ever
starts against a missing configuration, so a hand-installed board is covered too.

```bash
sudo systemctl status yonder-core
```

Expect `Active: active (running)`.

```bash
sudo cat /etc/yonder/config.yaml
```

Expect the shipped default: access point `yonder` enabled on `192.168.77.1/24`, no client
SSID, fallback enabled at 90 s.

```bash
sudo journalctl -u yonder-core -n 50 --no-pager
```

Expect this line, and expect it on every boot until you change the passphrase:

```
access point: using the published default passphrase; change it from the console
```

**The access point's WPA2 passphrase is `yonder1234`** — published, documented, the same on
every device, and never presented as a secret. It is
`DEFAULT_AP_PASSPHRASE` in `packages/yonder-core/src/net/profiles.ts`, and it is seeded into
`secrets.yaml` only when `ap_psk` is absent, so a passphrase you have changed is kept.
[ADR-0007](../adr/0007-credential-boundary.md) is why: a random per-device value could only
be read from this journal, and getting to this journal means already being on the device.

Nothing prints a secret. `editor_password` is **not** seeded at all — it does not exist
until an operator sets an administrator password from the console, which is M1b. The
shipped configuration says the same thing: `ui.editor.password` is `null`, not a reference
to a secret no device has.

```bash
sudo cat /etc/yonder/secrets.yaml
```

Expect exactly one entry, `ap_psk: yonder1234`.

```bash
sudo ls -l /run/yonder/core.sock
```

Expect a line beginning `srw-rw----` owned by `root root`.

> **The access point should already be on the air.** `startServer()` renders the
> configuration once at startup — after `engine.recover()` and before the socket binds — so
> a board nobody has ever posted an apply to still brings up its access point. That is
> R-CFG-08, and it is the whole point of a device you can reach without having configured
> it first. Expect the renderer's own lines in the journal immediately after the service
> starts:
>
> ```
> network: wifi=wlan0 ethernet=eth0
> network: bringing the access point up
> ```
>
> (exact interface names depend on your board; a missing radio prints `none` for that
> slot). **Confirm the SSID `yonder` is visible from your second device now, before going
> any further.** If it is not, stop here — nothing later in this document will work, and
> the failure is the one that matters most.
>
> A render failure at startup is logged and does not stop the socket binding, the same as a
> failed recovery. If the journal shows
> `could not render the current configuration, serving anyway: …`, the API is still up and
> Step 3 will still answer — record what it said.
>
> **On a cold boot the radio may not be ready in time for that first render**, and the
> daemon says so rather than giving up. If the journal shows
>
> ```
> network: no usable wifi radio yet (wlan0=unavailable); waiting for NetworkManager
> network: wifi radio is usable now (wlan0=disconnected)
> network: a wifi radio became usable; rendering again
> ```
>
> that is the bounded wait doing its job: the socket bound first, the radio arrived a few
> seconds later, and the access point went up on the second render. **This is the normal
> shape of a cold boot on a real board** — the capture at the top of this document is
> exactly that moment. Record how long it took; the wait gives up after 30 s with
> `network: no usable wifi radio after 30 s (…); carrying on without one`, and a board that
> reaches *that* line with a radio fitted is a finding.
>
> If you then wait 90 seconds: the fallback watchdog fires, finds only the access point's
> own address, and tries to raise the access point again. `FallbackWatchdog.check()`
> deliberately ignores the access-point subnet — "reachable" means some *other* interface
> holds an address — so on a board with nothing but its own access point up, this is
> expected and harmless:
> ```
> fallback: nothing reachable, bringing the access point up
> ```
> The connection already exists this time, so `nmcli connection up` on an already-active
> profile is what actually runs. Record whatever your NetworkManager says to that; this
> document has not run it.

## Step 3 — Talk to the daemon over the socket

`yonder-core` exposes exactly four routes over the Unix socket
(`packages/yonder-core/src/daemon/routes.ts`) — no others exist, and there is no TCP port
anywhere in M1a to reach it by IP.

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/config
```

Expect the seeded default configuration, as one line of compact JSON:

```
{"version":1,"network":{"ap":{"enabled":true,"ssid":"yonder","psk":{"secret":"ap_psk"},"address":"192.168.77.1/24","fallback":{"enabled":true,"timeout":90}},"client":{"ssid":null,"psk":null},"ethernet":{"dhcp":true},"priority":["ethernet","modem","wifi_client"]},"ui":{"port":3000,"theme":"day","editor":{"enabled":true,"password":null,"interfaces":["ethernet","wifi_client"]}},"system":{"hostname":"yonder","timezone":"UTC"}}
```

(Pipe any of these commands through `python3 -m json.tool` if you'd rather read it
formatted — Raspberry Pi OS ships Python 3 by default.)

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
```

Expect exactly:

```
{"state":"idle"}
```

`GET /status` returns an object with `state`, and `id`/`expiresAt`/`lastResult` only when
they apply — `JSON.stringify` drops `undefined` fields entirely rather than printing `null`,
which is why "idle" prints as a bare one-key object. `POST /apply` and `POST /confirm` are
exercised for real in the next three steps. Anything else — a typo'd path, the wrong method
— gets a plain 404:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -o /dev/null -w '%{http_code}\n' http://localhost/nope
```

Expect `404`.

## Step 4 — Apply a configuration and confirm it

`POST /apply` takes a complete configuration (not a patch), validates it, writes it to
`/etc/yonder/config.yaml`, renders it through NetworkManager, and — only if the render
succeeds — starts the 120-second confirmation window described above. It returns the applied
change's `id` and the epoch-millisecond `expiresAt` you have until it reverts on its own.

The body below is identical to the seeded default except `system.hostname`, which the
network renderer never reads — a safe way to prove the whole pipeline end-to-end. The access
point and the Ethernet profile already exist by now: the startup render in Step 2 created
them. **What this step proves is the apply path itself** — validate, write,
render, start the confirmation window — over a device that is already up and reachable.

```bash
cat > ~/yonder-apply-1.json <<'EOF'
{
  "version": 1,
  "network": {
    "ap": {
      "enabled": true,
      "ssid": "yonder",
      "psk": { "secret": "ap_psk" },
      "address": "192.168.77.1/24",
      "fallback": { "enabled": true, "timeout": 90 }
    },
    "client": { "ssid": null, "psk": null },
    "ethernet": { "dhcp": true },
    "priority": ["ethernet", "modem", "wifi_client"]
  },
  "ui": {
    "port": 3000,
    "theme": "day",
    "editor": {
      "enabled": true,
      "password": null,
      "interfaces": ["ethernet", "wifi_client"]
    }
  },
  "system": { "hostname": "yonder-verified", "timezone": "UTC" }
}
EOF
```

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-1.json http://localhost/apply
```

Expect a 200 response shaped like `{"id":"<a uuid>","expiresAt":<a number>}`. **Record the
`id` — you have 120 seconds, real time, to confirm it.**

```bash
sudo journalctl -u yonder-core -n 20 --no-pager
```

Expect the network renderer's own log lines again, for example:

```
network: wifi=wlan0 ethernet=eth0
```

`bringing the access point up` will **not** repeat: `render()` only calls `nmcli connection
up` when the access point's active state actually has to flip, and the startup render in
Step 2 already brought it up. Seeing only the interface line here is correct.

Now, from your second device, **within the two-minute window**:

- Scan for Wi-Fi networks and confirm the configured SSID (`yonder`, unless you changed it)
  is visible. It should already have been, since Step 2 — this re-checks it survived the
  apply.
- Join it with the published passphrase **`yonder1234`**.
- Confirm you were handed an address inside `192.168.77.0/24` — the access point's own
  subnet, which is what R-NET-02 promises and all it promises. The range within that subnet
  is NetworkManager's to choose and is not configurable (K-15); a real board handed a client
  `192.168.77.154`. Check your device's network details panel, or `ip addr` / `ipconfig`.
  **Joining but never being given an address is the signature of a missing
  `dnsmasq-base`**; check `dpkg -l dnsmasq-base` before looking anywhere else.
- From that same second device, confirm you can reach the board at its configured address:

  ```bash
  ping -c 4 192.168.77.1
  ```

  Expect 0% packet loss. (There is no web console to open here yet — M1a has no TCP
  listener at all — so a successful ping, and SSH if you have it enabled, is the
  reachability evidence.)
- Optionally, if SSH is enabled on the board:

  ```bash
  ssh <your-username>@192.168.77.1
  ```

Still inside the window, confirm the change. This can run from the board's own console or
from the SSH session you just opened over the access point — both reach the same socket:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d '{"id":"PASTE-THE-ID-FROM-THE-APPLY-RESPONSE"}' http://localhost/confirm
```

Expect:

```
{"state":"confirmed","id":"<the same uuid>","lastResult":{"id":"<the same uuid>","outcome":"confirmed","at":<a number>}}
```

If you miss the window, that's not a failure — it's a live demonstration of Step 5 happening
by accident. `GET /status` will show `"state":"idle"` with `"lastResult":{"outcome":"reverted",...}`;
re-apply and move faster before continuing.

## Step 5 — Prove the rollback

This is the test that matters: not that an apply can succeed, but that an apply the operator
never confirms reverts on its own.

The change has to actually render — reach `pending` — rather than being rejected outright,
or there's no confirmation window to watch expire. A deliberately wrong Wi-Fi client
password does exactly that: `nmcli` will happily create a connection profile with any
pre-shared key, because it has no way to know the key is wrong until something tries to
associate with it. Because `network.client.ssid` is currently `null`, setting it now creates
a brand-new connection rather than changing one that's already active, which matters — see
the note at the end of this step.

`yonder-core` reads a configured password from `/etc/yonder/secrets.yaml` by name, and
refuses to apply a config that names a secret it can't find, so add one first:

```bash
sudo tee -a /etc/yonder/secrets.yaml > /dev/null <<'EOF'
verify_wrong_psk: this-is-not-the-real-password
EOF
```

```bash
sudo chmod 600 /etc/yonder/secrets.yaml
```

```bash
stat -c %a /etc/yonder/secrets.yaml
```

Expect `600` — confirm your editor or `tee` didn't widen it.

Now apply a config identical to Step 4's except `network.client`:

```bash
cat > ~/yonder-apply-2.json <<'EOF'
{
  "version": 1,
  "network": {
    "ap": {
      "enabled": true,
      "ssid": "yonder",
      "psk": { "secret": "ap_psk" },
      "address": "192.168.77.1/24",
      "fallback": { "enabled": true, "timeout": 90 }
    },
    "client": { "ssid": "verification-test", "psk": { "secret": "verify_wrong_psk" } },
    "ethernet": { "dhcp": true },
    "priority": ["ethernet", "modem", "wifi_client"]
  },
  "ui": {
    "port": 3000,
    "theme": "day",
    "editor": {
      "enabled": true,
      "password": null,
      "interfaces": ["ethernet", "wifi_client"]
    }
  },
  "system": { "hostname": "yonder-verified", "timezone": "UTC" }
}
EOF
```

```bash
sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-2.json http://localhost/apply
```

Expect the same `{"id":...,"expiresAt":...}` shape as Step 4 — this confirms the render
itself succeeded.

**Do not confirm this one.** Instead:

```bash
sudo journalctl -u yonder-core -f
```

Watch it. Within 120 seconds of the apply, expect the network renderer to run again,
unprompted, tearing back down what it just built:

```
network: wifi=wlan0 ethernet=eth0
network: removing yonder-wifi
```

(`yonder-wifi` is `CLIENT_CONNECTION` from `packages/yonder-core/src/net/profiles.ts`; it
disappears because the configuration being reverted to has no client SSID at all.)

Confirm the outcome explicitly:

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
```

Expect `"state":"idle"` with `"lastResult":{"id":"<the same id as the apply>","outcome":"reverted","at":<a number>}`.
Note there is no `state` value called `"reverted"` — the state returns to `idle`; it's the
`outcome` inside `lastResult` that records what happened.

```bash
sudo cat /etc/yonder/config.yaml
```

Expect `client: { ssid: null, psk: null }` again.

> **On the alternative in the task brief:** breaking reachability with an access-point
> address on an unreachable subnet, instead of a bad client password, is the other option
> named in `task-9-brief.md`. Read `NetworkRenderer.render()` in
> `packages/yonder-core/src/net/renderer.ts` before choosing it: the renderer only calls
> `nmcli connection up`/`down` on the access point when its active/enabled state actually
> flips (`apActive` is computed once, from `nmcli device status`, at the top of `render()`).
> If the access point is already up and stays enabled across the change — which it will be,
> after Step 4 — an address-only change goes through as `nmcli connection modify` alone,
> with nothing here telling NetworkManager to reactivate the connection on the new address.
> Whether that leaves the live access point quietly running on its old, working address is a
> real-NetworkManager question the unit tests never exercise — they only assert which
> `nmcli` subcommand was called, never what NetworkManager then does with it. Worth noting in
> the results section either way, but it means this alternative may not produce an
> observable break at all. The Wi-Fi-client-password path above doesn't have that ambiguity,
> because it's always a fresh `nmcli connection add`.

## Step 6 — Prove the fallback (R-NET-07)

> R-NET-07: *"If no configured network carries traffic within 90 seconds of `yonder-core`
> starting, bring up the access point regardless of configuration. Disabling this requires an explicitly named
> configuration key."* This is the requirement the M1a milestone exists to satisfy. It's
> implemented in `FallbackWatchdog` (`packages/yonder-core/src/net/watchdog.ts`).

The watchdog's timer is armed exactly once, at daemon start, and it is never re-armed by a
later apply or confirm — recorded as **K-11** in
[`docs/known-issues.md`](../known-issues.md). The only way to re-arm it is to start the
daemon again, which is exactly what a reboot does. That's why, alone among the steps in this
document, this one needs one.

> **Confirm this apply before you reboot — this is the step most likely to silently fail.**
> `ApplyEngine.recover()` runs at every startup and reverts any apply still sitting
> unconfirmed in its journal, whether the restart was a crash or a deliberate reboot — it's
> the same guarantee R-CFG-03 asks for. Reboot before confirming and the board comes back on
> the *previous*, good configuration: access point enabled, no phantom client SSID. The
> fallback watchdog will have nothing to do, there is no error message anywhere to explain
> why, and from the outside a `reverted` you see afterward is indistinguishable between "the
> fallback watchdog worked" and "you forgot to confirm and recovery quietly undid your setup."
> Do not skip the confirm.

1. Apply a configuration with a client SSID that doesn't exist near the board, and the
   access point disabled. You may also lower `fallback.timeout` toward the schema's 30-second
   minimum here to shorten the wait — the number is a policy default, not part of the
   mechanism under test, so testing at 30 s still exercises the same code as 90 s:

   ```bash
   cat > ~/yonder-apply-3.json <<'EOF'
   {
     "version": 1,
     "network": {
       "ap": {
         "enabled": false,
         "ssid": "yonder",
         "psk": { "secret": "ap_psk" },
         "address": "192.168.77.1/24",
         "fallback": { "enabled": true, "timeout": 90 }
       },
       "client": { "ssid": "this-network-does-not-exist", "psk": null },
       "ethernet": { "dhcp": true },
       "priority": ["ethernet", "modem", "wifi_client"]
     },
     "ui": {
       "port": 3000,
       "theme": "day",
       "editor": {
         "enabled": true,
         "password": null,
         "interfaces": ["ethernet", "wifi_client"]
       }
     },
     "system": { "hostname": "yonder-verified", "timezone": "UTC" }
   }
   EOF
   ```

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s -X POST -H 'Content-Type: application/json' -d @/home/$USER/yonder-apply-3.json http://localhost/apply
   ```

2. **Confirm it** (same as Step 4 — POST the `id` you were just given to `/confirm`), and
   verify:

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
   ```

   Expect `"state":"confirmed"`.

3. Unplug Ethernet, or otherwise make sure it isn't carrying traffic. `FallbackWatchdog.check()`
   treats any interface other than loopback and the access point's own subnet as proof the
   board is reachable (see `watchdog.ts`) — Ethernet included. A live Ethernet link makes the
   watchdog correctly decide not to raise the access point, which would look like a failed
   test but is in fact R-NET-07 working exactly as specified.

4. Reboot:

   ```bash
   sudo reboot
   ```

5. Reconnect (physically, or once the fallback access point appears — not before), and tail
   the journal as soon as you're back:

   ```bash
   sudo journalctl -u yonder-core -f
   ```

   Expect, in order:
   - `access point: using the published default passphrase; …` again, unless you changed the
     passphrase. It is printed on every boot while the default is still in force, not once.
   - No `seeded a default configuration …` line — `/etc/yonder/config.yaml` already exists.
   - The startup render's `network: wifi=… ethernet=…` line. **The configuration under test
     here has `ap.enabled: false`, so the startup render will not raise the access point** —
     it renders the configuration as written, which is exactly what makes the rest of this
     step a real test of the fallback rather than of the render.
   - `fallback: will check for a reachable interface in 90 s` (or however many seconds you
     configured) shortly after the service starts. **A second or two less is correct, not a
     bug**: the deadline is measured from when the process started, so whatever recovery and
     the start-up render have already spent comes out of the window rather than delaying it.
     Record the number you see — on a board where the start-up render stalls, it should be
     visibly smaller.
   - Nothing network-related for the rest of that window.
   - At the end of the window: `fallback: nothing reachable, bringing the access point up`.

6. From your second device: scan, confirm the SSID is visible again — it's the same SSID and
   passphrase as before, since neither was touched by this step — join it, and confirm you're
   back on the `192.168.77.0/24` network.

7. Worth confirming directly, for the results section below:

   ```bash
   sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/config
   ```

   This should still show the nonexistent client SSID and `"enabled":false` for the access
   point. The fallback watchdog calls `client.up(AP_CONNECTION)` — straight through to
   `nmcli` — and never touches `ApplyEngine` or `config.yaml` at all. The file on disk still
   says the access point should be off; NetworkManager is simply being told otherwise, this
   once. That's the access point as "a floor, not a mode," exactly as `docs/architecture.md`
   puts it, and it's worth confirming with your own eyes that the file and the running state
   can legitimately disagree here.

## Results

### Boot 1 — 2026-09-01

The first boot. It stopped at Step 2 and never reached a render, so most of this document is
still unrun — but what it did reach was decisive, and the two defects it found are fixed.

| Field | Value |
|---|---|
| Board model | Raspberry Pi 4, aarch64, 905 MB usable RAM |
| `cat /etc/os-release` | Raspberry Pi OS Lite, Debian 13 (trixie) |
| `uname -r` | `6.18.34` |
| `nmcli -v` | Not recorded on this boot. Debian 13 ships NetworkManager 1.52 — capture the exact string next time |
| `NetworkManager --version` | As above |
| Wi-Fi adapter / driver | Built in, `wlan0`; driver not recorded |
| Date tested | 2026-09-01 |

| Step | Pass / fail | Notes |
|---|---|---|
| 1 — Real fixtures captured, `npm test` green | **Pass, partial** | `device status` and `device show` captured and committed; `connection show` and `device wifi list` not reached. `npm test` green against the captures |
| 1 — `nmcli connection modify yonder-ap type wifi` rejected, `connection.interface-name` accepted | Not run | Needs a connection to exist, which needs a render, which needs the service to start |
| 2 — Install alone leaves the service running, the config seeded and the access point on the air | **Fail → fixed** | The install itself was perfect. The service could not start: `ExecStart=/usr/bin/node` did not exist on a board whose Node came from the bundled runtime. `203/EXEC`, restarting for ever. See *The two defects that boot exposed* |
| 3 — All four routes answer as documented | Not run | No daemon |
| 4 — Apply, join over Wi-Fi, DHCP in pool, ping reaches the board, confirm | Not run | No daemon |
| 5 — Unconfirmed apply reverts within the window | Not run | No daemon |
| 6 — Fallback brings the access point up after reboot | Not run, **and a defect found by inspection of the capture** | `wlan0` was `unavailable` at the moment the daemon would have rendered. The start-up render writes the `yonder-ap` profile the fallback raises, and it rendered once and never looked again — so on this board the fallback would have had nothing to raise. Fixed; see Defect 2 |

Both fixes are gated by tests that fail without them, and by an installer post-condition that
fails when `ExecStart` names a missing binary. **Neither has yet run on a boot.** What
happened instead — this board carried forward by hand, fix by fix, without a re-flash — is
written out under *What has actually run on hardware* below, and it does not replace this.
**Boot 2 is what makes this document true**; start again at Step 1 and record it as a new
Results section here.

What behaved differently from the unit tests (there is almost certainly something — this
document flags a few candidates worth checking specifically):

- Did any captured record have a field count `parseTerse` didn't expect? *(Boot 1: no, but a
  state came back as `connected (externally)` — one field containing a space and
  parentheses, which the hand-written fixtures had no example of.)*
- Did `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` emit the field stream
  `parseDeviceShow` assumes — `GENERAL.DEVICE` lines, `IP4.ADDRESS[n]` lines — or something
  else? *(Boot 1: yes, exactly that, with a blank line between each device's block. An
  address-less device emits no `IP4.ADDRESS` line at all.)*
- Did the access-point-address alternative in Step 5's closing note actually fail to break
  reachability, as the code reading there predicted? *(Not reached.)*
- Any `nmcli`/NetworkManager version-specific quirks worth recording for the next board?
  *(Boot 1: devices sit in `unavailable` for a while after boot. That is not a quirk, it is
  the normal shape of a cold boot, and reading it as "no radio" was a real defect — see
  Defect 2.)*
- Did the daemon start at all? *(Boot 1: no. Ask this first — a `203/EXEC` restart loop looks
  from a distance exactly like a board that booted and did nothing.)*

---

Once a new Results section is filled in, the remaining fixtures in
`packages/yonder-core/src/net/nmcli/fixtures/` are real captures rather than hand-written
ones, and `docs/known-issues.md` is updated if the board revealed anything new, commit with:

```bash
git add packages/yonder-core/src/net/nmcli/fixtures docs/hardware/verifying-m1a.md docs/known-issues.md
git commit -s -m "test(net): fixtures and verification from real hardware

Fixtures are now output captured from a board rather than written by hand.
Records the on-board procedure: apply, confirm, roll back an unconfirmed
change, and prove the access-point fallback brings a device back when
nothing else is reachable.

R-NET-07"
```

A capture that disagrees with a parser is the finding, not a problem with the board. Fix the
code and replace the fixture; never reshape a capture to fit what is written here.


---

## What has actually run on hardware — 2026-09-01

Raspberry Pi 4 Model B Rev 1.5 · Debian GNU/Linux 13 (trixie) · kernel 6.18.34+rpt-rpi-v8
aarch64 · 905 MB · NetworkManager 1.52.1 · installed entirely offline from a card.

**One board, flashed once, and carried forward by hand from there.** Every result below
came from that single card. It was not re-flashed after any of the five fixes, and the
sequence matters more than the results do, so it is written out rather than summarised.

1. **Cold flash, boot 1.** The offline install ran end to end: bundled Node installed,
   prebuilt tree copied, `/etc/yonder/config.yaml` seeded, the unit installed and enabled.
   The service then crash-looped — `ExecStart=/usr/bin/node`, a path the bundled runtime
   does not use — `203/EXEC`, restarting for ever. **No access point.** This is the whole of
   what a cold flash has ever been observed to do.
2. **The radio-wait fix was written from boot 1's capture, not from a boot.** `wlan0` was
   `unavailable` in the `device status` taken at the moment the daemon would have rendered,
   and the consequence was read off the code. No boot has yet exercised it.
3. **A later run on the same board**: the service ran, and there was still no access point.
   The radio was blocked.
4. **The radio was unblocked by hand** — `rfkill unblock wifi` then `nmcli radio wifi on`.
   Only then did the access point come up: `wlan0:wifi:connected:yonder-ap`,
   `192.168.77.1/24`, `iw dev wlan0: ssid yonder, type AP, channel 6`, DHCP serving, and
   the socket answering `{"state":"idle"}`.
5. **The rollback test passed** on that hand-patched board: an apply left unconfirmed
   returned the configuration to its previous value, `lastResult.outcome = "reverted"`, and
   the access point never dropped.
6. **The fallback test passed** on that same board — access point disabled *and confirmed*,
   Ethernet disconnected, and the daemon **restarted with `systemctl restart`, not
   rebooted**. 90 s later: `fallback: nothing reachable, bringing the access point up` →
   `yonder-ap` active. It came up despite the configuration saying it was disabled.
7. **The DHCP finding** came from a client joining that already-running board.
8. **The retired-key defect** was found by upgrading that same board in place, past the
   removal, with its old `config.yaml` still on it.
9. **The radio fix was verified by blocking the radio by hand and restarting the service** —
   not by a cold flash.

### What that proves, and what it does not

| | |
|---|---|
| **The offline install mechanism works from a cold card** | Proven, on boot 1: bundled Node, prebuilt tree, seeded configuration, unit enabled — all of it, offline |
| **Rollback of an unconfirmed apply** | Proven, on a running, hand-patched board |
| **The fallback raises the access point when nothing is reachable** | Proven, on a running, hand-patched board, across a service restart |
| **The radio unblock clears both locks** | Proven, on a running board with the radio blocked by hand |
| **The retired-key strip loads an older configuration** | Proven, by an in-place upgrade of that board |
| **A cold flash to a joinable access point with no intervention** | **Not proven.** The only cold flash there has ever been ended in a crash loop. Every result above sits on a board that a human had already reached |
| **Any of it across a real reboot** | **Not proven.** The fallback was exercised with `systemctl restart`. Nothing here has survived the kernel coming up again |

So the exit criteria are not met by this run. The mechanisms behind them have each been seen
to work; the boot they are supposed to work *on* has not happened since the first one, and
the first one failed. **Boot 2 — a fresh flash of a card built from this branch, powered on
and left alone — is still what makes this document true.** It is the one test none of the
above substitutes for, because every fix listed here was applied to a board that was already
running, and a fix that works when applied by hand to a live system is not yet a fix that
works when a board is switched on.

### What the hardware found that the test suite could not

Five defects, all fixed and gated. How each was found is part of the finding, so it is said
here rather than left to be assumed:

1. The unit hardcoded a Node path the bundled runtime did not use — the service crash-looped.
   *Found by the cold boot, which is the only thing that could have found it.*
2. On a cold boot the radio is not ready when the daemon starts; the render found no radio,
   never retried, and the fallback had no access-point profile to raise. *Found by reading
   boot 1's `device status` capture — `wlan0:wifi:unavailable:` at the moment the daemon
   would have rendered — and following it through the code. Not found by a boot, and the fix
   has not yet met one.*
3. **Raspberry Pi OS ships the Wi-Fi radio disabled behind two independent locks** — kernel
   rfkill *and* NetworkManager's own persistent flag (`rfkill: Wi-Fi enabled by radio
   killswitch; disabled by state file`). Both must be cleared or no Pi ever raises an
   access point. *Found by a running board with no access point, and confirmed by clearing
   both locks by hand and watching one appear. The fix was verified by re-blocking the radio
   and restarting the service, not by a flash.*
4. The configurable DHCP pool decided nothing: NetworkManager's shared mode passes its own
   `--dhcp-range` on the dnsmasq command line, which wins over any drop-in. A client was
   handed `.154` while the file asked for `.2`–`.50`. The setting was removed. *Found by a
   real client joining that running board.*
5. **Removing that setting stranded the board that already had it.** Strict validation
   rejected the whole file, so the network never came up. On an aircraft with no cable that
   device would have needed a card reader. Retired keys are now dropped with a clear log
   line rather than rejecting the document. *Found by upgrading that same board in place,
   which is the only place a configuration written by an earlier version existed.*

None of these could have been found by the suite as it stood: every fake command runner
reported a radio present, unblocked and enabled, and every configuration under test had been
written by the current version. That is no longer the shape of the suite — it now carries
`COLD_BOOT` and `NO_RADIO_YET` device lists, a runner that refuses an activation on a radio
that is not ready, and a fixture configuration written by an earlier version — but those
harnesses exist *because* of this board, so they are not evidence that the next defect of
this kind would be caught either.

### Notes for anyone repeating this

- `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` emits a `FIELD:value` stream, blank-line
  separated, with indexed forms such as `IP4.ADDRESS[1]`. A device holding no address emits
  **no** address line at all — not `--`, not `(none)`.
- `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` can report a state containing a
  space and parentheses: `connected (externally)`.
- `network-manager`, `dnsmasq-base` and `ca-certificates` are already present on Raspberry Pi
  OS Lite, so the installer needs no network for them.
- Raspberry Pi OS configures cloud-init from the boot partition, and the NoCloud instance id
  comes from `cmdline.txt` (`ds=nocloud;i=…`), **not** from `meta-data`. Editing `meta-data`
  alone will not make first-boot steps run again.
