# Cockpit guide screenshots

These are instructional images linked by [Using the Yonder cockpit](../../cockpit-user-guide.md).
They are deliberately committed so the guide works from a clone or a repository browser.
The normal visual gate's captures remain ignored artifacts; these are not pixel baselines.

The production Vue widget supplies every image. Most use **SYNTHETIC FIXTURE**
telemetry and an in-memory command collector. `terrain-overview.png` and
`terrain-profile.png` use that same synthetic aircraft with the repository's
actual surveyed USGS 2016 Cove terrain pack. They have no live satellite or ADS-B
feed. `telemetry-setup.png` and `start-aircraft-mission.png` are from a separate,
disposable **ArduPlane 4.7.1 QuadPlane SITL** using the native command service.
No picture establishes physical flight, camera calibration or provider availability.
The images contain demonstration state, with no physical-board login or credentials.

`manifest.json` records their filenames, provenance groups, byte counts and hashes.
Captures are 1280×900 viewports or the visible dialog cropped by Playwright itself.
The two loiter-editor captures show the top and scrolled bottom of the same form.
Captions identify the source and controls; no markings were painted onto the UI.

## Regenerate and verify

From the repository root, start the fixture:

```sh
npm run cockpit:dev -w node-red-dashboard-2-yonder
```

Then run:

```sh
npm run cockpit:guide -w node-red-dashboard-2-yonder
npm run cockpit:verify -w node-red-dashboard-2-yonder
```

`cockpit:guide` uses `COCKPIT_URL` or loopback port 4192. It rejects a live-mode URL
and blocks aircraft HTTP. Its terrain phase starts/stops its own ground-only
relay, refuses external providers and verifies the native terrain package and
offline browser reuse. Generated PNGs and result JSON go into
`packages/node-red-dashboard-2-yonder/.cockpit-artifacts/guide/`.
Only the images actually embedded in the guide belong in this directory. Inspect
new images before copying them and updating their hashes in `manifest.json`.

## Disposable simulator walkthrough

Use the pinned files and acquisition instructions in
[Native cockpit previews](../../../scripts/cockpit/README.md#quadplane-vertical-takeoff).
Start a **new** QuadPlane with separate free ports, for example API 4211 and
vehicle 5782, and a separate browser host on 4209:

```sh
node scripts/cockpit/sitl-preview.mjs --firmware-dir vendor/cockpit-sitl --model quadplane --http-port 4211 --vehicle-port 5782
COCKPIT_API=http://127.0.0.1:4211 npm run cockpit:dev -w node-red-dashboard-2-yonder -- --port 4209
```

Those are long-running commands for separate terminals. In another terminal:

```sh
COCKPIT_GUIDE_SITL_URL=http://127.0.0.1:4209 npm run cockpit:guide:sitl -w node-red-dashboard-2-yonder -- --allow-disposable-sitl-commands
```

This opt-in test **uploads a mission, arms and flies the disposable simulator**.
It checks the QuadPlane SITL source, loopback address, disarmed initial state and
absence of authored mission items. It makes each request through the visible
cockpit controls, including the separate confirmation. It records ACK and observed
state separately, finishes in RTL and writes `guide-sitl/` artifacts. It does not
land/disarm or stop the launcher for you: stop that launcher's terminal with
Ctrl-C to remove only its owned simulator, then stop its browser host. A failed
walkthrough likewise requires stopping that disposable launcher before a fresh run.

The [verification record](../../console/evidence/2026-09-08-cockpit-guide.md)
describes the observed results and remaining limits.
