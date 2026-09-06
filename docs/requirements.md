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
| R-MAV-09 | **Allow telemetry to be stopped and started at runtime, and stop the sending rather than the service.** An operator stops telemetry to stop broadcasting, not to lose sight of the aircraft — so stopping takes the ground stations, and the TCP server they connect to, out of what is generated, and leaves the flight-controller link and the control plane's own loopback copy running. The interface goes on reporting heartbeat, port, speed and vehicle throughout, and starting again is a restart rather than a fresh port-and-speed detection. **A stop is not a security control**: the separately-configured path by which MAVLink is accepted from the network (R-MAV-07) is an explicit decision of the operator's and is not reversed by this one — so the moment telemetry is stopped, the interface says plainly that the path is still open, because *telemetry is off* and *nothing can command the vehicle* are otherwise exactly the two things that get confused. No configuration change may resume sending while a stop is in force | 2 |
| R-MAV-10 | Report link state: heartbeat present, telemetry running, endpoints in use | 1 |
| R-MAV-11 | Support all ArduPilot vehicle types, not fixed-wing alone | 1 |
| R-MAV-12 | Support PX4 | 3 |
| R-MAV-13 | **When no flight controller is found, say which kind of nothing it is.** A sweep that ends without a link distinguishes three outcomes and reports the one it reached: nothing transmitting on the wire at any speed, which is also what a swapped or missing pair looks like and is reported with the pins to check; something reaching the receive pin at every speed that never resolves to a valid frame — bytes that never parse, or bytes the UART could not even frame — which rules the wiring out and points at the autopilot's own protocol and baud settings; or a link. **A byte the UART could not frame still reaches the reader as ordinary data**, so the noise case is read from the delivered bytes themselves and never depends on a framing-error count being available; what the absence of that count costs is time rather than the distinction — a wrong speed is left when its deadline expires rather than the moment its errors appear. Detection continues on a cadence rather than giving up, because a board is routinely powered before the aircraft it is wired to, and the interface says how long it has been looking and when it will look again. **The port and speed a probe found are never written to the configuration** — they are remembered as a hint that is tried first and discarded when it fails, so replacing a flight controller heals on the next boot rather than needing a file edited (the reasoning R-CAM-06 was withdrawn for, applied to a serial port) | 1 |
| R-MAV-14 | **A generated listener never takes a port the device is already serving on.** The configuration refuses a MAVLink TCP port that collides with a port Yonder itself binds — the console's above all — with the offending path named, at the moment it is written. This is not tidiness: `mavlink-router` starts before the console and would win the race, leaving an operator without the page they would fix it from. The check lives in the schema rather than in a renderer, because a renderer runs after the apply has been accepted | 1 |
| R-MAV-15 | **A ground station may not take a name Yonder reserves for its own endpoints, and no two ground stations may share one.** The generated `mavlink-router` configuration is keyed by endpoint name — the flight-controller link, the control-plane's loopback copy and the ingest listener each have a name of their own, and a ground station reusing one, or two ground stations sharing a name with each other, produces two identically-headed sections in that file. The router keeps one and silently drops the other, with nothing anywhere saying which. Refused in the schema, with the offending name and endpoint named, at the moment the operator writes it — the same reasoning as R-MAV-14, because a renderer runs only after the apply has already been accepted | 1 |
| R-MAV-16 | **Telemetry is interrupted only by a change that is about telemetry, or by an operator who asked for it.** Configuration is applied by re-rendering everything on every apply, and again when the control plane starts, so a telemetry renderer that probed the serial port and restarted the router unconditionally would take that port off a router already carrying traffic, or bounce a working link because an unrelated setting changed — dropping every ground station in flight for a change that had nothing to do with them. **A router that is already running is evidence of a working link and is never re-probed to confirm it**: the port and speed it is using are recovered from the configuration it was started with, and it is restarted only when the configuration that would now be generated differs from the one on disk. Re-detection has to stop the router to get the port back, so it is an operator action with the interruption stated first, never something Yonder decides on its own (the same instinct as R-NET-12). And a telemetry fault costs telemetry and nothing else: a router that will not start, a port that cannot be opened, a file that cannot be written are all reported on the page and in the log, and none of them fails the apply — because a failed apply reverts the whole configuration, and a change that moves the radio reverts *and reboots*, which would take the video, the mesh and the network off a flying aircraft in exchange for a link that was already down | 1 |
| R-MAV-17 | **Installing the router does not start one.** The service that owns the serial port is carried in the offline install payload and installed **stopped and disabled**; the control plane starts it, and only once detection has found a port and a speed and generated the configuration it reads. A unit enabled at install would open that port at every boot before the sweep could — it is the one resource the two of them contend for — so a device whose flight controller had been changed would adopt the port and speed named by the configuration it was last started with instead of measuring what is now in front of it (R-MAV-16), and a freshly flashed device, which has no generated configuration at all, would fail and be restarted for ever before its console came up. Telemetry still starts at boot with no operator action (R-MAV-08); what starts it is the control plane. **A router that dies is restarted by the service manager, never by the control plane** — a control plane that restarted it would make the router's lifetime depend on its own, which is what R-MAV-06 forbids — and restarting only after a *failure*, rather than always, is what leaves a router that exits cleanly, told to or because its configuration leaves it nothing to do, stopped rather than brought back | 1 |

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
| R-TEL-15 | Show the attitude, mode and limit state of a camera's own gimbal beside the vehicle telemetry, with a reached limit shown as an annunciator on the video overlay (R-TEL-12, R-UI-11), not burned into the picture | 3 |

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
| R-CAM-06 | *Withdrawn — superseded by R-CAM-13.* Resolving the encoder at install time and writing it into configuration fails twice over: the installer seeds `config.yaml` only when absent, so the value goes stale on upgrade, and image builds run the installer in a chroot on a build host, which would bake a build machine's answer into a board's image. R-HW-04 wants board-specific behaviour chosen at boot rather than at flash time | — |
| R-CAM-07 | Use hardware encoding wherever the board provides it, and software encoding where it does not | 1 |
| R-CAM-08 | Encode H.265 where the board's encoder supports it | 2 |
| R-CAM-09 | Run one independent pipeline per camera, up to the board's capability | 1 |
| R-CAM-10 | Refuse, with a clear message, a camera configuration the board cannot sustain | 2 |
| R-CAM-11 | Control gimbal-equipped cameras: aim, mode, recentre, zoom, focus, exposure and white balance | 3 |
| R-CAM-12 | Detect attached cameras on demand from the console, and report what was found, what was rejected and why | 1 |
| R-CAM-13 | Select an encoder appropriate to the board by probing the hardware, not from a table of board names, and report the encoder in use. An operator may name one explicitly to bypass the probe | 1 |
| R-CAM-14 | Build a camera's offered formats, resolutions, rates and controls from what the device answers, never from a stored list. **A capability the device advertises but does not answer is absent**, and is reported as advertised-but-unavailable rather than hidden | 1 |
| R-CAM-15 | Capture from a camera that is itself a USB host and expects a phone, by presenting the board as that phone and speaking the camera's own protocol. The picture and the gimbal, exposure and white-balance controls (R-CAM-11) arrive on the same link. Requires a board port that can act as a USB device, which on a Raspberry Pi 4 means header or PoE power | 3 |

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
| R-VID-11 | Report the egress bandwidth each running output consumes and their total, against the capacity of the path they leave by. R-VID-05 makes simultaneous outputs possible; this is what stops an operator oversubscribing a link without being told | 1 |

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
| R-CEL-09 | **A cellular link that reports itself connected is shown to be carrying traffic, or shown not to be.** Registration, signal, an assigned address and an installed route can all be correct while no packet completes, and the difference can be a single character in the APN — so the interface states which of the two is true rather than reporting the indicators and leaving the operator to conclude. The link is tested with real traffic when it comes up and on request; between those it is judged by the interface's own byte counters, which cost nothing on a metered link. Nothing is tested on a schedule. **No APN is ever suggested, completed or tried on the operator's behalf**: the published database's first answer for the SIM this was measured on was the value that failed, and the value that worked was absent from it | 1 |
| R-CEL-10 | **Signal is reported in full, and Yonder turns it on.** Where a modem exposes detailed measurements behind a setting, Yonder applies that setting when the link comes up rather than reporting only what is available by default — a coarse quality percentage is not a substitute and is not shown. The measurements are published as live values on the same interface as all other device state, so that a later instrument consumes them without a second collection path. Reading them must not consume the operator's data | 2 |
| R-CEL-11 | **A modem that does not present itself for automatic detection is named in configuration, and the interface says what such a modem cannot tell it.** Automatic detection covers modems the system's modem service claims. A modem that appears only as a network adapter is indistinguishable from an ordinary one, so it is identified by the operator rather than by a list of device identifiers written from documentation. For such a modem the absence of signal, operator and radio technology is shown as a property of that kind of modem, not as data that failed to arrive | 2 |
| R-CEL-12 | **The interface that reports a broken link is the one that can repair it.** Where the console shows that a cellular link is not carrying traffic, the settings that would fix it are editable from the same surface, and the change goes through the ordinary confirmation and rollback path so that a second wrong value is recoverable rather than fatal. Reporting a fault an operator must then leave the console to correct is most of the value of reporting it thrown away | 2 |
| R-CEL-13 | **What Yonder reports about a modem is read from the modem that is there now, never remembered from one that was.** Neither that a modem exists nor which interface carries its traffic is carried over from an earlier reading: the identifiers a modem service hands out are numbered per run of that service, so a modem changed while that service was restarted would otherwise inherit the departed one's ports. A board whose modem is unplugged, powered off or claimed by nothing reports no cellular path at all, and neither tests nor stands down a path that is not there. **Every such reading is bounded**, because a wedged modem service answers nothing at all rather than answering badly, and this reading sits inside the check that decides whether the access point comes up. A reading that failed or did not arrive in time is not an answer: it falls back to the last interface actually observed, never to a name that would stand a working link down | 1 |

## R-NET — Networking

| ID | Requirement | P |
|---|---|---|
| R-NET-01 | Run a WPA2 access point with a configurable SSID, a per-device password, and a static address | 1 |
| R-NET-02 | Serve DHCP to clients of the access point, from addresses inside the access point's configured subnet. The address range itself is **not** configurable: it is derived from the access point's address by the network stack that serves it. See K-15 | 1 |
| R-NET-03 | Join an existing Wi-Fi network as a client, including scanning for networks | 1 |
| R-NET-04 | Support wired Ethernet, including a second adapter | 2 |
| R-NET-05 | Present as a USB Ethernet gadget where the board supports it, giving a wired path to the interface over the USB port | 3 |
| R-NET-06 | Take egress preference as an ordered list in configuration, and generate routing metrics from it | 1 |
| R-NET-07 | **If no configured network carries traffic within 90 seconds of `yonder-core` starting, bring up the access point regardless of configuration.** The window is measured from the moment the daemon starts, not from kernel boot, and start-up work comes out of it rather than pushing the deadline back. Disabling this requires an explicitly named configuration key | 1 |
| R-NET-08 | Disable Wi-Fi entirely on request, for flight | 2 |
| R-NET-09 | Be discoverable on a local network by hostname | 2 |
| R-NET-10 | Report per-interface throughput | 3 |
| R-NET-11 | Detect and report loss of the primary link, and act on it according to configuration | 2 |
| R-NET-12 | **One Wi-Fi radio serves one mode at a time, and which one is decided here rather than by the network stack.** Where a board has a single radio and a client network is configured, the client wins and the access point is taken down deliberately — and the client is raised *before* the access point is dropped, because the operator submitting those credentials is reaching the device through the radio being retuned. A change that leaves the radio on no network brings the access point back without waiting for the confirmation window to expire | 1 |
| R-NET-13 | **A path that stops reaching anything is stood down, and traffic moves to the next path that works.** Configuration states preference and remains the only writer of it; reachability decides only whether a path participates, never its order. A path in use is judged by its own byte counters, and active testing happens only once a path in use stops receiving — a device that is working spends nothing on finding that out. Demotion requires repeated failure and restoration requires less, so that a momentary loss does not move an aircraft, and **the thresholds are established by measurement against a real link loss rather than chosen in advance**. Every change of path is recorded as a log entry naming what failed, what traffic moved to, and when | 2 |
| R-NET-14 | **A path says what has been established about it, and no more.** Three conditions are kept apart and never share a sentence: there is no such interface on this board; there is one and it is not up; there is one, it is up, and nothing has established whether anything completes over it. An interface that is down is a *known* condition and not a fault — an aircraft flies with its ethernet unplugged — so it is reported as what it is rather than as untested. A path is called down only on evidence the device actually holds; a state the network stack reports in words this does not recognise leaves the path where it was rather than being described on a guess | 2 |
| R-NET-15 | **A Wi-Fi client that will not come up is not a failed apply, so long as the device is still reachable.** Writing a profile for a network that is not on the air is the configuration succeeding; whether that network is in range at this moment is a fact about the world and not about the device. Where the client cannot be raised and the access point is up, the render says so plainly and completes — every other subsystem in the same apply stands, and the operator's change is kept rather than rolled back. Where the access point is *not* up, nothing has established that the device can still be reached, and it remains a failure | 1 |
| R-NET-16 | **A connection Yonder owns is removed because the configuration no longer wants it, never because its hardware is not present at this instant.** Configuration is a durable statement of intent; an interface that has not appeared yet is a fact about timing. A profile whose device is missing is left exactly as it stands — not deleted, not rewritten — so that when the device does appear the link comes up with no operator action and no further render | 1 |

## R-VPN — Remote access

| ID | Requirement | P |
|---|---|---|
| R-VPN-01 | Integrate a **primary** mesh VPN for NAT traversal, with join, leave and status from the interface, configurable from the declarative config file without an interactive login | 1 |
| R-VPN-02 | Support a **second**, independent mesh VPN, fully implemented rather than stubbed | 2 |
| R-VPN-03 | Report whether a connection is direct or relayed, since the difference is tens versus hundreds of milliseconds | 2 |
| R-VPN-04 | Serve the full interface over the mesh, not a reduced one | 1 |
| R-VPN-05 | Enable no VPN by default; a device with none configured must still work fully on a local network | 1 |
| R-VPN-06 | **Joined but not yet authorised is a state in its own right, and the interface says so.** Where a mesh requires a person to approve a device, the interface names that state as neither a fault nor a connection, shows the identifier that must be approved with a means of copying it, and waits indefinitely. Nothing times out and nothing is reverted while a device waits to be approved: a week in this state is a correct outcome. What this gives up is telling a mistyped network ID apart from a controller that cannot be reached — the client reports both as an ordinary join in progress, for ever, and the interface does not guess between them | 1 |
| R-VPN-07 | **Joining a mesh is kept, not held.** It is a case of R-CFG-12, and it is earned by measurement rather than by argument: a join only ever adds a route, and the client refuses a route that would overlap a network the device is already on. Approval by a person is never waited on inside a confirmation window, because a window that expires while somebody walks to their laptop discards a working configuration — and waiting to be approved is the ordinary case, not the rare one. **Each mesh earns this separately.** R-CFG-12 treats what has not been shown to be safe as load-bearing, so a second mesh is held until its own behaviour has been measured. A join that fails for a reason the device can see — a malformed network ID, a client that is not installed, a service that will not start — fails the apply and reverts like any other change | 1 |
| R-VPN-08 | **The primary mesh client installs on a board with no network.** It is carried in the offline payload, pinned to a version and a fingerprint recorded in this repository, and verified against the publisher's signature — using a key committed here rather than fetched — before it is staged. The second mesh client, whose install pulls a dependency tree and changes system-wide packet-filter alternatives, is fetched over the network by a role that runs only when it is configured. **Installing a mesh client does not start one:** the unit is stopped and disabled at install and started only when a network is configured, so a device carries no connection to anyone's infrastructure until it is asked for one | 1 |
| R-VPN-09 | **Where a mesh needs a key the operator generates, the interface says where to get one and what kind to generate, and reports when the device's access expires.** The key is held in the secrets file and handed to the client as a file, never on a command line other processes can read. Once joined, the interface reports the expiry of the device's own access — including when there is none — so an aircraft cannot quietly lose remote access on a date nobody was told about. A key is never refused for being of the wrong kind (R-CFG-06) | 2 |
| R-VPN-10 | **"Connected" is a measurement, not a membership.** A mesh client reports a network as configured long after it can reach anything — the configuration is cached and survives the loss of every path — so an interface that reads that field alone tells an operator their aircraft is reachable when it is not. Connected means the device has a working path *and* a valid membership; a valid membership with no path is its own state and is named as one. What backs the word is shown beside it: whether the path is direct or relayed, its latency, when the device was last heard from, and the traffic that has crossed it | 1 |

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
| R-DIA-04 | **Verify the MAVLink path end to end, and report it as a chain rather than a verdict.** The three links — the flight controller to Yonder, Yonder to the ground stations, and a ground station back to Yonder — are reported separately, each carrying the reason for its own state, because they fail for different reasons and send the operator to different places. **A link nothing has attempted is reported as not attempted, never as failed.** Telemetry an operator deliberately stopped, a device that has been powered for two seconds, and a ground station that has never sent anything are all cases where nothing has gone wrong and nothing has been established either; reporting any of them as a failure teaches an operator that the check is noise, which costs them the one time it is not. That is a third state in the answer itself, not a shade of colour a page chooses — a page given only pass and fail cannot draw the difference | 2 |
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
| R-SYS-09 | Report supply-voltage state where the board exposes it, distinguishing *now* from *has happened since boot*, and record an occurrence in the log. An undervoltage event restarts the board, and a restart in flight presents as an aircraft that went quiet with nothing to explain it | 1 |

## R-CFG — Configuration

| ID | Requirement | P |
|---|---|---|
| R-CFG-01 | Hold all device state in a single declarative file, from which every other configuration file is generated | 1 |
| R-CFG-02 | Validate against a published schema, rejecting invalid configuration without disturbing the running system | 1 |
| R-CFG-03 | Apply changes behind a confirmation timer, reverting to the last known good configuration if unconfirmed. **Confirmation is evidence that the device is still reachable, not necessarily a human saying so** — where the device can establish that itself, it does, and the operator is not made to prove it (see R-CFG-11) | 1 |
| R-CFG-04 | Keep secrets in a separate file that is never included in an image, a backup or a support bundle | 1 |
| R-CFG-05 | Configure a device fully headless by placing a configuration file on the boot partition | 1 |
| R-CFG-06 | Seed any credential the system needs but the operator has not supplied — from a published default where one is defined (R-SEC-01), otherwise generated per device and retrievable through the console rather than only from a log. **Never leave a device unusable for want of a credential.** See [ADR-0007](adr/0007-credential-boundary.md) | 1 |
| R-CFG-07 | Never require a vendor tool, an imaging wizard or a network service to configure a device | 1 |
| R-CFG-08 | **A freshly flashed device reaches a joinable, usable state with no operator input.** A default configuration is seeded, the access point comes up, and the console is served — before anyone has configured anything | 1 |
| R-CFG-09 | **A configuration written by an earlier version of Yonder still loads.** A key a later version has retired is dropped, named in the log and ignored; a key that was never a Yonder setting is still rejected, so a misspelling can never pass for a setting. Loading does not rewrite the operator's file. **An upgrade must never strand a device on a configuration its own daemon refuses to read** | 1 |
| R-CFG-10 | **A change that moves the operator's own connection gets a longer window to be confirmed in than one that does not.** R-CFG-03's timer is measured from the apply; a change that takes the access point off the air costs the operator the time to notice, find the device again on another network and open the console there, and a window budgeted for a change they watched happen reverts a good configuration out from under them. Both windows are named in the configuration | 1 |
| R-CFG-11 | **A change the device can verify for itself is confirmed by the device.** Joining a Wi-Fi network is the case that matters: the operator loses the console the moment the radio moves, so requiring them to find the device on another network and click a button inside the window means a working configuration is discarded because somebody was slow — a worse and far more common failure than the one the confirmation exists to catch. The device confirms when it holds an address on the new network and can reach its gateway; when it cannot, the existing rollback restores the previous configuration and the access point returns. What this gives up is the case where the device is reachable to itself but not to the operator — a client-isolating network — and that is stated here rather than left as a surprise. **The console does not offer a confirm control for such a change.** An operator who can still press one is on a network that exists only because the change already worked, so the press is either pointless or made by somebody who cannot see that the device is already fine — and it ends the device's own verification early, which is the judgement this requirement took away. The banner still appears, still counts down and still offers the revert: deciding you do not want the change is still the operator's, and it is the only control they have over it. What the banner says changes with it, because a countdown with nothing to press and no explanation is worse than the confirm control it replaced | 1 |
| R-CFG-12 | **A change that cannot cost reachability is kept, not held.** The confirmation timer is the price of R-CFG-03's guarantee that a device comes back by itself; a change that touches nothing reachable has nothing to guarantee, and holding it means an operator watches their own choice undo itself. Everything is treated as reachable until proven otherwise, so a field nobody has considered is load-bearing by default. **Each exemption is earned individually and named leaf by leaf.** `ui.theme` earned it by reverting a palette an operator had watched take. `remote.zerotier`'s two fields earned it on a board, where a join added exactly one route and the client refused a controller-pushed route that overlapped the device's own network. `mavlink.endpoints`, `mavlink.autocast` and `mavlink.tcp_server.enabled` earn it by construction: none of them touches an interface, a route or a radio, and the window's own remedy — revert *and reboot* — would take the video, the telemetry and the mesh off a flying aircraft in exchange for protecting nothing. `mavlink.serial`, `mavlink.ingest` and `mavlink.tcp_server.port` are deliberately not exempt — the port because a value the schema accepts in full can still be one another service on the device already holds, and R-MAV-14 checks that collision against only `ui.port` | 1 |
| R-CFG-13 | **What is generated matches the configuration, including what the configuration no longer says.** A setting an operator has cleared is *removed* from the generated file, not left standing at its old value — an omitted setting and an absent one are the same thing to the single declarative file and are not the same thing to the tool that writes the device, so the removal is stated rather than implied. Where a generated object cannot be changed into the shape now wanted, it is replaced rather than modified into something it cannot become. A generated file still carrying a value the configuration has dropped is a setting an operator believes they have cleared and which is still in force, with nothing anywhere saying which of the two is true | 1 |

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
| R-SEC-09 | **Until an administrator password has been set, the console offers no function but setting one.** No configuration read, no command, and no status beyond two things: whether a password has been set, and whether the device is healthy enough to set one. The second is a deliberate carve-out — a board that cannot say *why* it is refusing is a board that goes back in a box — and it is bounded to state that names no configuration, no interface, no address and no credential | 1 |
| R-SEC-10 | **Emit no credential anywhere a credential does not belong** — a log line, an error message, a support bundle, or an API response. Redaction happens where the value is captured, not where it is printed, so a new caller cannot reintroduce the leak | 1 |
| R-SEC-11 | **Authentication fails closed.** A component that cannot reach, or cannot get an answer from, whatever holds a credential refuses the login. Being unable to check a password is never treated as the password being right, and a device that cannot tell whether it has a lock behaves as though it has one nobody can open | 1 |
| R-SEC-12 | **A failure of the interface never costs the network.** Nothing that serves the console — the process, its configuration, its dependencies — may stop, restart or reconfigure the service that keeps the device reachable. A console that will not start is a device you can still reach | 1 |

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
| R-UI-08 | Compose every page from **one visual language, defined in one place**. A page that invents its own controls, spacing, type or colour is a defect in that page, not a variation | 2 |
| R-UI-09 | **Show a bounded quantity against its bounds.** A reading whose meaning depends on a limit — temperature, memory, disk, signal — is drawn against that limit with its caution band and its ceiling marked. A bare number for such a value is not a reading. **Which direction of the quantity is the bad one is stated, not assumed**: an instrument that assumes one direction draws a higher-is-better quantity backwards — a full bar for a dying link — and signal is named above | 2 |
| R-UI-10 | **Size a control to what it says.** No action occupies the full width of the surface it sits on, except below a viewport too narrow for anything else. A page has at most one primary action | 2 |
| R-UI-11 | **Show state as an indicator, not as coloured text.** The command-state tones reach the operator as a lit annunciator or an instrument mark, so state is legible without reading | 2 |
| R-UI-12 | **Drive a real browser over every page in both palettes on every build, and fail the build when a page changes shape unreviewed.** A console nobody looks at is a console nobody has checked. **A surface that hides part of itself is captured in each of those parts** — a page whose groups are tabs renders one tab at a time, and a page drawn from live state shows one state at a time, so capturing either once would quietly narrow "every page" to whichever part happens to be first. Both cases are the same case and neither is optional. **What is kept and compared is the geometry, not the picture.** A stored screenshot is per-platform pixels, is diffed by nobody, and is the wrong evidence anyway: the defect that provoked the legibility rule showed the words plainly at 1.05:1 against their own recess. The run's pictures are a build artifact for whoever is reviewing it, and the repository keeps none | 2 |
| R-UI-13 | **Generate interface material on the device.** Panel texture, instrument faces and indicator marks are drawn from stylesheet and vector rules, never shipped as raster assets, so they scale to any display and follow the palette without a second set of files | 3 |
| R-UI-14 | *Withdrawn — folded into R-UI-07.* A third mode was added for direct sunlight while day was a dark display at daylight brightness. Day is the chart now, which is what R-UI-07 and ADR-0005 asked for, so the third mode had nothing left to be | — |
| R-UI-15 | **A change that will revert is visible wherever the operator is, not only where it was made.** While a configuration change is in force and unconfirmed, every surface of the console shows that it is, how long remains before it reverts, and offers the means to revert it now — and the means to confirm it, except where the device is confirming for itself (R-CFG-11) and the banner says so instead. The confirmation timer is what makes the device unbrickable, and an operator who has navigated away from the page they changed something on is exactly the operator about to lose a working configuration to a timer they cannot see. The wording states the revert as the thing that recovers them, not as a threat | 1 |
| R-UI-16 | **Every piece of text on a control is legible against what is actually behind it, in both palettes, and the build measures it.** Not reviewed, not eyeballed in one palette — measured in a real browser, from the computed colour composited over the computed background with alpha and opacity folded in, because the failure this is for was a field label drawn by the interface framework at 60% black on a dark recess: correct by accident in day, unreadable at night, and present in every committed capture as a picture of an empty field. A control whose text falls below the threshold fails the build | 1 |
| R-UI-17 | **A field that edits a setting opens showing that setting.** An empty box on a configured device is a page giving two answers to one question — the readings above it say the device is on a value the form says is unset — and it makes an operator correcting one field retype the rest from memory. The seeded value is the **configured** one, never the one in use: the two differ while an apply is pending, and that difference is worth seeing rather than hiding. **A credential is the exception and is never seeded** (R-SEC-10): neither the value nor a reference to it goes into a form, and the field says only *whether* one is on file, so an operator can tell a stored credential from an absent one | 1 |
| R-UI-18 | **The device shows how to get back to it.** The console names the access point, its address and the name it answers to, on the page an operator looks at when something is wrong. **The access-point passphrase is shown only while it is the published default** — that value is deliberately public and is what makes a locked-out operator's way back in usable at all; one the operator has set is theirs, and the interface says it has been changed rather than printing it. **A device that cannot establish which passphrase its own access point is on says so**, rather than naming the published default at an operator for whom it will not work (R-SEC-01, R-SEC-10) | 2 |
| R-UI-19 | **The console an install produces is the console this project ships.** Every node type the shipped flows use is provided by a package the install path actually installs, and the build fails when one is not. A node that exists in this repository and is never installed is exactly as absent as one nobody wrote: it loads as an unknown type, the page it sits on is missing that control, and nothing reports an error anywhere. **The surface that photographs the pages is built from the same set the installer installs**, so a capture gate can never pass on a console no device receives | 1 |
| R-UI-20 | **What the console shows of a setting follows the setting.** A value read out of the configuration when the console started and never read again is a page asserting something the device may no longer be doing — and the reading most worth changing is the one least safe to misreport: an operator who opened MAVLink ingest (R-MAV-07) was still being told the board accepted it from itself alone. **The re-read is not on the operator's side and not on a button.** It is continuous, and it reaches a change whatever made it — this console, another client, or the rollback the device performs by itself when nobody confirms (R-CFG-03). **A field being typed into is not overwritten to achieve it:** the read repeats, the re-seed does not, so a form moves only when the setting under it moved. That is the same seeded value R-UI-17 requires, kept true afterwards rather than only at the moment the page opened | 1 |

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
