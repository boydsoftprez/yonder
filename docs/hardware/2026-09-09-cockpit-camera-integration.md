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
