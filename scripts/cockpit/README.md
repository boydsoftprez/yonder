# Native cockpit previews

These previews use the production Vue widget, `VehicleService`, geographic data
services and console route adapters. They do not require the research Python
server. The installed console continues to use its normal authenticated session
and private MAVLink router connection.

## Geographic specimen

After `npm run build`, run `node scripts/cockpit/data-preview.mjs --public-data`.
Start the widget with
`COCKPIT_API=http://127.0.0.1:4194 npm run cockpit:dev -w node-red-dashboard-2-yonder`
and open `http://127.0.0.1:4192/?live=1`. Aircraft data is explicitly synthetic;
all aircraft writes are refused. The flag opts into public imagery/elevation and
ADS-B. Without it, external data remains disabled.

## Real ArduPlane SITL

Docker must be running. Supply an ignored firmware directory containing the
official Linux amd64 ArduPlane 4.7.1 executable and its matching plane defaults.
For example, from the repository root:

```sh
mkdir -p vendor/cockpit-sitl/bin
curl --fail --location https://firmware.ardupilot.org/Plane/stable-4.7.1/sitl/arduplane --output vendor/cockpit-sitl/bin/arduplane
curl --fail --location https://raw.githubusercontent.com/ArduPilot/ardupilot/dbe792162d06cab66c3475fd5556bf7a120f119e/Tools/autotest/models/plane.parm --output vendor/cockpit-sitl/plane.parm
chmod +x vendor/cockpit-sitl/bin/arduplane
npm run build
node scripts/cockpit/sitl-preview.mjs --firmware-dir vendor/cockpit-sitl --public-data
```

The script rejects files unless their SHA-256 values match:

| Input | SHA-256 |
| --- | --- |
| `bin/arduplane` | `1b6f6810016531f81a2ab240c1353aa7310334079b4c0954ecac8d17cf1adabe` |
| `plane.parm` | `93ba9a70c771609a90b81249d6a1d5a9df8d48bef7d149b42b2d9c7fbd06494a` |

Start the browser in another terminal:

```sh
COCKPIT_API=http://127.0.0.1:4195 npm run cockpit:dev -w node-red-dashboard-2-yonder -- --port 4193
```

For another isolated instance, use `--http-port 4201 --vehicle-port 5770` on
the SITL preview and point a separate Vite preview at that API, for example
`COCKPIT_API=http://127.0.0.1:4201 npm run cockpit:dev -w node-red-dashboard-2-yonder -- --port 4196`.
Ports must be free; the helper never reuses another simulator's state.

`--public-data` enables display source flags but leaves their route at **Ground**.
The aircraft server performs no automatic internet traffic or tile fetches in
that mode. Use the browser's **Display & data** controls to select sources,
preload detailed terrain into browser storage and adjust telemetry rate. See
[Ground geographic data](../../docs/cockpit-ground-data.md).

Open `http://127.0.0.1:4193/?live=1`. The header identifies **ArduPlane SITL**.
Use Aircraft to request flight telemetry and read the aircraft mission. Load the
Cove example into the local draft, review and confirm its upload, then explicitly
arm and start through Mission controls. Allow the autopilot's sensors to settle;
normal arming checks remain enabled. No startup, page read, reconnection or data
setting can initiate flight. See the [cockpit guide](../../docs/cockpit-user-guide.md)
for all controls and command limits.

The API binds only `127.0.0.1:4195`. A uniquely named, labeled Docker container
owns `127.0.0.1:5766` with fresh simulator storage and the pinned Ubuntu image from
the protocol smoke test. Ports in use cause a refusal. It never attaches to an
existing simulator or hardware; the original research ports remain separate.
Ctrl-C closes the service and removes only its own container and temporary storage.
Mission state in this disposable simulator is lost on exit; export local edits.

### QuadPlane vertical takeoff

For the VTOL preview, use the same verified ArduPlane executable with its upstream
QuadPlane physics model and defaults. Download the separate parameter file:

```sh
curl --fail --location https://raw.githubusercontent.com/ArduPilot/ardupilot/dbe792162d06cab66c3475fd5556bf7a120f119e/Tools/autotest/default_params/quadplane.parm --output vendor/cockpit-sitl/quadplane.parm
node scripts/cockpit/sitl-preview.mjs --firmware-dir vendor/cockpit-sitl --model quadplane --public-data
```

The QuadPlane defaults SHA-256 is
`3b736735829637583fcac4349d1dabc925dddb29dacf3cd023ddbf30587c24e9`.
The helper validates it before starting Docker. Omitting `--model` retains the
fixed-wing preview; it never changes another running instance or aircraft parameters.
The header identifies **ArduPlane QuadPlane SITL**. QLOITER appearing in the mode
list alone does not mean a simulator has a VTOL physics model or configuration.

Select **Display & data → Load VTOL cove example as local draft**. This variant
uses `NAV_VTOL_TAKEOFF` at **180 ft / 54.864 m**, followed by the original thirteen
geographic waypoints at **300 ft / 91.44 m**. Item 01 is takeoff; item 02 is the
first geographic waypoint. ArduPlane owns the transition; Yonder sends no timed
mode changes. The original cove example remains available unchanged.
Follow the [vertical takeoff walkthrough](../../docs/cockpit-user-guide.md#vertical-takeoff-in-the-quadplane-simulator).

The opt-in flight check uses a separate disposable QuadPlane on port 5778:

```sh
node packages/yonder-core/scripts/quadplane-sitl-smoke.mjs --firmware-dir vendor/cockpit-sitl --output vendor/quadplane-sitl-smoke.json
```

It uploads the same VTOL example, selects QLOITER, arms normally, requests mission
start once, and verifies vertical climb, takeoff completion near 180 ft, reported
multicopter/transition/fixed-wing states, climb toward 300 ft and waypoint progress.
It commands only its own uniquely labeled simulator and removes it afterward.

The separate protocol smoke command is
`node packages/yonder-core/scripts/vehicle-sitl-smoke.mjs --firmware-dir vendor/cockpit-sitl --output vendor/cockpit-sitl-smoke.json`.
That bounded smoke explicitly commands its own simulator, uses port 5764, records
ACK/observation evidence, and removes its container when finished.

## Passive synthetic-vision profiling

With an already-running preview, run:

```sh
COCKPIT_URL='http://127.0.0.1:4198/?live=1' COCKPIT_TERRAIN_RELAY=http://127.0.0.1:4205 node packages/node-red-dashboard-2-yonder/cockpit/profile.mjs
```

This opens a fresh browser context, streams terrain without full preload, waits
for warm-up and measures 15 seconds of frame cadence, actual terrain draws,
attitude changes, flight responses, geometry uploads and long tasks. Every
non-GET aircraft API request is blocked and reported. It never starts, moves or
resets an aircraft. Omit the relay variable to measure the configured fallback.
Results go to ignored `.cockpit-artifacts/synthetic-profile.json`; set
`COCKPIT_PROFILE_OUTPUT` to choose another output. On macOS the probe explicitly
uses Metal so it does not accidentally benchmark software rasterization. Avoid
running builds/tests during a timing comparison and report the GPU and viewport.
