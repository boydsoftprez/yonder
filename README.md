# Yonder

### *Open-source 4G/5G companion computer for long-range UAS. Telemetry and video from anywhere, no cloud.*

Put a Raspberry Pi or Radxa board on your aircraft next to an ArduPilot flight controller.
Fly out past the horizon and keep the link — telemetry and video over the cell network,
from a web page, with nothing phoning home.

> *yonder* — over there, in the distance, past where you can see.

> **Status: pre-alpha.** The design and requirements are settled. The code is not
> written yet. See the [roadmap](docs/roadmap.md).

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

Not yet. See [the roadmap](docs/roadmap.md) — M8 is the first release you can flash.

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
