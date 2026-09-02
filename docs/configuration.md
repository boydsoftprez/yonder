# Configuration reference

Everything about a device's state lives in **`/etc/yonder/config.yaml`**.

Every other configuration file on the system — `mavlink-router` config, NetworkManager
keyfiles, mediamtx config, GStreamer pipeline parameters — is **generated** from it. Edit
one of those by hand and the next apply will overwrite it. That single-writer rule is what
makes rollback possible.

## Headless setup

Drop a `config.yaml` on the boot partition. It is read on first boot and moved into place.
No imager, no cloud, no dialog.

## Apply and rollback

1. Validate against the schema. Invalid config is rejected; the device keeps running.
2. Snapshot the current config as `last-known-good`.
3. Apply, and start a confirmation timer (default 120 s).
4. Reaching the device again confirms the change.
5. Timer expires unconfirmed → revert and reboot.

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
- **`editor_password`** is **not** seeded at all. It does not exist until the operator sets
  an administrator password, which is what makes the console's first-run step meaningful.
  The shipped configuration says so too: `ui.editor.password` is `null` until there is a
  password to point at. A default that named a secret nothing ever creates would break the
  first code that resolved it eagerly, on every fresh device.

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
    password: null                             # then { secret: editor_password }, once set
    interfaces: [ethernet, wifi_client]        # note: cellular excluded by default

system:
  hostname: yonder
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

### Sections that arrive with later milestones

Designed, and rejected by the schema until the code that reads them lands — the loader
refuses keys it does not know, so adding these to a live `config.yaml` today fails
validation. They are here so the shape is settled before the milestone opens.

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

cameras:
  - id: cam0
    source:
      type: csi                 # csi | usb | hdmi | rtsp
      device: auto
    encoder: auto               # auto resolves per board; or v4l2h264 | x264 | rkmpp
    codec: h264                 # h264 | h265
    resolution: 1280x720
    framerate: 30
    bitrate:
      mode: adaptive            # adaptive | fixed
      min: 500k
      target: 2M
      max: 6M
    controls:
      contrast: normal
      brightness: normal
      flip_horizontal: 0        # 0 | 180
      flip_vertical: 0
      hdr: false
    outputs:                    # simultaneous, not exclusive
      - { type: rtp,    host: 192.168.2.10, port: 5604 }
      - { type: webrtc }
      - { type: rtsp,   path: /cam0 }
      - { type: srt,    port: 8890 }

network:
  modem:
    enabled: true
    mode: auto                  # auto | hilink | stick
    apn: null
    username: null
    password: { secret: modem_psk }

remote:
  zerotier:  { enabled: false, network_id: null }   # primary — joins by network ID
  tailscale: { enabled: false, auth_key: { secret: ts_authkey } }

gpio:
  relays:
    - { id: 1, pin: 17, mode: latching }
    - { id: 5, pin: 27, mode: pulse, duration: 1.5 }
```

## Notes on specific keys

**`mavlink.serial.baud: auto`** sweeps the rates ArduPilot is actually configured for in
the field, fastest-last so a slow link is found before a fast one is guessed at.

**`cameras[].outputs`** is a list, and every entry is active at once — browser preview and
a ground-station feed are not a choice between two options (R-VID-05).

**`network.priority`** replaces hand-tuned route metrics. Egress preference is stated once,
in order, and the metrics are generated.

**`ui.editor.interfaces`** deliberately omits `modem`. The flow editor is a
code-execution surface; it should not be reachable from a public cellular address without
a conscious decision.
