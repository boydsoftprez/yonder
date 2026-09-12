# Cockpit guide screenshots

These are instructional images linked by [Using the Yonder cockpit](../../cockpit-user-guide.md).
They are deliberately committed so the guide works from a clone or a repository browser.
The normal visual gate's captures remain ignored artifacts; these are not pixel baselines.

The production Vue widget supplies every image. Most use **SYNTHETIC FIXTURE**
telemetry and an in-memory command collector. The `cockpit-*.png` images show the
configurable production instruments and layouts using demonstration readings:

| Image | Surface |
| --- | --- |
| `cockpit-main.png` | Default single PFD, top fields, graphical bank and mission/map insets |
| `cockpit-layout.png` | Display setup: arrangement, bank placement, navigation fields and units |
| `cockpit-fields.png` | Navigation-field source and presentation editor |
| `cockpit-instruments.png` | Graphical instrument editor with local scale and color bands |
| `cockpit-systems.png` | Grouped telemetry catalog and category/search controls |
| `cockpit-telemetry.png` | Source inspector, provenance, pinning and recent numeric history |
| `cockpit-split.png` | Optional PFD beside MFD arrangement |
| `cockpit-stacked.png` | Optional PFD above MFD arrangement |
| `camera-full.png` | R-FLT-29/K-68: a fixture camera filling the PFD's attitude scene, instruments over it, the attitude line drawn over the picture |
| `camera-full-day.png` | The same full state in the day palette |
| `camera-window.png` | The camera's other form: a small window at its top-left home, synthetic terrain filling the scene behind it |
| `camera-window-tablet.png` | The camera window at tablet size (768×1024) |

These examples demonstrate local display configuration. A selected source is not
proof that its sensor exists, and example display bands are not aircraft limits.
The guide distinguishes the header's device **Systems ›** link from the MFD's
telemetry **Systems** page. **Layout** is labeled **Display setup** for assistive
technology; **Fields** and **Instruments** open configuration, while a reading
opens inspection.

`terrain-overview.png` and
`terrain-profile.png` use that same synthetic aircraft with the repository's
actual surveyed USGS 2016 Cove terrain pack. They have no live satellite or ADS-B
feed. `telemetry-setup.png` and `start-aircraft-mission.png` are from a separate,
disposable **ArduPlane 4.7.1 QuadPlane SITL** using the native command service.
No picture establishes physical flight, camera calibration or provider availability.
The images contain demonstration state, with no physical-board login or credentials.

`manifest.json` records filenames, provenance groups, byte counts and hashes.
Captures include full laptop/tablet viewports and visible dialogs cropped by
Playwright itself. The terrain specimens and `cockpit-*.png` set use the current native cockpit;
the layout set also demonstrates configurable placement controls.
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

To reproduce the configurable layout set, run:

```sh
npm run cockpit:guide:layouts -w node-red-dashboard-2-yonder
```

It uses the fixture preview and `COCKPIT_URL` (default port 4192). An optional
loopback `ground` query parameter supplies the prepared terrain relay, as in the
fixture harness. It configures example battery display bands through the actual
editor, captures the eight layout images and verifies source/style editing,
pinning, saved settings, notices and tablet layouts. Output goes to
`packages/node-red-dashboard-2-yonder/.cockpit-artifacts/layout-guide/`.
Keep **SYNTHETIC FIXTURE** visible in captures; these example bands are not
calibrated aircraft limits. Inspect and promote the selected PNGs into this
folder, then update `manifest.json`.

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
state separately. Wait for the fresh simulator's EKF3 and GPS readiness before
arming; normal autopilot prearm checks remain enabled. It finishes in RTL and
writes `guide-sitl/` artifacts. It does not
land/disarm or stop the launcher for you: stop that launcher's terminal with
Ctrl-C to remove only its owned simulator, then stop its browser host. A failed
walkthrough likewise requires stopping that disposable launcher before a fresh run.

The [verification record](../../console/evidence/2026-09-08-cockpit-telemetry-layouts.md)
describes the observed results and remaining limits.
