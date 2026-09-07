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

The separate protocol smoke command is
`node packages/yonder-core/scripts/vehicle-sitl-smoke.mjs --firmware-dir vendor/cockpit-sitl --output vendor/cockpit-sitl-smoke.json`.
That bounded smoke explicitly commands its own simulator, uses port 5764, records
ACK/observation evidence, and removes its container when finished.
