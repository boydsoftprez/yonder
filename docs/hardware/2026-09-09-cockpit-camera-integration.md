# Shared Raspberry Pi camera and flight display integration

Requirements: R-UI-28, R-FLT-02/25/26, R-MAV-05/06/07 and R-CFG-03.

The operator requested using the camera development branch as the base and
bringing the native flight display to the same Raspberry Pi in parallel. The
integration starts from camera commit `fb0ac37` and merges cockpit `1c603c9`.
The camera task retains production core, console, media, pipeline and USB-helper
restart ownership until a coordinated handover. Its uncommitted driver edits
are not copied into the integration checkout.

## What can proceed in parallel

Local integration, builds, tests, isolated release staging and passive telemetry
inspection can proceed while the camera task uses the board. Runtime activation
is serialized: both features share one core and console, and no second daemon
may claim the USB gadget or controller serial endpoint. The existing router
remains the sole owner of the controller connection.

The two branches used the same page name for different interfaces. The integrated
flows preserve **Cockpit** at `/dashboard/cockpit` for the existing picture/aim
surface and add **Flight** at `/dashboard/flight` for the PFD/MFD. Both retain a
pending-change indication. Removed camera widgets are not resurrected as dangling
pending-banner destinations. Source selection and camera controls continue to
use the camera branch's existing wiring.

## Software evidence

- The complete package build passed, including the native flight-display bundle
  at 800.67 kB / 220.41 kB gzip.
- 3,586 core tests passed across 151 files. Dashboard tests: 876 passed. The six
  other workspace suites passed 355 tests in total.
- Two initial flow-integration findings were corrected: dangling retired camera
  banner targets and mixing the picture/aim and flight widgets on one page.
- A later host/process timeout affected a highly parallel test run; a complete
  repeat with at most four workers passed without unhandled errors.
- A real local daemon plus Node-RED/Dashboard fixture passed 75 HTTP/authentication
  checks. These use fixture hardware adapters and do not establish board behavior.
- A standalone production `npm ci` initially failed because the core lockfile did
  not contain `node-mavlink` and its dependency closure. The lockfile was updated;
  a clean production install and daemon-module import then passed.
- Initial native browser inspection could not proceed because its debugger session
  detached. No claim of a completed visual gate is made by these checks.

## Physical evidence and deployment boundary

Read-only SSH identified the selected device as a Raspberry Pi 4 Model B Rev 1.5,
aarch64, with the existing core and console running. The bundled Node runtime is
24.20.0; the system Node is 20.19.2. Deployment must retain the bundled runtime.
About 15 GB of storage was available at preflight.

Initially the configured ttyAMA0 controller link was silent. After the operator
connected the controller, the existing service found ArduPlane system 1 at 115200
baud and approximately 1 Hz heartbeat. A ground-station endpoint was answering.
No controller stream request, arm action, mission transfer or flight command was
sent by this task. This proves the physical router/link path, not yet the full
new cockpit decoder on the board.

The camera task reported active undervoltage during an earlier boot and held
runtime changes. After a subsequent operator reboot, `get_throttled` reported
`0x0`; its final USB-helper validation remains owned by that task. Its tested fix
must be incorporated by commit before activating the combined release. Staging
under a separate directory does not modify the installed camera or services.


## Final driver integration and staged hardware check

Camera head `073f8f1` was subsequently merged in integration commit `963e19c`.
Both native-AIO helper files are present and match the installed fix byte-for-byte.
The combined core then passed 3,589 tests across 151 files, and the two Python
helper suites passed 31 tests. The earlier 876 dashboard and 355 other workspace
tests remain applicable: the added driver commits do not change those packages.

An eight-second passive AF_PACKET copy of only the router's existing loopback
UDP destination 14559 collected 610 datagrams containing 18,782 MAVLink bytes.
The integrated VehicleService decoded that recording with a send callback that
rejects any transmission; its send count stayed zero. It reported ArduPlane
system/component 1/1, disarmed RTL, approximately −0.01° roll, −4.49° pitch, 45°
heading, 10.657 V battery and no GPS fix, with 100 instrumentation fields. These
are captured bench observations, not a claim of a continuously live deployed PFD.

The complete candidate was copied to a separate `cockpit-staging/963e19c`
directory under the device user's home. A manifest verifies every staged file,
and the daemon module graph loads with the board's bundled Node runtime. Only
the two helper files changed after the initial copy, so a small delta carried
the final USB fix. Installed service paths and configuration remain untouched.

After the USB validation, restart coordination was handed to the integration
task. The operator then requested a further bounded camera-workflow correction;
both tasks agreed to hold activation until that committed pass can be included.
The staged manifest explicitly carries that hold. Once incorporated, activation
must preserve at least 45 seconds of USB absence across the core restart and
restore the previously running preview. This is a scheduling boundary between
shared-service updates, not an incompatible hardware or software architecture.


## Activated combined runtime

Activation was released after validated camera workflow commit `55be6d5`. It was
merged into `46a6c55`, built and tested as one application: 3,592 core tests, 890
dashboard tests and 355 tests in the other workspaces passed. The native camera
picture/aim page remains **Cockpit**; the PFD/MFD is **Flight**.

The Pi was activated with rollback copies at
`/opt/yonder/backups/cockpit-20260909T173507Z`. Core and console were stopped,
the USB controller was confirmed not attached, and at least 45 seconds of USB
absence were retained before starting core. Config and secrets stayed byte-for-byte
unchanged. The previously running cam3 preview was restored through its normal
run endpoint, without moving the gimbal.

Observed after activation:

- Core PID 105058 and console PID 105234, both active with zero service restarts.
- MAVLink router PID 1032 and MediaMTX PID 771 stayed active throughout the update.
- Boot identity `c038c4dc-76b1-4867-b19f-457c4de76e1a`; no device reboot was required.
- cam3 reported running, no refusal, zero pipeline restarts and current camera
  metadata. The existing Camera browser showed advancing 1280×720 video and a
  fresh loaded thumbnail. No additional camera stream was opened for verification.
- The Flight API returned 200, connected and ready, with real disarmed ArduPlane
  telemetry, attitude/heading and battery readings. Aircraft operation count was
  zero. GPS fix was zero, so position-dependent features were not established.
- The existing authenticated browser opened Flight from navigation and rendered
  the PFD horizon, tapes and heading with the real MAVLink source.
- Unauthenticated `/session`, `/video/cam3/connection` and `/cockpit/api/flight`
  returned JSON 401 with `Cache-Control: no-store`. An independent authenticated
  cookie session returned 200/no-store for `/session` and the connection endpoint;
  the latter returned four receiver renderings. Credentials were not logged.
- Current power flags remained `0x0`.

The live receiver strings revealed one final display-only issue. Camera follow-up
`e7f1685` was merged into **`2577459`**, which is the final deployed source revision.
Its 74 Deck tests and bundle build passed. Only `ui-yonder-deck.umd.js` was replaced
atomically; core/console PIDs remained unchanged. The final installed manifest
matched all 2,460 staged file hashes, including both asynchronous USB helper files.
The core activation revision remains `46a6c55`; the final UI bundle belongs to
`2577459`. The camera task completed the final one-reload visual check on its existing
browser: all four connection values wrap without horizontal overflow, only the
three configured receiver renderings have Copy buttons, 1280×720 video continues
advancing and the thumbnail is fresh. The original Camera tab was left on preview.

On the selected Pi the console port is 3000. After normal sign-in, use
`/dashboard/flight` for the flight display, `/dashboard/camera` for the camera
workspace and `/dashboard/cockpit` for standalone picture/aim. Public geographic
sources remain ground-side by default. None of this bench validation establishes
an armed flight or camera-to-world calibration.


## Flight contrast and fullscreen follow-up

The live console's Day palette was inherited by the cockpit and applied light
button backgrounds behind white instrument labels. Follow-up `c9488af` defaults
the cockpit to its own dark palette, persists an explicit Day/Night choice in
the browser, and keeps instrument/data-field backgrounds dark in either mode.
It also adds Full screen / Exit full screen using the browser's element API.
Editors follow the fullscreen root rather than being hidden outside its subtree.

The regression checks failed before implementation. All 69 covering layout,
instrument and cockpit tests then passed, including retained PFD/map identity,
fullscreen rejection, palette restoration, and moving an open editor back to the
body after exit. The production Flight bundle built at 810.02 kB / 222.55 kB gzip.
Only `ui-yonder-cockpit.umd.js` was hot-replaced; its SHA-256 is
`19f5f5497146e39386e6a2362e86e20cdfe0a7a75476d03a31186719871a3dfb`.
Core PID 105058 and console PID 105234 remained unchanged, with NRestarts zero.
The live Chrome page was observed in element fullscreen with a dark cockpit,
readable instruments, the Exit full screen control, and no visible Dashboard
sidebar/header. No camera or telemetry service was restarted.

## Map position and ground traffic follow-up

The bench controller reported fresh fused coordinates `0,0`, GPS fix 0 and zero
satellites. The operator confirmed that no GPS module was connected. The earlier
map treated those coordinates as ownship and centered ocean imagery there;
traffic searched the same invalid aircraft location. Separately, direct ADSB.lol
responses returned HTTP 200 without browser CORS permission. Esri imagery
returned HTTP 200 with browser access allowed.

Follow-ups `c3c8596` and `4a2bfb3` require fresh GPS fix and coordinates for map
ownship, motion vectors and nearby traffic. The inset reports the missing GPS
condition, keeps a world/mission overview available and resumes following when a
fix arrives. A separate ADS-B relay origin preserves direct map/elevation sourcing
and geographic caches. Both relay origins remain browser settings; no flight
command is sent by configuring them.

All 30 targeted state, map-component, host and provider tests passed. They cover
no-fix suppression, acquired-fix recovery, stale fix metadata, relay isolation
and retained imagery cache. The production Flight bundle built at 812.37 kB /
223.04 kB gzip and was hot-replaced with SHA-256
`48bc723fd8027f38d7ffcaef0b5f76a049300c40d66cb7974f9a5d82c86e2787`.
Core PID 105058 and console PID 105234 remained active with zero restarts.

Chrome on the live hardware page decoded 12 imagery/label tiles, displayed the
missing-fix message and hid the invalid ownship marker. A laptop loopback relay
with the exact hardware console origin passed browser access; its ADS-B-only
address was saved in Chrome and the general relay address cleared. A separate
ground query of the documented Cove demo area returned one real target. That was
a provider connection check, not an aircraft-location test. Nearby live traffic,
terrain perspective and physical GPS recovery remain unverified until a GPS
receiver is connected and reports a fix. The ground relay must remain running on
the laptop; it is not an aircraft service or an installed background service.

## Attitude cadence and mission-read follow-up

Follow-up `9af9670` addresses two live usability failures. A ten-second Unix-socket
sample observed at least 6.2 distinct attitude updates/second at the Pi, while the
PFD's interpolator required a GPS pose and therefore stayed disabled on this
no-GPS bench. Browser reads also waited a full interval after completing each
response. The new 8 Hz default accounts for elapsed request time, remains
serialized and is saved when the operator selects a rate. The source button opens
the measured browser/attitude rates and explicit 10 Hz controller stream request.
A separate attitude-only buffer smooths the horizon without providing fictitious
coordinates to terrain or traffic.

The HTTP page also reproduced `crypto.randomUUID is not a function` when reading
the mission. Request IDs now use the browser's secure random byte generator when
`randomUUID` is unavailable; authenticated session provenance and changing-command
review are unchanged. The [browser API documents HTTP availability of
getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues).
Mission controls now include Read aircraft mission beside Upload, preserve the
draft, and distinguish missing readback from completed readback without home.

All 39 targeted component, cadence, compact API, pose and mission-boundary tests
passed. The build is 818.44 kB / 224.96 kB gzip. The installed Flight bundle hash is
`325f5a90ae56f48c37a6476a347b230758eea8da7d63e640994e7fc3e95692e8`.
Core PID 105058 and console PID 105234 remained active with zero restarts.

In Chrome, the new default was visible and roughly 6–7 distinct attitude updates
per second were observed under the current link/browser load. One mission read
completed and verified an empty controller mission with no reported home. One
explicit stream setup was accepted, including ATTITUDE at 10 Hz; 15 optional
instrumentation requests were unavailable and were reported separately. The
controller remained RTL/disarmed. No mission upload, arm, mode, target or start
command was sent. Loading the Cove example as a local draft showed the new
home-unavailable explanation and disabled upload until the controller provides
the required home record. Physical flight and GPS recovery remain untested.

## Home workflow activation and camera recovery

Home implementation `d77406f` and clarification `068d63c` add local planning-home
editing, map placement, MSL elevation in feet/metres, Undo, copying reported home,
and a separate confirmed controller-home command with matching readback. The
[behavior reference](../console/evidence/2026-09-09-home-workflow.md) records the
Mission Planner PLAN/DATA distinction and pinned ArduPlane handling.
The [disposable SITL results](../console/evidence/2026-09-09-home-sitl.json) verify
manual home, first mission upload and a subsequent home update with GPS both off
and on, without arming or flying. Core MAVLink/cockpit tests: 383 passed. Targeted
Home/UI tests: 36 passed. The final Flight bundle is 836.85 kB / 229.77 kB gzip,
SHA-256 `39f81ccecba38af17c2ff2896a1275bdcd9e970b314ef715391105112cea639a`.

During local development the board rebooted externally. It returned with boot ID
`8de40ee9-5ff0-422a-a9d1-c0f7e7c98d3d`, and the operator connected Ethernet during
activation. The network task observed Ethernet address `10.0.252.246`, default
route metric 100, and a direct LAN ZeroTier path to the Mac with roughly 8 ms
latency. Subsequent video checks therefore describe wired acceptance, not proof
that the previous LTE delivery problem was fixed.

Combined activation `54f3528` included camera change `9644f06`. Five artifacts were
installed after 45.04 seconds of continuous USB absence, preserving config and
secrets. The initial camera running state did not persist: the full production
graph repeatedly exited. A confirmed preview startup-rate adjustment to 500 kb/s
did not resolve it. The camera task withdrew that encoder change in `ac04051`;
the source rollback was merged as **`293fc31`**.

Recovery restored only `dist/video/pipeline.js` to the prior verified hash
`4db643799ffbd13606b0c209bbfde1df2205f2a0458e9a849f32b4280c2ea773`. All Home files
remained installed. Another 45.04-second USB absence was preserved, then cam3
returned to running with zero restarts and stayed at the same run identity for
32 seconds before the recovery receipt. Core PID became 59552; console 779,
MAVLink router 1038 and MediaMTX 775 stayed running. The current main Fixed
2000 kb/s and preview Adaptive startup 500 kb/s configuration and secrets were
unchanged during recovery. Camera-specific investigation and acceptance are
recorded in [the video delivery report](qgroundcontrol-video-delivery-2026-09-09.md).

The live Flight page opened **Mission controls → Home…**, showed empty planning
fields and no reported controller home, and offered the new reviewed controller
action. The controller was connected, MANUAL and disarmed; its operation count
remained zero. No physical home, mission-upload, arm, mode or start command was
sent during this activation. The final installed manifest is at source
`293fc31`; the rejected CBR artifact must not be included in a subsequent build.

The camera task subsequently observed 96 seconds at the same run identity with
zero restarts and stable USB generation. Existing local RTSP output measured
30.31 fps and 2034.9 kb/s; kernel VBR mode 0 and the 2000000-bit/s target were
confirmed. Power flags were `0x0`. QGroundControl was on its settings page during
that interval, so the local output measurement is not an active QGroundControl
delivery test. The camera task released the core-recovery hold for the separately
coordinated network/diagnostics activation.
