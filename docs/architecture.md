# Yonder architecture

Status: **pre-alpha implementation** · Overview updated: 2026-09-10

Yonder is a Linux companion-computer stack alongside an ArduPilot flight
controller. It carries telemetry, video and explicit operator commands over
Ethernet, Wi-Fi and configured cellular/mesh links. The console runs on the
board; optional remote access and external geographic data depend on their
network services. Coverage and capacity bound remote operation.

For the current operator workflow, start with [Getting started](getting-started.md),
[the user guide](user-guide.md), and [tested hardware](hardware.md). This document
explains the engineering boundaries; it is not an installation checklist.

This document explains what runs, why, and where the boundaries are. What it must do is
in [`requirements.md`](requirements.md).

---

## 1. Principles

These are load-bearing. Where a design choice below looks odd, it is usually one of these
being enforced.

1. **Offline-first, always.** No component may require a network call to a server we
   operate to boot, serve the local console, or unlock an installed feature.
   Optional online imagery, traffic, remote mesh connectivity and public tests
   retain their explicit network dependencies.
2. **The autopilot flies the aircraft.** Yonder is a radio, a camera and a web page. It
   relays commands an operator asked for — mode changes, parameter writes, payload
   outputs — and never originates one. If Yonder stops, the aircraft carries on under the
   autopilot's own logic. That property is never traded away for a feature.
3. **Recoverable configuration.** Risky changes use the rollback engine and
   access-point fallback to preserve reachability. This is not a guarantee
   against failed power, storage, an unmanaged radio, or a broken base OS.
4. **Reviewable by strangers.** Every behaviour lives in source a contributor can read,
   diff and test. Generated blobs are build outputs, never the source of truth.
5. **One installer.** The installer defines the application installation.
   Future Yonder disk images use that same procedure; no ready-to-flash image
   is currently published.
6. **Requirements first.** Every behaviour traces to a numbered requirement, so scope is
   arguable in the open rather than assumed.

---

## 2. What runs on the device

The installed system combines Yonder services with OS and media processes.
Optional components run according to configuration and the attached hardware.

| Process / service | Role | License | Yonder integration |
| --- | --- | --- | --- |
| **yonder-core** | Typed network/configuration, telemetry, mission, camera and diagnostic services; private Unix-socket API | GPL-3.0-or-later | Our implementation |
| **Node-RED + FlowFuse Dashboard** | Authenticated console, wiring and thin adapters; Vue instruments render in the browser | Apache-2.0 | Custom packages and generated configuration |
| **mavlink-router** | Owns the flight-controller serial link and fans MAVLink out to configured endpoints and the private local reader | Apache-2.0 | Generated configuration |
| **MediaMTX** | Configured browser/ground-station media endpoints | MIT | Generated configuration and private observer API |
| **GStreamer / pipeline host** | Per-camera capture, encoding, retuning, recording and stills | Component licenses | Composed pipelines and our control host |
| **NetworkManager + ModemManager** | Interfaces, Wi-Fi AP and cellular | GPL-2.0 family | OS packages controlled through their native tools |
| **ZeroTier** | Configured optional mesh connectivity | Upstream package license | Pinned package and lifecycle integration |
| **Camera-specific helpers** | Pocket 2 accessory transport or prepared Radxa sensor/ISP services | Component licenses | Used only for the relevant camera path |

Application logic lives in reviewable packages. Node-RED flows connect services
and presentation; they do not contain an independent copy of flight, network or
camera decision logic. The autopilot owns flight execution.

Two absences are deliberate:

- **No separate WebRTC gateway.** mediamtx does WebRTC *and* RTSP *and* SRT in a single
  MIT-licensed Go binary. A dedicated gateway would mean a second server for the other
  protocols, and would not give us SRT.
- **No hostapd.** NetworkManager's own AP mode covers everything we need.

### 2.1 Why Node-RED is the core

Decided in [ADR-0001](adr/0001-node-red-as-core.md). Briefly: it is the proven shape for
this product, it is one thing to install and debug, and its node ecosystem is genuinely
valuable to the audience.

Node-RED is sometimes associated with products that fetch their interface at boot. That
is a consequence of coupling the UI to a licence check — if the UI is the flows and the
licence check is in the flows, shipping the UI ships the bypass. Yonder has no licence
check, so the flows ship on the card, work offline, and live in git where they can be
reviewed.

### 2.2 The rule that makes it reviewable

**Logic lives in custom nodes. Never in function nodes.**

A `function` node is JavaScript typed into a box and serialised into `flows.json` along
with every wire and every pixel coordinate. A pull request against it is unreadable, and
therefore unmergeable. A repo that cannot take pull requests is not an open-source
project.

So:

- Every behaviour ships as `node-red-contrib-yonder-*`, an ordinary npm package with
  source files, unit tests and a version number.
- The shipped flows are **wiring only** — nodes and connections, no embedded code.
- `functionExternalModules` is off and the `function` node type is not enabled in the
  shipped profile. An operator who wants it opts in explicitly.

This also keeps a future migration open: if one service ever needs to leave the Node-RED
process for fault isolation, a clean node package can be lifted out and run standalone.
Logic buried in function nodes could never be.

---

## 3. Data flows

### 3.1 MAVLink

```
Flight controller (ArduPilot)
   │  UART @ 57600/115200/230400/921600  or  USB CDC-ACM
   ▼
mavlink-router
   ├── UDP  → ground station 0        (default :14550)
   ├── UDP  → ground station 1        (default :14551)
   ├── UDP  → ground station 2        (default :14552)
   ├── TCP  server                    (default :5760)
   └── UDP  → 127.0.0.1:14559         → yonder-core
```

**Raw MAVLink never passes through Node-RED on its way to a ground station.**
mavlink-router fans it out directly. If Node-RED restarts, Mission Planner does not
notice. The control plane is a *consumer* of a loopback copy, plus a producer of commands.

**The router is its own systemd unit, and it ships installed and off.** `mavlink-router` is
not in Debian, so it is built for the board's architecture and carried in the offline
payload; the role that installs it leaves the unit stopped and disabled. `yonder-core` starts
it, and only once detection has found a port and a speed and generated
`/etc/mavlink-router/main.conf` — because the router opens the serial port and keeps it, and
detection needs the same port. A unit enabled at install would win that race at every boot.
Once running, its lifetime is systemd's: a router that dies is restarted by
`Restart=on-failure`, never by the control plane, which is the other half of the sentence
above (R-MAV-17).

The end of that loopback copy is a socket in `yonder-core`, not in Node-RED: the daemon
reads the heartbeats and Node-RED asks it what they said, over the same Unix socket every
other reading arrives on. **That socket binds `127.0.0.1` and nothing else, and there is no
setting that can move it** — MAVLink is bidirectional and carries no credential, so the
address it is bound to is the whole of what keeps it off the network.

Flight-controller detection sweeps the baud rates above in order — these are the rates
ArduPilot is actually configured for in the field — and reports the port and baud it
settled on.

MAVLink ingest binds **loopback only** unless an operator explicitly opts in, and the
opt-in is logged. An open UDP server on a routable address is an unauthenticated command
path to the vehicle.

### 3.2 Video

One pipeline per camera, with a `tee`. This is the important departure.

```
Camera (CSI / USB / HDMI-via-TC358743)
   │
   ▼
GStreamer: capture → convert → encode (board-specific encoder)
   │
   ├── tee branch A → RTP/UDP → ground station :5604      (Mission Planner / QGC)
   │
   └── tee branch B → mediamtx
                         ├── WebRTC  → browser preview (the Cockpit)
                         ├── RTSP    → :8554/<camera>   (QGC, VLC)
                         └── SRT     → lossy-link transport with recovery
```

A single-destination design forces a choice between watching in the browser and feeding
your ground station. A `tee` costs almost nothing — measured at two points of one core —
and removes the *encoding* trade-off: **you get the browser preview and the ground-station
feed at the same time.** It does not remove the bandwidth one: each consumer that leaves
over cellular costs its own bitrate, which is why the browser is served a separate, cheaper
copy by default (R-VID-13) and why every output is reported against the uplink's capacity
(R-VID-11).

Encoder selection is per board, probed when the daemon looks (R-CAM-13) and reported on the
camera page; nothing about it is written to configuration — R-CAM-06 was withdrawn for
exactly that:

| Board | H.264 | H.265 |
|---|---|---|
| Pi Zero 2 W, Pi 3, Pi 4, CM3, CM4 | V4L2 M2M hardware | — |
| Pi 5, CM5 | **software** (`x264enc`) | — |
| Radxa (rk35xx) | MPP hardware (`mpph264enc`) | MPP hardware (`mpph265enc`) |

The Pi 5 dropped the hardware H.264 encoder its predecessors had. It works, in software,
and it runs hotter and slower than a Pi 4 doing the same job.

### 3.3 Control and state

```
Browser ──HTTP/WS──► Node-RED ──► custom nodes ──┬──► mavlink-router  (config + reload)
                                                  ├──► mediamtx       (HTTP control API)
                                                  ├──► GStreamer      (spawn / supervise)
                                                  ├──► NetworkManager (D-Bus)
                                                  ├──► ModemManager   (mmcli)
                                                  └──► libgpiod       (relays)
```

Components talk to system services over their real interfaces — an HTTP API for mediamtx,
D-Bus where it is the right fit — rather than shelling out and parsing text by default. The
network layer is a deliberate, recorded exception: the renderer drives NetworkManager
through `nmcli`'s machine-readable mode behind an injected command runner, and the modem is
read the same way, with `mmcli --output-keyvalue` behind that same runner, for the reasons
in [ADR-0006](adr/0006-nmcli-not-dbus.md). Those reasons were written about NetworkManager
and carry over to ModemManager unchanged.

### 3.4 Remote access

```
Operator ──► mesh VPN ──► aircraft behind carrier CGNAT
                │
yonder-core ────┼──► zerotier-cli   (join / leave / status, injected runner)
                └──► /sys/class/net/<iface>/statistics  (throughput)
```

A mobile carrier puts the aircraft behind CGNAT, so nothing can reach it by address. A mesh
VPN is how the operator gets in; ZeroTier is the one implemented first, because a network ID
is a value that fits in a configuration file and a login is not
([ADR-0004](adr/0004-zerotier-primary-mesh-vpn.md)).

Three things about it are load-bearing and are easy to get wrong:

**Joined is not authorised.** A device joins in about four seconds and then waits for a
person to approve it in a controller — a minute, or a week. That is neither a failure nor a
success, so it is a state of its own, and nothing times out of it (R-VPN-06).

**A join is kept, not held.** It goes through the ordinary apply path but skips the
confirmation window, because a join only ever *adds* a path and cannot take away the one the
operator is using — measured on a board, where a controller pushing a route that overlapped
the board's own network was refused by the client itself. R-CFG-12 says a change that cannot
cost reachability is kept; `affectsReachability` exempts `remote.zerotier` by name, and
nothing else. A second mesh earns its own exemption with its own evidence or does not get
one (R-VPN-07).

**Installed does not mean running.** A client with no network joined still holds live
sessions with its vendor's root servers, so the installer leaves it stopped and disabled and
`yonder-core` starts it only when a network is configured (R-VPN-08). A device carries no
connection to anyone's infrastructure until it is asked for one.

**And "connected" is a measurement, not a membership.** A client reports a network as
configured long after it can reach anything, because that configuration is cached; an
interface reading that field alone tells an operator their aircraft is reachable when it is
not. So the word is backed by what the device measured — a live path, whether it is direct
or relayed, its latency, when it was last heard from, and the traffic crossing it (R-VPN-10,
R-NET-10).

The reasoning behind each, with the board transcripts it was decided on, is in
[the design note](superpowers/specs/2026-09-02-remote-access-design.md).

---

## 4. Configuration

### 4.1 One declarative file

`/etc/yonder/config.yaml` is the single source of truth for device state. Everything
else — `mavlink-router` config, NetworkManager keyfiles, mediamtx config, GStreamer
pipeline parameters — is **generated** from it.

```yaml
version: 1
vehicle:
  autopilot: ardupilot
mavlink:
  serial: { device: auto, baud: auto }
  endpoints:
    - { name: gcs0, host: 192.168.2.10, port: 14550 }
  tcp_server: { enabled: true, port: 5760 }
  autocast: true
cameras:
  - id: cam0
    source: { type: csi }
    encoder: auto
    bitrate: { mode: adaptive, min: 500k, target: 2M, max: 6M }
    outputs:
      - { type: rtp,  host: 192.168.2.10, port: 5604 }
      - { type: webrtc }
      - { type: rtsp, path: /cam0 }
network:
  ap:     { ssid: yonder, psk: { secret: ap_psk }, address: 192.168.77.1/24 }
  client: { ssid: null, psk: { secret: wifi_psk } }
  modem:  { enabled: false, mode: auto, apn: null, password: { secret: modem_password } }
  priority: [ethernet, modem, wifi_client]
```

Two properties matter more than the schema:

- **A human can write it.** Headless setup means dropping this file on the boot partition.
  No imaging wizard, no cloud, no dialog.
- **Nothing is authoritative except this file.** If you edit a NetworkManager keyfile by
  hand, the next apply overwrites it. That is intentional — a single writer is what makes
  rollback possible.

### 4.2 Rollback, and why the device cannot brick

The failure this exists to prevent: a wrong Wi-Fi SSID typed at flash time leaves a device
that never joins a network, with no way back in short of a card reader.

Our apply cycle:

1. Validate the new config against the schema. Reject and keep running on failure.
2. Snapshot the current config as `last-known-good`.
3. Apply, and start a **confirmation timer** (default 120 s).
4. If the operator's session reaches the device again, the change is confirmed.
5. If the timer expires unconfirmed, **revert to last-known-good and reboot**.

And independently of all that, a boot-time guarantee:

> **If no configured network is carrying traffic within 90 seconds of `yonder-core`
> starting, the access point comes up regardless of configuration.**

The AP is a floor, not a mode. There is always a way in. The fallback is on by default,
and disabling it requires a config key whose name says what it does.

The window is measured from the moment the daemon process starts — the unit orders itself
after `NetworkManager`, so that is a little after kernel boot — and whatever start-up work
happens before the watchdog is armed comes out of the 90 seconds rather than being added to
them. That matters because two of those steps, the rollback of an unconfirmed change and the
start-up render, can each spend up to the per-renderer timeout inside a wedged renderer. The
deadline is a deadline, not a delay after an unbounded prologue.

And a third way to brick a device, which neither of those two covers: **the configuration
was written by an older Yonder.** The schema is strict, so a release that removes a setting
rejects every `config.yaml` still carrying it — and the guarantees above do not help.
Rollback has nothing to roll back to: the file being refused is the one already in force,
and no apply put it there. The access-point floor does not stand on its own either — its
only action is to raise the `yonder-ap` profile, and that profile is written by a render
that cannot run, because rendering needs the configuration that would not load. A board did
exactly this: no access point, and the only way to it was an Ethernet cable that happened to
be plugged in.

So a removed key is **retired, not merely deleted**. The removals are enumerated in
`src/schema/retired.ts`; a document is stripped of them before validation, each drop is
logged naming the key, and the operator's file is left alone until something saves it. Every
key that was never a Yonder setting is still refused, with the offending path named, because
a misspelling silently ignored is a setting an operator believes is in force and is not
(R-CFG-09). Retiring a key is deliberate: one line in that file, one row in the table in
[`configuration.md`](configuration.md), both gated by tests.

---

## 5. Repository layout

```
yonder/
├── LICENSE                     GPL-3.0
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── docs/
│   ├── requirements.md         what Yonder must do, numbered
│   ├── architecture.md         this file
│   ├── roadmap.md
│   ├── configuration.md        config.yaml reference
│   ├── getting-started.md
│   ├── hardware/               per-board notes and wiring
│   └── adr/                    architecture decision records
├── packages/                   the Node-RED nodes — where logic lives
│   ├── yonder-core/            config model, schema, apply/rollback engine
│   ├── node-red-contrib-yonder-mavlink/
│   ├── node-red-contrib-yonder-video/
│   ├── node-red-contrib-yonder-network/
│   ├── node-red-contrib-yonder-modem/
│   ├── node-red-contrib-yonder-system/
│   └── node-red-contrib-yonder-gpio/
├── flows/                      shipped dashboard flows — wiring only
├── config/
│   ├── schema/                 JSON Schema for config.yaml
│   └── defaults/
├── installer/
│   ├── install.sh              the single source of truth
│   ├── roles/                  idempotent units of work
│   └── profiles/               per-board overrides
├── systemd/
├── image/                      CI image build (chroot over base OS images)
└── .github/workflows/
```

Node packages are published **unscoped** as `node-red-contrib-yonder-*` so that Node-RED's
palette manager finds them by its normal `node-red-contrib-` search. `yonder-core` is a
plain library package.

### Why `packages/` is a workspace of many small packages

Each node package has one job, its own tests, and its own version. A contributor who
knows cellular modems can work in `yonder-modem` without reading the video code. That is
the difference between a project people contribute to and a project people fork.

---

## 6. Distribution

The installer is the source of truth. Images are a build product.

```
installer/install.sh
   │
   ├── run on a running board          → working system
   │
   └── run in a chroot in CI
         ├── over Raspberry Pi OS Lite  → yonder-rpi-<ver>.img.xz
         ├── over Armbian ZERO 3W      → yonder-radxa-zero3w-<ver>.img.xz
         └── over Armbian ROCK 5C      → yonder-radxa-rock5c-<ver>.img.xz
```

Radxa hardware encoding needs the Rockchip MPP library and the GStreamer Rockchip plugin,
which no repository packages; both are built from pinned commits into the offline payload by
`installer/make-payload.sh`. Image installation selects these filesystem payloads from the
declared Radxa target; runtime probing of `/dev/mpp_service` establishes encoder capability. Armbian
ships the vendor kernel, so Radxa is installable rather than image-only. The Pi supports
both paths.

The image work targets three outputs: Raspberry Pi 3/4/5, ZERO 3W and ROCK 5C. Exact
upstream compressed files and SHA-256 identities are recorded in `image/bases.lock.json`.
Tag builds are intended to create draft releases; reviewed artifacts are published without
rebuilding. Retained apt/payload inputs are also required before claiming reproducible
images. See [ADR-0010](adr/0010-image-storage-and-owner-recovery.md) for protected storage,
persistent diagnostics, Linux owner setup, apt maintenance and recovery. This design is
in progress; no ready-to-flash Yonder image is established by a base download.

---

## 7. Security posture

Commitments, enforced in review. Each maps to an `R-SEC` requirement.

| | |
|---|---|
| **One shared default, and it is published** | The setup access point carries a documented default passphrase, never presented as a secret. Everything that guards the vehicle or its configuration is per device — see [ADR-0007](adr/0007-credential-boundary.md) |
| **No remote root** | Key authentication; root login disabled; password authentication off unless enabled |
| **No open command path** | MAVLink ingest on loopback only unless explicitly opted in |
| **Least privilege** | Control plane runs as a dedicated user; privileged operations via narrowly scoped helpers |
| **No default administrator credential** | No administrator password exists until the operator sets one at first use, and no service is left at an upstream default |
| **Encryption available** | HTTP on the local access point; TLS available; the mesh VPN carries its own |
| **Code execution is gated** | The flow editor requires a password set at setup, and is not reachable from the cellular interface by default |

None of this is exotic. It is the difference between a product and a hobby image.

---

## 8. What we deliberately do not do

- **We do not fly the aircraft.** Yonder *does* command it — a mode change, a parameter
  write, a payload output are all commands, and sending them is a requirement (R-CMD).
  What Yonder does not do is decide to send one: no autonomy, no control loops, no
  failsafe logic. The autopilot owns those, and duplicating them would be dangerous.
- **We do not implement a licence check**, an activation step, or telemetry back to
  anyone. Beyond the values argument, coupling a UI to a licence check is what forces a
  product to fetch its interface at boot.
- **We do not build a ground station.** Mission Planner and QGC exist. We interoperate.
- **We do not fork Rpanion-server.** Being GPL-3.0 ourselves means specific components may
  be borrowed with attribution where that is genuinely better than writing them —
  see [ADR-0002](adr/0002-licence-gplv3.md).

---

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| 1 | ~~Dashboard 1.x or 2.x?~~ Settled in [ADR-0005](adr/0005-console-substrate.md) | — |
| 2 | Which parts of Rpanion-server to borrow — NTRIP client and log management are the candidates | M9 |
| 3 | Adaptive bitrate control signal: RTCP receiver reports, SRT statistics, or both | M9 |
| 4 | Does `yonder-core` run inside Node-RED or as a small sidecar owning `config.yaml`? | M0 |
| 5 | Do we support USB-gadget Ethernet on Pi 4/5, giving a wired path to the UI over the USB port? (R-NET-05) | M5 |
