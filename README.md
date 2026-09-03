# Yonder

### *Open-source 4G/5G companion computer for long-range UAS. Telemetry and video from anywhere, no cloud.*

Put a Raspberry Pi or Radxa board on your aircraft next to an ArduPilot flight controller.
Fly out past the horizon and keep the link — telemetry and video over the cell network,
from a web page, with nothing phoning home.

> *yonder* — over there, in the distance, past where you can see.

> **Status: pre-alpha.** The configuration engine, the network layer, the console and
> remote access over a mesh VPN are built, and each has been exercised on a Raspberry Pi 4
> — including reaching the console over the mesh from a machine on another network. Video,
> telemetry and cellular are not built yet, and no board has been cold-flashed from this
> branch and left alone. See the [roadmap](docs/roadmap.md) and the
> [known issues](docs/known-issues.md).

## What it does

- **Telemetry** — autodetects your flight controller, routes MAVLink to up to three ground
  stations over UDP plus a TCP server. Mission Planner and QGroundControl just work.
- **Video** — one pipeline per camera, hardware-encoded where the board can. Streams to
  your ground station *and* your browser at the same time.
- **Cellular** — 4G/5G modems in tethered or stick mode, with APN configuration.
- **Unlimited range** — ZeroTier or Tailscale for NAT traversal through carrier CGNAT.
- **A web interface** — cockpit with HUD and moving map, camera controls, parameter
  editing, network and modem setup, GPIO relays.

## What makes it different

| | |
|---|---|
| **Offline-first** | No cloud. No activation. No phone-home. Works in a field with no signal, forever. |
| **Unbrickable** | Bad config rolls back automatically. The access point always comes up. No reflashing because you typed an SSID wrong. |
| **Simultaneous outputs** | Browser preview and ground-station video at the same time, not one or the other. |
| **Adaptive video** | Bitrate follows the link instead of ignoring it. SRT for lossy cellular. |
| **Declarative config** | One `config.yaml`. Drop it on the boot partition for headless setup. |
| **Reproducible images** | CI runs the same installer you would. Every release is rebuildable from its commit. |

## Hardware

**Raspberry Pi** — Zero 2 W, 3, 4, 5, CM3, CM4, CM5
**Radxa** — Zero 3W/3E, Rock 4D, Rock 5C/5C Lite, Rock 5B/5B+

Cameras: CSI, USB (UVC), HDMI via a TC358743 bridge. Flight controller over UART or USB.

> Note: the Pi 5 and CM5 have no hardware H.264 encoder. They work, in software, and they
> run hotter and slower than a Pi 4 doing the same job.

## Getting started

1. **Flash** the image to a card and put it in the board.
2. **Power on.** There is nothing to configure first and nothing to plug in.
3. **Join the Wi-Fi network `yonder`** with the passphrase **`yonder1234`**.
4. **Open `http://192.168.77.1:3000`.**
5. **Set an administrator password.** The console offers nothing else until you do.

That passphrase is published, identical on every device, and is not a secret — it exists so
a board you have never touched is joinable at all. The password you set in step 5 is the one
that guards the aircraft, and you can change the access-point passphrase from the console
once you are in. [ADR-0007](docs/adr/0007-credential-boundary.md) explains why the boundary
sits there rather than on the access point.

### What of that works today

**Steps 2 and 3 do.** A board that has never been configured seeds itself a default
configuration, raises the access point and hands out DHCP leases, with no operator input and
no apply — and if a configuration change ever leaves it unreachable, the access point comes
back on its own. That is the network layer, and it is done.

**Step 4 does not, yet.** There is no console to open: it is the next milestone, and until
it lands the device is configured by posting to the daemon's Unix socket. See
[verifying M1a](docs/hardware/verifying-m1a.md) for what that looks like on real hardware.

**Step 1 comes later still.** There is no published image to flash yet; M8 is the first
release built as one. Today you install onto a board yourself, which is the same thing the
image build runs:

```sh
sudo ./installer/install.sh          # Raspberry Pi OS or Debian, with NetworkManager
./installer/install.sh --dry-run     # print the plan, change nothing
```

Everything from step 2 onward is the same afterwards.

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | What runs, why, and where the boundaries are |
| [Roadmap](docs/roadmap.md) | Milestones, in the order they get built |
| [Configuration](docs/configuration.md) | `config.yaml` reference |
| [Decision records](docs/adr/) | Why things are the way they are |
| [Known issues](docs/known-issues.md) | Recorded defects and when each starts to matter |
| [Requirements](docs/requirements.md) | Everything Yonder must do, numbered |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — particularly the rule that logic goes in
node packages and never in Node-RED function nodes. That one constraint is what makes this
project reviewable.

## Licence

[GPL-3.0](LICENSE). This software was built because open-source work was taken, sealed up
and sold. Copyleft is deliberate — see [ADR-0002](docs/adr/0002-licence-gplv3.md).

## Prior art and thanks

[ArduPilot](https://ardupilot.org) · [mavlink-router](https://github.com/mavlink-router/mavlink-router)
· [mediamtx](https://github.com/bluenviron/mediamtx) · [Node-RED](https://nodered.org)
· [GStreamer](https://gstreamer.freedesktop.org) ·
[Rpanion-server](https://github.com/stephendade/Rpanion-server) ·
[BlueOS](https://github.com/bluerobotics/BlueOS)

Yonder is not affiliated with or endorsed by any commercial product, and contains no
third-party source beyond the dependencies named above.

---

<sub>Every companion-computer solution on
[ArduPilot's own list](https://ardupilot.org/dev/docs/turnkey-companion-computer-solutions.html)
is commercial. Yonder is the open one.</sub>
