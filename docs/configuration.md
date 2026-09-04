# Configuration reference

Everything about a device's state lives in **`/etc/yonder/config.yaml`**.

Every other configuration file on the system — `mavlink-router` config, NetworkManager
keyfiles, mediamtx config, GStreamer pipeline parameters — is **generated** from it. Edit
one of those by hand and the next apply will overwrite it. That single-writer rule is what
makes rollback possible.

## Headless setup

Drop a `config.yaml` on the boot partition: it is read on first boot and moved into place.
No imager, no cloud, no dialog.

**Not built yet.** R-CFG-05 is real and lands in M8 ([roadmap](roadmap.md)); no code reads
`/boot/firmware/config.yaml` today, so a file placed there is ignored. Said here rather than
left to be discovered, because the moment an operator reaches for this is the moment a board
is already unreachable — and finding out then is worse than knowing now. See
[K-39](known-issues.md).

## Apply and rollback

1. Validate against the schema. Invalid config is rejected; the device keeps running.
2. Snapshot the current config as `last-known-good`.
3. Apply, and start a confirmation timer — `apply.timeout`, 120 s by default, or
   `apply.radioTimeout`, 300 s, when the change moves the Wi-Fi radio between running the
   access point and joining a network.
4. Reaching the device again confirms the change.
5. Timer expires unconfirmed → revert and reboot.

**Two windows, because there are two kinds of change** (R-CFG-10). A change that leaves your
connection where it was — a hostname, a console port, a theme — is confirmed in seconds, and
giving it five minutes only means a change that broke the device sits there for five minutes.
A change that moves the radio takes the access point off the air under you: you have to
notice, join the other network yourself, find the device again and open the console there.
The longer window is the time that takes. Which one an apply gets is decided by whether the
radio changes mode, not by which keys were edited — changing the passphrase of a network
already configured is not a radio move.

Independently: **if no configured network carries traffic within 90 s of `yonder-core`
starting, the access point comes up regardless of configuration.** The window is measured
from the moment the daemon starts, and start-up work comes out of it rather than delaying
it. The AP is a floor, not a mode.

## Secrets

A value written as a mapping `{ secret: <name> }` is read from `/etc/yonder/secrets.yaml`,
which is mode `0600` and never included in an image or a support bundle.

Two names are seeded differently, and deliberately so — see
[ADR-0007](adr/0007-credential-boundary.md):

- **`ap_psk`** is seeded with the published default passphrase **`yonder1234`**, the same on
  every device. It is documented rather than secret: it exists so a freshly flashed board is
  joinable, and a value only readable from the device's own journal would lock out the one
  person entitled to it. Change it from the console and the daemon keeps your value.
- **`admin_password`** is the administrator password, and it is **not** seeded at all. It
  does not exist until the operator sets one from the console, which is what makes the
  first-run step meaningful (R-SEC-09, [ADR-0008](adr/0008-the-setup-gate.md)). It is stored
  hashed — `scrypt$N$r$p$salt$hash` — never in the clear, and it is the one secret that is
  *not* referenced from `config.yaml` at all: nothing points at it, because nothing but the
  daemon may read it. The console runs as the unprivileged `yonder` user and cannot open
  `secrets.yaml`; it asks the daemon over its socket whether a submitted password is right.

  Setting it is one way. There is no console path that replaces it, because a path that could
  replace it without knowing it would be a device with no lock. Forgetting it means the card:
  remove the `admin_password` line from `/etc/yonder/secrets.yaml` and restart
  `yonder-core`.

- **`editor_password`** is a name from an earlier design and is never created. `ui.editor.
  password` still exists in the schema and is `null`, and it stays `null`: the flow editor is
  gated by the same `admin_password` as the console, checked in the same place. A default
  that named a secret nothing ever creates would break the first code that resolved it
  eagerly, on every fresh device.

```yaml
psk: { secret: ap_psk }         # the value lives in secrets.yaml under "ap_psk"
```

Nothing else is a secret reference. A bare string is a bare string, and validation says so
rather than silently treating it as a name to look up.

## Schema

The authoritative schema is in [`config/schema/`](../config/schema/), generated from the
model in `yonder-core`. The configuration below is what the daemon accepts today; the test
suite parses this very block through the schema, so the two cannot drift apart.

**The access point's DHCP range is not configurable, and `address` is what decides it.**
NetworkManager's `shared` method runs its own dnsmasq and hands it a range on the command
line, derived from the access-point address — so the range follows the subnet you set and
nothing else. There used to be a `network.ap.dhcp` block here; it was written to a drop-in
NetworkManager's own command line overrode, so it decided nothing, and it has been removed
rather than left looking authoritative. A `config.yaml` still carrying it loads anyway — it
is a *retired* key, dropped with a line in the journal saying so, and you need not delete
anything (see below). K-15 in [`known-issues.md`](known-issues.md) records what a
configurable pool would cost.

<!-- yonder:reference-config -->
```yaml
version: 1

network:
  ap:
    enabled: true
    ssid: yonder
    psk: { secret: ap_psk }
    address: 192.168.77.1/24                   # also decides the DHCP range clients are given
    fallback: { enabled: true, timeout: 90 }   # never disable this without reason
  client:
    ssid: null                                 # set from the console, not at flash time
    psk: null                                  # then { secret: wifi_psk }
  ethernet: { dhcp: true }
  priority: [ethernet, modem, wifi_client]     # egress preference, highest first

ui:
  port: 3000
  theme: day                                   # day | night
  editor:
    enabled: true
    password: null                             # stays null; admin_password is the credential
    interfaces: [ethernet, wifi_client]        # note: cellular excluded by default

apply:
  timeout: 120                                 # seconds, 30-600
  radioTimeout: 300                            # seconds, 30-600; an apply that moves the radio

system:
  hostname: yonder                             # also published as <hostname>.local
  timezone: UTC
```

### Keys that have been retired

A key Yonder once accepted and has since removed is **dropped on load, not rejected**: the
daemon names it in the journal and carries on. An upgrade therefore never strands a device
on a configuration its own daemon refuses to read (R-CFG-09) — which is what a strict schema
does otherwise, on the one file that decides how you reach the aircraft.

Your file is not rewritten. The key stays where it is, ignored, and simply is not written
back the next time the configuration is saved.

Only the keys listed here are treated this way. Anything else the schema does not recognise
— a misspelling, a setting from somewhere else — is still an error naming the offending
path, because a key silently ignored is a setting you believe is in force and is not.

<!-- yonder:retired-keys -->
| Key | What became of it |
|---|---|
| `network.ap.dhcp` | The access point's DHCP range is not configurable; NetworkManager derives it from `network.ap.address`, so this key decided nothing (K-15) |

### Cameras

A `cameras:` list validates, gets its defaults, and goes through apply and rollback like
any other section; since M4 it also runs — the pipeline, the media server's configuration
and the console's camera pages are all generated from it ([roadmap](roadmap.md)).

```yaml
cameras:
  - id: cam0
    name: Nose
    source: usb                    # usb only today — csi, hdmi and a second camera arrive later
    device: platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0  # the by-path name (R-CAM-05) — not the bus id v4l2-ctl prints, which resolves to nothing
    enabled: true
    autostart: false               # off by default; video has no equivalent of R-MAV-08
    width: 1280
    height: 720
    framerate: 30
    codec: h264                    # h264 only today
    bitrate_kbps: 2000
    preview:                       # the cheap copy the interface watches (R-VID-13)
      width: 640
      height: 360
      framerate: 15
      bitrate_kbps: 400
    controls:
      brightness: null
      contrast: null
      rotation: 0                  # 0 | 90 | 180 | 270
    outputs:                       # simultaneous, not exclusive (R-VID-05)
      - { kind: rtp,  host: 192.168.2.10, port: 5604 }
      - { kind: rtsp, password: { secret: cam0_rtsp } }
```

An RTSP output names no path: this camera's stream is served at its **id** and its cheap
preview at `cam0-preview`, so the URL the console prints is
`rtsp://yonder:<password>@<device>:8554/cam0`. One name, in one place — an output that
named its own path let the media server declare one name while the pipeline published to
another, and where the two differed the camera would not start at all.

`kind: srt` is accepted by the schema and refused by the device: SRT arrives with R-VID-06,
and until it has a credential of its own an SRT output would listen with no password on
it. The camera page says so before you press Start.

Up to 8 cameras, each with up to 8 outputs. Resolution, frame rate, codec, the preview and
the image controls are cosmetic enough that changing them does not arm the confirmation
window; everything else about a camera does, including its bitrate and its outputs — both
share the uplink the console itself is reached over, so a change to either is held until you
confirm it (R-CFG-03, R-VPN-07).

### Sections that arrive with later milestones

Designed, and rejected by the schema until the code that reads them lands — the loader
refuses keys it does not know, so adding these to a live `config.yaml` today fails
validation. They are here so the shape is settled before the milestone opens.

**Except `remote:`, which works.** M2a shipped it, and the block below is what a device
accepts today rather than a shape waiting for a milestone.

```yaml
vehicle:
  autopilot: ardupilot          # ardupilot | px4 (px4 later)

mavlink:
  serial:
    device: auto                # auto | /dev/ttyAMA0 | /dev/ttyACM0
    baud: auto                  # auto sweeps 57600, 115200, 230400, 921600
  endpoints:                    # up to three ground stations
    - { name: gcs0, host: 192.168.2.10, port: 14550 }
  tcp_server: { enabled: true, port: 5760 }
  autocast: true                # start telemetry at boot without operator action

network:
  modem:
    enabled: true
    mode: auto                  # auto | hilink | stick
    apn: null
    username: null
    password: { secret: modem_psk }

remote:
  zerotier:  { enabled: false, network_id: null }   # primary — joins by network ID

gpio:
  relays:
    - { id: 1, pin: 17, mode: latching }
    - { id: 5, pin: 27, mode: pulse, duration: 1.5 }
```

## Notes on specific keys

**`mavlink.serial.baud: auto`** sweeps the rates ArduPilot is actually configured for in
the field, fastest-last so a slow link is found before a fast one is guessed at.

**`cameras[].outputs`** is a list, and every entry is active at once — two ground stations
are not a choice between two options (R-VID-05). The browser's preview is not one of them:
it is the separate `preview:` block above, always published, and it is what R-VID-13 keeps
cheap.

**`remote.zerotier`** is the whole of the mesh configuration: a switch and a network ID.
That is the point of choosing it first — a network ID is a value you can put in a file, and
an interactive login is not ([ADR-0004](adr/0004-zerotier-primary-mesh-vpn.md)), so a device
can be given remote access from the boot partition with no screen and no account on the
device.

`network_id` is **sixteen lowercase hexadecimal characters**, and it is validated for that
shape before it is applied. That check earns its place: a network ID that is merely *wrong*
produces no error from the mesh client at all — the device sits in `Joining…` indefinitely,
exactly as it would if it had no route out — so the last chance to catch a mistyped one is
before it is sent. Shape validation catches a dropped character, an extra one, and a letter
past `f`. It cannot catch a well-formed ID for a network that does not exist.

Joining does not go behind the confirmation window. A mesh join only ever *adds* a path to
the device and cannot take away the one the operator is using, so under R-CFG-12 it is kept
rather than held — see [the design note](superpowers/specs/2026-09-02-remote-access-design.md)
for the measurements that earned that exemption. What a join *does* wait for is a person:
the device joins in seconds and then sits in **waiting to be approved** until somebody
authorises it in the controller. Nothing times out of that state and nothing is reverted
while it lasts; a week there is a correct outcome.

The mesh client is installed but **not started** until a network is configured. A client with
no network joined still holds live sessions with its vendor's root servers, and a device
should not be talking to anyone's infrastructure because software is merely present
(R-VPN-08).

**`remote.tailscale` does not exist yet.** The second mesh (R-VPN-02) lands in M2b, and until
it does, the `remote` section accepts `zerotier` and nothing else — a configuration naming
`tailscale` is rejected on load like any other key that is not a Yonder setting (R-CFG-09).

**`network.priority`** replaces hand-tuned route metrics. Egress preference is stated once,
in order, and the metrics are generated.

**`ui.editor.interfaces`** deliberately omits `modem`. The flow editor is a
code-execution surface; it should not be reachable from a public cellular address without
a conscious decision.

**`ui.port`** is the port the console listens on, and changing it goes through apply and
rollback like anything else: the console's `settings.js` is generated from this file, so a
port change rewrites it and restarts the console. If the new port turns out to be
unreachable, the confirmation timer puts the old one back (R-CFG-03). The console binds every
interface — what stands in front of it is the administrator password, not the bind address.

**`ui.editor.enabled`** decides whether the flow editor is mounted at all. `false` means
Node-RED's admin application is not mounted: not hidden, not password-protected, absent, and
`/editor` is a 404 like any other path. `true` mounts it at `/editor` behind the same
administrator password as the console — and it is `true` only on a device that has one. Until
a password is set the editor is unmounted whatever this says, because there is nothing to
gate it with (R-SEC-05, R-SEC-09).

Both keys take effect on the next apply. The daemon rewrites `settings.js` and restarts the
console when — and only when — that file would change, so a network change does not sign you
out of the console you made it from.

**`ui.theme`** is `day` or `night`, and both are designed rather than one being the other
inverted: night is warmer, dimmer and pulled away from blue, because a screen that is right
at noon costs dark adaptation at midnight. Day is the default because in direct sunlight a
dark screen becomes a mirror (R-UI-07, [ADR-0005](adr/0005-console-substrate.md)).

The choice is yours and it persists here. It is **never** taken from the browser or the
host: `prefers-color-scheme` describes the device somebody happens to be holding, not the
light they are standing in.

Changing it writes a generated stylesheet beside `settings.js` and does **not** restart the
console — refresh the page to see it. That matters more than it sounds: a theme goes through
apply and rollback like every other change, so it has to be confirmed, and a restart would
sign you out of the console you would have confirmed from.

**`apply.timeout` and `apply.radioTimeout`** are the two confirmation windows above, in
seconds, each between 30 and 600. Below 30 s nobody can confirm anything; above 600 s an
unconfirmed change that broke the device sits there for ten minutes.

**`system.hostname`** is the device's name, and since M1b-2 it is applied rather than merely
recorded: the daemon sets the system hostname from it, and `avahi-daemon` publishes it over
mDNS, so the device answers to `<hostname>.local` on a network it has joined (R-NET-09,
R-CFG-08). It is a renderer like everything else, so a change goes through apply and
rollback.

**Whether that name resolves depends on the device you are looking from, and Yonder cannot
test that from here.** macOS and iOS have always resolved `.local`; Windows has since
Windows 10; Android varies by version. It has **not** been verified on real hardware for
this build. The address always works, and your router's list of connected clients is where
to find it. The console says the same thing rather than the nicer sentence.

**`network.client.ssid` and `network.client.psk`** are normally set from the console's
Network page rather than by hand. The console posts the network name and passphrase to the
daemon, which puts the passphrase in `secrets.yaml`, writes `{ secret: wifi_psk }` here, and
applies the whole document — so the passphrase never lands in this file, which is
world-readable on the device.

On a board with one Wi-Fi radio, setting these takes the access point down: one radio serves
one mode at a time, the configured client wins, and the client is raised before the access
point is dropped (R-NET-12, K-13). If the join fails, the access point comes back — the
renderer raises it, and if that does not happen the confirmation window expires and the whole
configuration reverts.

## Joining a Wi-Fi network

The console's Network page is a network picker and a password box. What it does
underneath is worth knowing once, and is deliberately not on the page.

**This board has one Wi-Fi radio.** It can run its own access point, or it can
join a network. It cannot do both — so the moment a join is applied, the access
point goes off the air and the console goes with it. That is not a fault and it
is not avoidable on this hardware; it is what one radio means. The radio *can*
scan while serving the access point, which is why the network list works at all,
but it cannot associate: NetworkManager answers `The Wi-Fi network could not be
found` because the interface is busy being an AP.

**Nothing is asked of the operator afterwards** (R-CFG-11). The device decides
whether the join took: it waits for an address on the new network and then pings
the gateway it was handed. Both true, and the change is confirmed and kept. Not
true, and the apply reverts, the previous configuration is restored, and the
`yonder` access point comes back on its own.

This replaced a confirmation the operator had to give by hand, inside a window,
from a console that had just disappeared — which meant a **working**
configuration was discarded whenever somebody was slow finding the device again.

What the device cannot establish is whether *you* can reach it. A network that
isolates its clients will satisfy every check above and still hide the board from
the laptop beside it. R-CFG-11 states that trade rather than leaving it as a
surprise; the way back is Ethernet, or the card.

**Finding it again.** The device publishes its hostname over mDNS, so
`yonder.local:3000` usually works — on macOS and iOS, on Windows 10 and later,
and on many Android versions, but not on every network and not on every device,
and it has not been verified on hardware for this build. The router's list of
connected clients always works.
