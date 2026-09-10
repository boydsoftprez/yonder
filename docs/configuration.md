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
  modem:
    enabled: false
    mode: auto                                 # auto | appliance — see note below
    interface: null
    apn: null
    username: null
    password: null                             # then { secret: modem_password }
    dial: null
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

storage:
  reserve_mb: 1024              # recording stops before it takes the card below this; 0 means none

mavlink:
  serial:
    device: auto                # auto | /dev/ttyAMA0 (Pi) | /dev/ttyS2 (Rockchip, Armbian) | /dev/ttyACM0 (USB)
    baud: auto                  # auto sweeps 57600, 115200, 230400, 921600, slowest first
  endpoints: []                 # up to three, e.g. { name: gcs0, host: 192.168.2.10, port: 14550 }
  tcp_server:
    enabled: true               # and no listener until ingest.loopback_only is false — see below
    port: 5760                  # must not be ui.port — the console always wins that collision
  autocast: true                # start telemetry at boot without operator action
  ingest:
    loopback_only: true         # accepting MAVLink from off-device requires setting this false
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

Set `enabled: true` and `autostart: true` on each camera that must return after a
power cycle. Yonder resolves the saved device identity, checks its capture capabilities,
and starts the pipeline in the background. Missing hardware is retried every five seconds;
automatically started pipelines retry failures with backoff capped at thirty seconds.
Runtime Stop cancels startup and pipeline retries until the daemon next starts. Changing
`autostart` on a camera that was off at boot selects the next boot's behavior; Start runs it
immediately. A configuration change that suspends an automatic camera is reversible.

At boot, a failed modem activation is logged and initialization continues to telemetry,
media, and cameras. Normal configuration changes retain apply and rollback behavior.

```yaml
cameras:
  - id: cam0
    name: Nose
    source: usb                    # usb or accessory; detection supplies the source
    device: platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0  # the by-path name (R-CAM-05) — not the bus id v4l2-ctl prints, which resolves to nothing
    enabled: true
    autostart: false               # set true to restore this camera automatically at boot
    width: 1280
    height: 720
    framerate: 30
    codec: h264                    # h264 | h265 — h265 needs a board whose encoder offers it (Rockchip); refused otherwise
    bitrate_kbps: 2000
    stream:                        # the bitrate policy for the ground-station stream (R-VID-07, R-VID-17)
      mode: fixed                  # fixed | adaptive — fixed by default
      floor_kbps: 2000             # the adaptive envelope; seeded from bitrate_kbps until set explicitly
      ceiling_kbps: 2000           # bounded 100-20000, the same range bitrate_kbps has always had
    preview:                       # the cheap copy the interface watches (R-VID-13)
      mode: adaptive                # adaptive | fixed — adaptive by default
      size: auto                   # auto | 1280x720 | 854x480 | 640x360
      ladder_top: 1280x720         # the largest size Auto may step to
      ladder_bottom: 640x360       # the smallest
      floor_kbps: 300              # bounded 100-4000
      ceiling_kbps: 2000
      bitrate_kbps: 400            # the Fixed-mode target, retained while Adaptive is selected
      framerate: 15
    controls:                      # raw device units throughout — R-CTL-11 … R-CTL-14
      brightness: null
      contrast: null
      rotation: 0                  # 0 | 90 | 180 | 270
      zoom: null
      focus: null
      exposureTime: null           # RAW 100 µs units — 156 shows as 15600 µs on the console
      whiteBalanceTemperature: null # kelvin
      gain: null
      backlightCompensation: null
      gamma: null
      sharpness: null
      saturation: null
      hue: null
      powerLineFrequency: null     # menu id: 0 disabled, 1 50 Hz, 2 60 Hz, 3 auto
      autoExposure: null           # menu id: 0 auto, 1 manual, 2 shutter priority, 3 aperture priority
      autoWhiteBalance: null
      autoFocus: null
      horizontalFlip: null           # the mirror — a switch, not degrees
      verticalFlip: null             # the flip — likewise
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

Up to 8 cameras, each with up to 8 outputs. Resolution, frame rate, codec and the image
controls are cosmetic enough that changing them does not arm the confirmation window;
everything else about a camera does, including its bitrate, its stream and preview policy,
and its outputs — all four share the uplink the console itself is reached over, so a change
to any of them is held until you confirm it (R-CFG-03, R-VPN-07).

**`preview` is no longer cosmetic (R-NET-07).** It used to be exempt from the confirmation
window on the strength of a bound small enough that nothing set inside it could saturate a
link — 2000 kb/s at most. That ceiling is now 4000, enough on a thin cellular link to take
the console's own uplink with it, so a change to any field under `preview` — the mode, the
size, the ladder, the floor, the ceiling, the fixed target, the rate — is held and confirmed
exactly like a change to `bitrate_kbps` is.

#### Stream and preview policy

`stream` and `preview` both carry a bitrate policy: a fixed target the operator sets
directly, or an adaptive floor and ceiling the device's rate controller stays inside.
`preview` additionally carries `size`, held at one of three offered pictures or left at
`auto` for the controller to step between `ladder_bottom` and `ladder_top` on its own.

A configuration written before this section existed still means what it meant. `stream`'s
adaptive floor and ceiling default to whatever `bitrate_kbps` already is — a fixed-rate
stream expressed in the new fields, not a new envelope nobody chose. `preview.width` and
`preview.height` are still accepted and are migrated into `preview.size`: the pair must name
one of the three offered pictures exactly, because inventing a fourth to hold an arbitrary
legacy size, or rounding to the nearest offered one, would be Yonder deciding what the
operator meant rather than reporting that the file needs attention. Carrying both
`width`/`height` and `size` at once is refused rather than resolved by precedence, so an
ambiguous file is never silently read one way when it might have meant the other.

`preview.size`, `preview.ladder_top` and `preview.ladder_bottom` each hold one of
`1280x720`, `854x480` or `640x360`; `size` alone may also be `auto`. `stream` and `preview`
both bound their floor and ceiling to the same range their own fixed target does —
100-20000 kb/s for `stream`, 100-4000 for `preview`.

The schema bounds each field to its own range; it does not itself compare a floor against
a ceiling, or a ladder's smallest against its largest. That comparison is `validateDraft`'s
job, in `yonder-core`'s `apply/draft.ts` — it runs on the console's in-progress edit before
Apply, names a reversed floor and ceiling, a reversed ladder, or a held size a camera does
not offer by the field that is wrong, and never repairs one: swapping a reversed pair,
clamping an out-of-range value, or substituting the nearest legal size would all be Yonder
deciding what the operator meant, and R-CMD-04 is why that decision stays theirs.

#### Pocket 2 accessory source

Detection can adopt a Pocket 2 as `source: accessory` with the stable identity
`device: pocket2:<USB-controller-name>`. It shares one daemon-owned USB session with
the picture, controls and camera-card recorder. Peripheral USB mode must already be
available; runtime detection reports missing or claimed controllers and changes no boot
or network settings. A configured accessory listens asynchronously at startup even when
its picture is stopped. Camera traffic loss clears active gestures and retries after a
45-second detached interval; reconnecting never resumes motion.

The camera's H.264 SPS supplies native dimensions, while frame timestamps supply its
measured cadence. The observed native feed is 1280×720 at approximately 29.97 fps.
The console's output resolution, frame rate, bitrate and independent preview settings
configure Yonder's encodes. They do not claim to change the camera's fixed USB format.
The packaged pipeline host and `avdec_h264` decoder are required for accessory video.

Ordinary Pocket 2 rate control uses the camera's native clamps and fresh status,
with a 500 ms operator-intent lease. A lit pitch, roll or yaw limit pauses movement.
`accessory_mount` remains an optional measured envelope/action profile for the
legacy discrete-action path; it is not required for ordinary HG211 speed control.
Recognized HG211 native mode/recenter actions use the independently verified path.
Recenter also selects Follow mode. An old world-angle envelope must not be treated
as a native-joint travel limit after changing the handle's orientation.

Aim reports HG211 pan and tilt **relative to the handle**. FPV provides the measured
native travel with horizontal mounting; level-maintaining modes can reach another
joint's limit earlier. The six saved positions use that same handle reference in
FPV. Position values do not wrap at ±180 degrees. Moving the mount changes the view
associated with a saved handle-relative position.

`gimbal_presets` is optional camera metadata containing `revision` and up to six
unique `slots`. Each slot stores `slot` (1–6), `name` (1–32 characters),
`frame: hg211-joints-v1`, `mode: 1`, native `pan`/`tilt` degrees and `savedAt`.
Use Save current position in Aim: the daemon captures settled feedback rather
than accepting browser-provided angles. Rename and Clear update the same record.
Preset-only saves use the configuration engine without rendering network or video
settings, so they need no restart or Keep confirmation. Concurrent edits are refused.

Recall requires fresh FPV joint feedback and an explicit operator press. It uses
the current speed setting, capped at 60 degrees/s, and stops on arrival, Stop,
manual override, lost browser intent, stale data, mode/source changes, device limits
or stalled progress. It never switches modes or resumes after reconnection.

Pocket exposure, ISO, EV, rational shutter, focus, white balance and native card-format
controls use the camera's own measured menu and observed state. Photographs and native
recordings stay on its card; Yonder reports capture completion and medium state but
cannot list, download or delete those files. Battery percentage remains unknown.

#### Camera image controls

`cameras[].controls` stores what an operator asked the sensor to hold, in **the camera's
own raw units, never a display unit** (R-CTL-11 … R-CTL-14). `null` means *leave the camera
alone* — it is not the same as zero, which several of these accept as a real, meaningful
setting: `gain: 0` is a camera's own floor, not "unset".

| Key | Stored as |
|---|---|
| `brightness`, `contrast` | device units, -100..100 |
| `rotation` | degrees: 0, 90, 180 or 270 |
| `zoom`, `focus` | device units (no published × ratio for zoom yet — R-CTL-14) |
| `exposureTime` | **raw** 100 µs units — `156` is a 15,600 µs shutter |
| `whiteBalanceTemperature` | kelvin |
| `gain`, `backlightCompensation`, `gamma`, `sharpness`, `saturation` | device units |
| `hue` | device units, signed |
| `powerLineFrequency` | menu id — 0 disabled, 1 50 Hz, 2 60 Hz, 3 auto |
| `autoExposure` | menu id — 0 auto, 1 manual, 2 shutter priority, 3 aperture priority |
| `autoWhiteBalance`, `autoFocus` | boolean |
| `horizontalFlip` (the mirror), `verticalFlip` (the flip) | boolean — `null` leaves the camera alone |

**A flip is not a rotation, which is why there are three fields and not one** (R-CTL-05).
`rotation` is degrees because 0, 90, 180 and 270 are rotations; a mirror is not one of them.
180 degrees is both flips together, and neither flip alone is any rotation at all, so a
single degrees field reaches four of the eight orientations an airframe mount can need and
cannot say which of the other four it is looking at. Each flip therefore gets its own
switch, stored beside the degrees rather than folded into them. The console calls
`horizontalFlip` **Mirror** and `verticalFlip` **Flip**, which is what an operator standing
at the aircraft calls them; `video/descriptors.ts` is the one place that translation lives.

Not every camera implements them — the bench Global Shutter Camera implements neither, and
implements no `rotate` either. A camera that does not offer one reports it as not offered,
which is the honest answer about the *device*.

**All three fields work on every camera even so** (R-CTL-05, R-CTL-15). Where the sensor
carries a turn it costs nothing; where it will not, the board carries it after decoding, as
one `videoflip` on the decoded frames ahead of the tee — so the full-rate stream and the
preview cannot disagree about which way up the world is. The board is given only the
*remainder*, the turn that takes the picture the sensor is actually producing to the one
asked for, so a mirror the sensor is already making is never mirrored a second time.

The fall back is never silent, which is the whole of R-CTL-15: the console draws all three
controls on every camera and states beside each which of the two is carrying it. The two
look identical in the picture and cost very different amounts — the board's correction is
processing on every frame, the sensor's is free — and an operator choosing between mounting
the camera differently and paying for the correction has to be able to tell which they are
looking at. A quarter turn is the dearest: it transposes every frame, and it swaps the
picture's width and height.

The console converts for display only where the stored number is not what an operator
should read: `exposureTime`'s 100 µs units become microseconds. Every other field above —
including the two menu ids and `whiteBalanceTemperature`'s kelvin reading — is shown
exactly as stored (`video/descriptors.ts`'s `DESCRIPTORS`, the one place that conversion is
allowed to live).

Each field accepts the widest range its V4L2 control can express, not the narrower range
any one camera answers — wide enough to hold every camera Yonder might meet. A real
device's own range is enforced only when a control is actually written (`applyControls`,
`packages/yonder-core/src/video/controls.ts`), against what that device reported; which
menu ids a camera actually offers — among `powerLineFrequency`'s and `autoExposure`'s four
each — is enforced there too, not by this schema.

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
    device: auto                # auto | /dev/ttyAMA0 (Pi) | /dev/ttyS2 (Rockchip, Armbian) | /dev/ttyACM0 (USB)
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

remote:
  zerotier:  { enabled: false, network_id: null }   # primary — joins by network ID

gpio:
  relays:
    - { id: 1, pin: 17, mode: latching }
    - { id: 5, pin: 27, mode: pulse, duration: 1.5 }
```

## Notes on specific keys

**`cameras[].codec: h265`** encodes the ground-station stream in H.265 on a board whose
probed encoder offers it — a Rockchip board's MPP does; a Raspberry Pi's V4L2 encoder does
not, and the camera page refuses Start with the encoder named rather than letting the
pipeline die (R-CAM-08, R-CAM-10). It changes only what leaves for the ground station: the
copy the console watches has its own `cameras[].preview.codec` setting (R-VID-20).
Both codecs have selectors on the camera page and use the existing Apply workflow.
Changing either codec restarts the camera pipeline; retain or revert the change when
the confirmation window is offered.

**`cameras[].preview.codec`** defaults to H.264 when omitted. Select `h265` for a
browser that can receive HEVC over WebRTC. The console offers this choice only when
the board encoder and current browser advertise H.265; H.264 remains selectable for
compatibility. Preview codec is shared by viewers of this camera, so an older browser
may need it changed back to H.264. Changing codec alone does not change the configured
bitrate budget.

**`cameras[].preview.size: 1920x1080`** holds a full-HD browser preview;
`preview.framerate: 30` selects 30 fps. The main capture must be at least
1920×1080. The preview menu also offers 1080p as the largest automatic size,
while the default ladder still tops out at 720p. Dual full-HD encoding must
be checked against board throughput and cooling; selecting a size does not
guarantee a throttled board can sustain the requested rate.

**`mavlink.serial.baud: auto`** sweeps the rates ArduPilot is actually configured for in
the field, fastest-last so a slow link is found before a fast one is guessed at. A pinned
value is checked against that same set — `57600`, `115200`, `230400` or `921600` — and
anything else is refused rather than passed to the router untried.

**`mavlink.endpoints`** takes up to three ground stations, each with its own name, host and
port; a fourth is refused rather than silently dropped (R-MAV-03).

**`mavlink.endpoints[].name`** may not be `autopilot`, `yonder` or `inbound` — the names the
generated `mavlink-router` configuration already uses for the flight-controller link, the
control-plane's loopback copy and the ingest listener — and no two ground stations may share
a name with each other. Either one produces two identically-headed sections in the generated
file, and the router keeps one and silently drops the other. Refused at write time, with the
offending name and endpoint named (R-MAV-15). The console has no field for an endpoint's name
today, so this is reached by editing `config.yaml` directly — a fully supported path, and the
one place a mistake here would otherwise be silent.

**`mavlink.endpoints[].name`** is one word of letters, digits, `_`, `.` or `-`, starting
with a letter or a digit, and **`mavlink.endpoints[].host`** is an IPv4 or IPv6 literal or a
DNS name. Both are written verbatim into the `mavlink-router` configuration Yonder generates
— the name as a section heading, the host as a field inside one — so a line break in either
would be a new line of that file: a name carrying one opens a whole extra section, an
unconfigured second copy of your telemetry that nothing here describes and nothing on the
console shows. Refused at write time for that reason (R-MAV-18).

**`mavlink.tcp_server.enabled: true` is not on its own enough to get a TCP server.** The
listener needs `enabled: true` *and* `ingest.loopback_only: false`; with the shipped defaults
— which are `enabled: true` and `loopback_only: true` — nothing is listening on port 5760,
and the Telemetry page says so rather than showing the port.

The two are coupled because a MAVLink TCP server cannot be bound to loopback alone: it binds
every interface the device has, and MAVLink is bidirectional, so an accepted connection is an
unauthenticated command path to the vehicle — the exact thing `ingest.loopback_only` exists
to keep shut (R-MAV-07). Turning it on from a switch that says nothing about the network
would open that path silently, so it takes both. The switch is still its own: opening ingest
does not turn a TCP server you deliberately disabled back on.

**`mavlink.tcp_server.port`** must not be the same as `ui.port`. `mavlink-router` is started
before the console, so a collision is not a race the console could win — it would lose its
own port and strand the operator on the page they would fix it from. Refused at write time,
before either service is started (R-MAV-14).

**`mavlink.ingest.loopback_only`** keeps the control-plane MAVLink feed bound to loopback.
Accepting it from a non-loopback interface is an unauthenticated command path to the vehicle,
so it takes an explicit `false` here to open it, and the daemon logs that it is running that
way (R-MAV-07).

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

**`network.modem.mode`** is `auto` or `appliance`. `auto` means the modem the system found —
the kind ModemManager claims and identifies for itself, with registration, operator, radio
technology and signal all available without being told anything. `appliance` means a modem
the operator names in `network.modem.interface`, because it holds the SIM, dials by itself
and presents to the host as an ordinary network adapter — indistinguishable from any other
without a list of device identifiers written from a vendor's documentation (R-CEL-11). These
replace the `hilink`/`stick` sketch that appeared in this reference before M3a: that sketch
was never implemented and never shipped, so no device in the field can be carrying either
value.

Enabled modem profiles reconnect automatically with unlimited NetworkManager
activation retries (R-CEL-06). A slow modem can finish registering after boot without
requiring a console reconnect. A password reported as `<hidden>` is unreadable, so
it does not trigger a redial. A password-only change takes effect on the next dial.

**An enabled appliance must name its adapter.** `interface` is the whole of how this device
locates one, so `enabled: true` with `mode: appliance` and no `interface` is refused —
loading such a file fails and applying such a change is rejected before anything is written.
It used to be accepted, and what it produced was a device that dialled nothing while the
Cellular tab reported the appliance as connected on "the named adapter", naming nothing.
`enabled: false` says nothing about the adapter: switching an appliance off is not the same
as deleting its settings. This is a rule between two fields, so it is not expressible in
`config/schema/yonder.schema.json` — an editor validating against that file will not catch
it, and the device will.

**Clearing a modem setting clears it on the device.** `apn`, `username`, `password` and
`dial` set to `null` are removed from the connection profile, not merely left out of the
next write — and because a bearer setting being removed is a change to the bearer, the modem
is dialled again so the removal takes effect (R-CFG-13, R-CEL-09). Changing `mode` between
`auto` and `appliance` replaces the profile rather than editing it: the two modes are
different kinds of NetworkManager connection sharing one name, and a connection's kind
cannot be changed.

**`network.modem.apn`** has no default and is never guessed. Debian's carrier database
lists `NXTGENPHONE` first for the SIM this was measured against, which is the value that
attached and carried nothing, and the value that worked is absent from the file entirely.
An APN comes from your carrier (R-CEL-09).

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

**`storage.reserve_mb`** is the space on the card that recording may not consume (R-STO-06).
A recording ends by itself when the free space reaches it, and the console shows remaining
time measured against it rather than against an empty card. **One number for the device, not
one per camera**, because the medium is not per camera: two cameras recording at once share
the same floor, and whichever reaches it first ends. It defaults to 1024 MB — headroom for
the writes a running board makes that nothing else bounds, the apply journal among them,
since a card with no space left is a device that cannot roll back. `0` means no reserve, for
an operator who means to fill the card.

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

**`network.modem.password`** takes the same road, from the Network page's Cellular tab. The
console posts what the operator typed; the daemon stores it as `modem_password` in
`secrets.yaml`, writes `{ secret: modem_password }` here, and applies the whole document
(R-CEL-02). An **empty password box means "leave the stored credential alone"**, not "clear
it" — so an operator who came to the page to change an APN does not lose a working SIM
credential by not retyping it. Clearing the credential is `password: null` in this file.

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

**So the console does not offer a confirm control for one.** The `CHANGE
PENDING` banner is still there, still counting down, and it says that the device
is confirming for itself. A console still on the air after a radio move is one
the change already worked for, so a `CONFIRM` there would either do nothing
useful or be pressed by somebody who cannot see that the device is already fine
— and pressing it ends the device's own check early, which is exactly the
judgement R-CFG-11 took away. `REVERT NOW` stays: deciding you do not want the
change is still yours, and it is the only control over that apply you have.

What the device cannot establish is whether *you* can reach it. A network that
isolates its clients will satisfy every check above and still hide the board from
the laptop beside it. R-CFG-11 states that trade rather than leaving it as a
surprise; the way back is Ethernet, or the card.

**Finding it again.** The device publishes its hostname over mDNS, so
`yonder.local:3000` usually works — on macOS and iOS, on Windows 10 and later,
and on many Android versions, but not on every network and not on every device,
and it has not been verified on hardware for this build. The router's list of
connected clients always works.
