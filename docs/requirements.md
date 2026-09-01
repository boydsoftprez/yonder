# Requirements

What Yonder must do. This is the definition of done for the project — the roadmap
schedules these, and every pull request should be able to point at one.

**IDs are stable.** Once assigned, a requirement ID is never reused or renumbered.
Requirements may be marked withdrawn, never deleted.

Priority: **P1** must exist for a 1.0 · **P2** should exist for a 1.0 · **P3** wanted, may
land later.

---

## R-MAV — Flight controller link

| ID | Requirement | P |
|---|---|---|
| R-MAV-01 | Detect a flight controller automatically on a serial port, sweeping 57600, 115200, 230400 and 921600 baud in that order, and report the port and baud selected | 1 |
| R-MAV-02 | Accept a flight controller on either a hardware UART or a USB CDC-ACM device | 1 |
| R-MAV-03 | Route MAVLink to up to three ground stations over UDP, each with its own host and port | 1 |
| R-MAV-04 | Provide a MAVLink TCP server for ground stations that prefer it | 1 |
| R-MAV-05 | Provide a loopback MAVLink feed for the control plane, separate from ground-station traffic | 1 |
| R-MAV-06 | Never place ground-station MAVLink traffic on a path that a control-plane restart can interrupt | 1 |
| R-MAV-07 | Bind MAVLink ingest to loopback by default; accepting MAVLink from a non-loopback interface requires explicit configuration and is logged | 1 |
| R-MAV-08 | Start telemetry automatically at boot, to the configured endpoints, with no operator action | 1 |
| R-MAV-09 | Allow telemetry to be stopped and started at runtime | 2 |
| R-MAV-10 | Report link state: heartbeat present, telemetry running, endpoints in use | 1 |
| R-MAV-11 | Support all ArduPilot vehicle types, not fixed-wing alone | 1 |
| R-MAV-12 | Support PX4 | 3 |

## R-TEL — Telemetry presentation

| ID | Requirement | P |
|---|---|---|
| R-TEL-01 | Attitude indicator with pitch ladder and roll | 1 |
| R-TEL-02 | Heading, and a compass rose | 1 |
| R-TEL-03 | Barometric and GPS altitude, shown separately | 1 |
| R-TEL-04 | GPS fix type and satellite count | 1 |
| R-TEL-05 | Airspeed and groundspeed | 1 |
| R-TEL-06 | Flight mode and arm state, prominently | 1 |
| R-TEL-07 | Pack voltage, current and remaining percentage | 1 |
| R-TEL-08 | Per-cell voltage, derived from pack voltage and configured cell count | 1 |
| R-TEL-09 | Energy efficiency in mAh/km and Wh/km, computed from telemetry | 2 |
| R-TEL-10 | Consumed energy in mAh and Wh, with an operator reset | 2 |
| R-TEL-11 | Moving map with satellite imagery, layer selection, zoom and an aircraft marker showing heading | 1 |
| R-TEL-12 | Draw the telemetry set as an overlay on both the video and the map | 1 |
| R-TEL-13 | Independent fullscreen for the video and map panes | 2 |
| R-TEL-14 | Swap which of video and map is primary, the other becoming an inset | 2 |

## R-CMD — Vehicle commanding

Yonder sends commands that change how an aircraft behaves. This section governs **all** of
them, including the parameter writes in R-PAR and the payload outputs in R-IO.

| ID | Requirement | P |
|---|---|---|
| R-CMD-01 | Relay operator-initiated MAVLink commands to the autopilot | 1 |
| R-CMD-02 | Set flight mode from the interface | 1 |
| R-CMD-03 | Expose the command set the connected autopilot advertises, rather than a hard-coded subset chosen at build time | 2 |
| R-CMD-04 | **Originate no command the operator did not ask for.** No automatic mode changes, no autonomous reaction to link loss, battery state, geofence or any other condition | 1 |
| R-CMD-05 | **Never bypass, pre-empt or reimplement autopilot validation.** Every command is delivered to the autopilot, which remains free to reject it | 1 |
| R-CMD-06 | Require a distinct confirmation step for hazardous commands: arm and disarm, mode changes that alter the flight path, and payload actuation | 1 |
| R-CMD-07 | Log every command with the time, the value, and the session that requested it | 1 |
| R-CMD-08 | Accept commands only from an authenticated session, never from an unauthenticated non-loopback caller | 1 |
| R-CMD-09 | Show the operator whether a command was accepted or rejected by the autopilot, not merely that it was sent | 1 |

## R-PAR — Parameters and tuning

Parameter writes are vehicle commands. R-CMD applies to every requirement here.

| ID | Requirement | P |
|---|---|---|
| R-PAR-01 | Read and write any flight-controller parameter | 1 |
| R-PAR-02 | Search parameters by name prefix, with completion | 1 |
| R-PAR-03 | Log every parameter write with its old and new value | 1 |
| R-PAR-04 | Show a live panel of frequently-used parameters without searching | 2 |
| R-PAR-05 | *Withdrawn — superseded by R-CMD-02.* | — |
| R-PAR-06 | Configure battery chemistry and cell count | 2 |
| R-PAR-07 | Provide shortcut controls for cruise airspeed, ground speed, minimum airspeed and loiter radius, each range-validated | 2 |

## R-CAM — Camera capture

| ID | Requirement | P |
|---|---|---|
| R-CAM-01 | Capture from a CSI camera | 1 |
| R-CAM-02 | Capture from a USB UVC camera, including MJPEG, H.264 and H.265 sources | 1 |
| R-CAM-03 | Capture HDMI input via a CSI bridge, pushing an EDID to the bridge before capture | 2 |
| R-CAM-04 | Capture from a network camera over RTSP | 3 |
| R-CAM-05 | Enumerate cameras stably, so a camera keeps its identity across reboots and plug order | 1 |
| R-CAM-06 | Select an encoder appropriate to the board, resolved at install time and recorded in configuration | 1 |
| R-CAM-07 | Use hardware encoding wherever the board provides it, and software encoding where it does not | 1 |
| R-CAM-08 | Encode H.265 where the board's encoder supports it | 2 |
| R-CAM-09 | Run one independent pipeline per camera, up to the board's capability | 1 |
| R-CAM-10 | Refuse, with a clear message, a camera configuration the board cannot sustain | 2 |
| R-CAM-11 | Control gimbal-equipped cameras: aim, mode, recentre, zoom, focus, exposure and white balance | 3 |

## R-VID — Video transport

| ID | Requirement | P |
|---|---|---|
| R-VID-01 | Send RTP/UDP H.264 to a ground station, in a form Mission Planner and QGroundControl decode without modification | 1 |
| R-VID-02 | Send RTP/UDP H.265 in the same manner | 2 |
| R-VID-03 | Serve live video to a browser over WebRTC, with no plugin and no external service | 1 |
| R-VID-04 | Serve RTSP for ground stations and players that prefer it | 2 |
| R-VID-05 | **Deliver every configured output simultaneously.** Browser preview and ground-station streaming are not mutually exclusive | 1 |
| R-VID-06 | Serve SRT for lossy links, with recovery | 2 |
| R-VID-07 | Adapt encoder bitrate to measured link conditions, within an operator-set floor and ceiling | 2 |
| R-VID-08 | Allow a fixed bitrate where the operator prefers determinism | 1 |
| R-VID-09 | Give a late-joining receiver a decodable picture without waiting for the next natural keyframe | 3 |
| R-VID-10 | Publish the exact receive-side pipeline for each codec, so a ground station can be configured from the documentation alone | 1 |

## R-CTL — Live camera control

| ID | Requirement | P |
|---|---|---|
| R-CTL-01 | Start and stop each stream independently | 1 |
| R-CTL-02 | Set resolution | 1 |
| R-CTL-03 | Set bitrate | 1 |
| R-CTL-04 | Set contrast and brightness | 2 |
| R-CTL-05 | Flip horizontally and vertically, by degrees rather than a boolean | 2 |
| R-CTL-06 | Toggle HDR where the sensor supports it | 3 |
| R-CTL-07 | Select colour treatment: normal, monochrome, saturated | 3 |
| R-CTL-08 | Select codec per camera | 2 |
| R-CTL-09 | Select transport per camera | 2 |
| R-CTL-10 | Show current settings and running state for each camera, reading back stored values rather than form defaults | 1 |

## R-CEL — Cellular

| ID | Requirement | P |
|---|---|---|
| R-CEL-01 | Support modems that present as a tethered network appliance, with no configuration | 1 |
| R-CEL-02 | Support modems requiring APN, username, password and dial string | 1 |
| R-CEL-03 | Detect which mode a connected modem needs, and say which it chose | 2 |
| R-CEL-04 | Apply mode-switch quirks for modems that need them, from a table extensible without code changes | 2 |
| R-CEL-05 | Report signal strength, operator, and radio technology | 2 |
| R-CEL-06 | Survive a modem disconnect and reconnect without operator action | 1 |
| R-CEL-07 | Support two modems simultaneously, with failover between them | 3 |
| R-CEL-08 | Bond two links so a single stream survives the loss of one | 3 |

## R-NET — Networking

| ID | Requirement | P |
|---|---|---|
| R-NET-01 | Run a WPA2 access point with a configurable SSID, a per-device password, and a static address | 1 |
| R-NET-02 | Serve DHCP to access-point clients | 1 |
| R-NET-03 | Join an existing Wi-Fi network as a client, including scanning for networks | 1 |
| R-NET-04 | Support wired Ethernet, including a second adapter | 2 |
| R-NET-05 | Present as a USB Ethernet gadget where the board supports it, giving a wired path to the interface over the USB port | 3 |
| R-NET-06 | Take egress preference as an ordered list in configuration, and generate routing metrics from it | 1 |
| R-NET-07 | **If no configured network carries traffic within 90 seconds of `yonder-core` starting, bring up the access point regardless of configuration.** The window is measured from the moment the daemon starts, not from kernel boot, and start-up work comes out of it rather than pushing the deadline back. Disabling this requires an explicitly named configuration key | 1 |
| R-NET-08 | Disable Wi-Fi entirely on request, for flight | 2 |
| R-NET-09 | Be discoverable on a local network by hostname | 2 |
| R-NET-10 | Report per-interface throughput | 3 |
| R-NET-11 | Detect and report loss of the primary link, and act on it according to configuration | 2 |

## R-VPN — Remote access

| ID | Requirement | P |
|---|---|---|
| R-VPN-01 | Integrate a **primary** mesh VPN for NAT traversal, with join, leave and status from the interface, configurable from the declarative config file without an interactive login | 1 |
| R-VPN-02 | Support a **second**, independent mesh VPN, fully implemented rather than stubbed | 2 |
| R-VPN-03 | Report whether a connection is direct or relayed, since the difference is tens versus hundreds of milliseconds | 2 |
| R-VPN-04 | Serve the full interface over the mesh, not a reduced one | 1 |
| R-VPN-05 | Enable no VPN by default; a device with none configured must still work fully on a local network | 1 |

## R-IO — Payload and GPIO

| ID | Requirement | P |
|---|---|---|
| R-IO-01 | Drive configurable GPIO outputs as latching relays, initialising to a known-safe state at boot | 2 |
| R-IO-02 | Drive a GPIO output as a timed pulse of configurable duration, returning to its safe state automatically | 2 |
| R-IO-03 | Log every output state change | 2 |
| R-IO-04 | Never assert an output as a side effect of a restart or a configuration reload | 1 |

## R-DIA — Diagnostics

| ID | Requirement | P |
|---|---|---|
| R-DIA-01 | Ping an arbitrary host from the device | 2 |
| R-DIA-02 | Check general internet reachability | 2 |
| R-DIA-03 | Measure available uplink bandwidth on demand | 2 |
| R-DIA-04 | Verify the MAVLink path end to end | 2 |
| R-DIA-05 | Show a live, timestamped activity log | 1 |
| R-DIA-06 | Produce a support bundle containing logs and configuration, with secrets removed | 2 |

## R-SYS — System

| ID | Requirement | P |
|---|---|---|
| R-SYS-01 | Report board model, CPU load, CPU temperature, memory used and free, and uptime | 1 |
| R-SYS-02 | Report OS and Yonder versions | 1 |
| R-SYS-03 | Restart and shut down the device from the interface | 2 |
| R-SYS-04 | Check for, download and apply updates, with no licence check and no per-device entitlement | 2 |
| R-SYS-05 | Survive an interrupted update without becoming unbootable | 2 |
| R-SYS-06 | Manage flight logs: list, download, delete | 3 |
| R-SYS-07 | Provide an NTRIP client for RTK corrections | 3 |
| R-SYS-08 | Support Remote ID where regulation requires it | 3 |

## R-CFG — Configuration

| ID | Requirement | P |
|---|---|---|
| R-CFG-01 | Hold all device state in a single declarative file, from which every other configuration file is generated | 1 |
| R-CFG-02 | Validate against a published schema, rejecting invalid configuration without disturbing the running system | 1 |
| R-CFG-03 | Apply changes behind a confirmation timer, reverting to the last known good configuration if unconfirmed | 1 |
| R-CFG-04 | Keep secrets in a separate file that is never included in an image, a backup or a support bundle | 1 |
| R-CFG-05 | Configure a device fully headless by placing a configuration file on the boot partition | 1 |
| R-CFG-06 | Seed any credential the system needs but the operator has not supplied — from a published default where one is defined (R-SEC-01), otherwise generated per device and retrievable through the console rather than only from a log. **Never leave a device unusable for want of a credential.** See [ADR-0007](adr/0007-credential-boundary.md) | 1 |
| R-CFG-07 | Never require a vendor tool, an imaging wizard or a network service to configure a device | 1 |
| R-CFG-08 | **A freshly flashed device reaches a joinable, usable state with no operator input.** A default configuration is seeded, the access point comes up, and the console is served — before anyone has configured anything | 1 |

## R-HW — Hardware support

| ID | Requirement | P |
|---|---|---|
| R-HW-01 | Raspberry Pi Zero 2 W, 3, 4, CM3 and CM4 with hardware H.264 | 1 |
| R-HW-02 | Raspberry Pi 5 and CM5 with software H.264 | 1 |
| R-HW-03 | Radxa rk35xx boards with hardware H.264 and H.265 | 2 |
| R-HW-04 | One image per board family, selecting board-specific behaviour at boot rather than at flash time | 1 |
| R-HW-05 | Document per-board limits — camera count, resolution and encoder — and enforce them in configuration validation | 2 |
| R-HW-06 | Never overclock or over-volt a board by default | 1 |

## R-STO — Storage and resilience

| ID | Requirement | P |
|---|---|---|
| R-STO-01 | Keep volatile runtime state in RAM, not on the storage medium | 1 |
| R-STO-02 | Bound log growth so a long flight cannot fill the card | 1 |
| R-STO-03 | Survive loss of power at any moment without corrupting configuration | 1 |
| R-STO-04 | Provide a read-only or overlay root option for operators who want it | 3 |
| R-STO-05 | Ship no periodic background task that writes to the card without a stated reason | 2 |

## R-SEC — Security

| ID | Requirement | P |
|---|---|---|
| R-SEC-01 | Ship no shared default credential **that protects the vehicle or its configuration**. The setup access point may carry a published default passphrase, documented and never presented as a secret; every other credential is per device. See [ADR-0007](adr/0007-credential-boundary.md) | 1 |
| R-SEC-02 | Disable remote root login; administrative access is by key | 1 |
| R-SEC-03 | Run the control plane as a dedicated unprivileged user, using narrowly scoped helpers for privileged operations | 2 |
| R-SEC-04 | Expose no unauthenticated write path to configuration or to the vehicle from a non-loopback interface by default | 1 |
| R-SEC-05 | Gate any code-execution surface behind a password set during setup, and expose it on no public-facing interface by default | 1 |
| R-SEC-06 | Contact no external service, ever. No activation, no licence check, no usage reporting | 1 |
| R-SEC-07 | Include no credential material in a published image | 1 |
| R-SEC-08 | Offer TLS for the web interface | 2 |
| R-SEC-09 | **Until an administrator password has been set, the console offers no function but setting one.** No configuration read, no command, no status beyond what that step needs | 1 |

## R-UI — Interface

| ID | Requirement | P |
|---|---|---|
| R-UI-01 | Serve the entire interface from the device, with no asset fetched from the internet at runtime | 1 |
| R-UI-02 | Work fully in a browser with no installed software beyond the browser | 1 |
| R-UI-03 | Build navigation from detected hardware, so a camera that is not present has no section | 2 |
| R-UI-04 | Remain usable on a tablet in the field | 2 |
| R-UI-05 | Show the operator when a control has taken effect, not merely that it was sent | 2 |
| R-UI-06 | Function on a link with hundreds of milliseconds of latency | 1 |
| R-UI-07 | Provide **day and night themes as equal, operator-selectable modes**, defaulting to day. The choice persists across reboots and is never overridden by the host or the browser | 1 |

---

## Non-requirements

Stated explicitly, because each has been asked for and each is declined:

- **Yonder carries operator commands; it does not make decisions.** Setting a flight mode,
  writing a parameter and firing a payload output are all real commands that change how an
  aircraft behaves, and Yonder sends them — that is R-CMD, and it is a requirement, not an
  exception. What Yonder never does is *originate* one. There are no control loops, no
  autonomous reactions to link loss or battery state, and no failsafe logic; the autopilot
  owns all of that. Every command Yonder sends is one an operator asked for, and the
  autopilot remains free to reject it.
- **Yonder is not a ground station.** Mission Planner and QGroundControl exist; Yonder
  interoperates with them.
- **Yonder has no cloud component**, no account, no fleet management and no telemetry
  reporting.
- **Yonder does not gate features behind a licence.** There is no activation step and no
  entitlement mechanism, and none will be added.
