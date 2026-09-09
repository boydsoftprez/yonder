# Cockpit surface integration audit

Audit base: `0f1e9b9`. Scope: the production Vue dashboard, camera/video integration,
the approved display intent, the supplied authored prototype, and the existing
fixture/browser gates. This is a source and reference-image audit. It does not
claim a running production cockpit, a new browser verification, or hardware proof.
No production files or hardware were changed for this audit.

## Approved result and current gap

The default flying surface is one full-viewport primary flight display on a
tablet or laptop. Translucent airspeed and altitude tapes, VSI, HSI and flight
director cues sit over synthetic terrain or the fixed forward camera. A mission
inset occupies the lower left; a hybrid map with traffic occupies the lower right.
Tapping an inset expands its content into a split view that keeps the PFD visible.
Touching an instrument opens relevant instrument or autopilot controls. Mission
controls are contextual. Systems and camera settings remain accessible.

There is **no production cockpit component, flight-instrument composition, map,
mission UI or airborne-traffic UI at this commit**. `YonderDeck.vue` is the camera
control deck. Its name must not be mistaken for an existing flight deck. Comments
about embedding the picture in a future Cockpit describe an intended consumer,
not a consumer present in the package or shipped flows.

The supplied prototype provides substantial authored behavior to migrate, but its
default split layout and fixed PFD composition do not themselves implement the
approved single-display result. This work is both integration and a new responsive
composition, not merely adding a route to the existing prototype.

## Existing production interfaces

| Area | Source and present behavior | Integration implication |
|---|---|---|
| Dashboard shell | `flows/flows.json`: `/dashboard`, fixed navigation and a page header. Seven pages: Status, Network, Cameras, Camera, Telemetry, Log, Diagnostics. Network uses tabs; other pages use grid layout. | Add a cockpit page and entry/default navigation deliberately. Scope full-viewport shell treatment to the cockpit; retain access to every existing systems page. |
| Widget discovery | `packages/node-red-dashboard-2-yonder/package.json`, `src/widget.ts`, `src/deck.ts`, `scripts/build-widgets.mjs`, `vite.config.js`. Dashboard discovers a registered node and a manifest entry; one UMD bundle is built per widget into `resources/`. | A new `ui-yonder-cockpit` requires node registration, editor definition, package manifests and flow wiring. Vue remains external, supplied by Dashboard. A second Vue instance is unsupported. |
| Widget data/actions | Components receive `id`, editor `props`, `state`; live payload is `this.$store.state.data.messages[id].payload`. `registerWidget()` sets `passthru: false`; actionable widgets must set `emitsActions: true`. Actions leave as `$socket.emit('widget-action', id, { payload })`. | Use one cockpit adapter boundary and ordinary child props/events within it. A telemetry input must never echo as a command. A visible action without `onAction` registration is silently dropped by Dashboard. |
| Browser-safe shared logic | `packages/yonder-core/src/console/presentation.ts` exports pure presentation functions/types without machine dependencies. The full `yonder-core` entry imports Node/device code. | Put shared flight-state interpretation, validity, unit conversion and navigation math behind a browser-safe entry. Do not import daemon code into Vue or put calculations into flow function nodes. |
| State vocabulary | `console/command.ts`: `idle`, `pending`, `confirmed`, `rejected`, with message, time and optional expiry. Existing annunciator, picker, segmented, set-bar and text-field components share theme tokens. | Reuse controls and command-state language. Vehicle-command progress and actual autopilot/readback results need an explicit contract; configuration acceptance alone is not aircraft acceptance. |
| Current telemetry UI | `node-red-contrib-yonder-mavlink/src/state.ts` draws link/heartbeat/port/router/endpoint status from `/mav/state`; `yonder-core/src/mav/link.ts` tracks link and network rates. | This payload is not flight telemetry. Attitude, speeds, positions, altitude datums, FD, guidance, mission, traffic and autopilot commands need production data paths. The existing Telemetry systems page remains useful. |
| Existing `YonderTape` | `src/ui/YonderTape.vue` draws a bounded vertical scale, fill, bug and boxed value using `reading()`. | It is not the moving graduated IAS/altitude tape in the approved PFD. Reuse vocabulary and bounds logic where appropriate; do not claim the flight tape already exists. |
| Theme/sizing | `yonder-core/src/console/theme.ts` generates day/night CSS; `src/ui/tokens.css` supplies fallbacks. Dashboard's current header, drawer, group padding and grid consume viewport area. | The cockpit needs viewport-aware sizing, safe-area handling and a page-specific shell state. Styles must restore on systems navigation. First paint and palette persistence remain governed by the existing theme renderer. |
| Global configuration state | R-UI-15 requires pending apply/revert state on every surface. Existing systems routes provide recovery and configuration controls. | Full-screen composition must preserve the global rollback indication and actions, including while an instrument panel or inset is open. |

### Camera and WebRTC seam

`src/ui/YonderPicture.vue` already owns authenticated WebRTC playback and the
failure behavior that a cockpit needs:

- It defaults to the `<camera>-preview` stream; a full-rate request is explicit.
- `POST /video/<path>/whep` negotiates through the console session. The media
  server listener remains behind `console/whep.ts` and the console middleware.
- The `x-yonder-viewer` response identifies the viewer. Once per second it sends
  measured reception/frame information to `/video/<path>/report` for the existing
  preview machinery.
- It ages actual displayed media, desaturates/dims/hatches a stale picture, shows
  age/reason, reconnects with backoff, and supports live/stills/off modes.
- It aborts superseded handshakes and removes timers, listeners and peer sessions
  on unmount. Existing tests cover canceled negotiations, reporting and reconnects.
- The richer report can include preview state, recorder/saved state, live control
  foot readings, cameras/downlink and aim. It reads live message fields, retained
  fields, then `props.report` as fallback. The media path itself comes from the
  message or `props.path`, not `props.report`.

The current template is a camera-shaped, aspect-ratio-preserving frame with
picture HUD, overlays and an optional thumbnail strip. It is not a viewport
backdrop. A parent also cannot safely hand it the cockpit's complete payload under
the same widget id and assume its `command` computed will find nested video data.

Recommended integration: introduce a supported embedded report/input seam and a
camera-backdrop presentation mode, or extract the existing receiver lifecycle into
one shared module used by the camera page and cockpit. Keep a single active
receiver while an inset expands; expanding a map must not renegotiate video or
create another subscription. Keep the original camera-page fit behavior intact.
The fixed forward camera must not inherit drag-to-slew behavior. Camera selection
must come from a configured/detected identity, not the fixture's literal camera id.

The backdrop also needs a declared fit/projection rule. A full viewport and an
arbitrary camera aspect ratio cannot be made identical by stretching the image.
Preserve the image shape, state any crop, and keep the PFD's center/projection
consistent with the displayed camera image. The prototype has no live-video
registration or camera calibration contract to import.

## Supplied prototype: reusable pieces and boundaries

The following module names identify inspected input material. This table states
their responsibilities here so implementation does not depend on an external
working directory or research server.

| Inspected module | Useful behavior | Work required for production |
|---|---|---|
| `pfd.js`, `pfd-state.mjs` | Vue/SVG horizon, roll/pitch ladder, moving IAS/altitude tapes, nonlinear labeled VSI, HSI, validity blanking. | Convert to packaged Vue components; replace `/vue.js` imports with Dashboard's Vue; make dimensions responsive. Existing SVG uses a 640×650 viewBox and fixed screen positions, which cannot simply stretch across a laptop while preserving instrument shape. Scope SVG definition ids if more than one instance can exist. |
| `pfd-controls.mjs`, `pfd-control-panel.js` | Touch keypad, validated local reference bugs, tape/HSI opacity, FD visibility/style and instrument strip choices. FD uses received desired pitch/roll; reference bugs are local display references. | Bind to the production state contract and shared controls/tokens. Separate local display editing from actual autopilot target requests. The prototype's default `layout: 'split'` must become the approved full PFD with insets; old saved layout preferences must not silently override that change. |
| `presentation-pose.mjs` | Shared, delayed interpolation of pose for attitude/terrain/traffic; numeric measurements and validity remain authoritative. | Preserve shared timebase and stale cutoff. Clean up animation frames. Do not smooth stale measurements into valid flight data. |
| `terrain.js`, `terrain-state.mjs` | WebGL elevation mesh, imagery, projection/terrain math, context-loss recovery, visible failure status and conventional-horizon fallback. | Package source and source metadata; replace hard-coded public fetches with the production tile-source contract. Make availability an input and validate sizing, high DPI, orientation changes, canvas limits and context recovery. Terrain datum/projection is part of the data contract. |
| `navigation.mjs`, mission import/edit/command metadata modules | Mission fidelity, altitude-frame naming, active guidance, local draft vs vehicle mission, cross-track and radial interpretation. | Isolate pure logic; remove reliance on unscoped global `WT` objects or package the exact approved dependency with provenance/license. Replace synthetic/source-name checks with explicit production source/autopilot validity fields. Shared PFD/map guidance must remain one calculation. |
| `map.js` | Leaflet map, grid/satellite/hybrid layers, mission markers, current path, track, track-up, zoom and touch map picking. | Package pinned dependencies and CSS; replace global `L`; replace fixed demo coordinates and public URLs; add complete destruction of map, ResizeObserver, DOM listeners and hold timers. Inset expansion needs `invalidateSize()` while preserving center, range, selection and mission edit state. |
| `traffic-state.mjs`, `traffic-map.js`, `traffic-view.js`, `traffic-panel.js` | Shared range filtering, selection, labels, trails, stale/expiry logic and projected PFD targets. | Feed both views from one production track store and source health state. Do not label an empty or failed feed as clear airspace. Preserve selected target and filters through expansion. |
| `mission-touch.js`, `mission-controller.js`, `mission-control-client.mjs` | Context menus, draft edit/undo/export, mission transfer/readback workflow, busy state and non-retried command requests. | Replace `/api/sitl/*` and `/api/state` with authenticated production adapters. Keep drafts after a failed transfer or refresh. Backend must supply capability/acceptance/readback states; controls must not claim to set targets that remain only local references. |
| `app.js`, `runtime.js`, `index.html` | Research host assembly, separate app creation, globals, local storage, polling and EventSource. | Do not ship this host. It starts another Vue app, depends on research APIs and global host shims, and owns timers not structured for Dashboard page unmount/remount. Create a native widget composition and lifecycle instead. |

No Python research server, simulator-start command, external checkout path, runtime
`/vue.js`, or research `/api/demo`/`/api/sitl` route belongs in the production
surface. If approved third-party code is retained, copy only the required source
with its license, version, provenance and offline build dependencies into the
repository. The authored PFD can be migrated independently of legacy button or
simulator-host classes; normal Yonder controls can supply its touch UI.

## Layout and interaction work still absent

| Approved element | Required production behavior and verification |
|---|---|
| Full PFD default | Fill available browser viewport immediately after cockpit entry. Remove persistent dashboard chrome only for this surface; provide an obvious Systems exit. No required vertical/horizontal scrolling at the supported tablet/laptop sizes. |
| Background choice | Operator can choose synthetic terrain or the fixed forward camera. Keep instruments above either and expose source availability, age and fallback. Missing camera, lost media, unavailable terrain and no WebGL are distinct visible states. |
| Translucent instruments | IAS, altitude, VSI, HSI, pitch/roll and FD remain readable over both bright/dark image content in both palettes. Anchor instruments independently of the scene aspect ratio. A single scaled SVG panel is insufficient as the full-width composition. |
| Mission inset, lower left | Readable active item/mission context and explicit tap to expand; retain received mission state separately from a local draft. Empty, loading, stale, unsupported and failed transfer states need specimens. |
| Hybrid map/traffic inset, lower right | Aircraft heading, route/active guidance, range, traffic and feed health remain visible. Expansion offers layers, zoom, follow/orientation, traffic selection/range and mission location controls. |
| Split expansion | PFD remains visible and useful while either inset expands. Collapse restores the default composition. Resizing must not remount the receiver, reset map position, lose selection/draft or change commands. |
| Touch contextual controls | Tapes, VSI, HSI, attitude/FD and mode/AP area open the relevant controls. Transparent SVG regions must not steal map/video gestures. Set minimum touch targets, keyboard activation, focus trap/return, escape/cancel and on-screen-keyboard fit. |
| Autopilot actions | Clearly distinguish measured value, local reference and requested aircraft target. Send only explicit operator actions, obtain required hazardous-command confirmation, show pending/accepted/rejected/unknown result and support advertised capabilities. Opening, canceling, resizing and fresh telemetry emit no commands. |
| Systems and camera settings | Preserve Status, Network, Cameras, Camera Live/Setup, Telemetry, Log and Diagnostics. Keep existing capability-driven controls, stream/preview drafts and apply/rollback behavior. The cockpit is not a reason to remove any blueprint element. |

The current blueprint manifest is a historical camera-surface audit. Its old
absence claims are not a substitute for checking current code: several richer
picture/report pieces now exist. It also has no complete single-PFD checklist.
The approved camera render was inspected beside the supplied PFD reference: the
camera render has its picture, aim surface and full configuration deck; the PFD
reference has the flight symbology and terrain, but not the newly approved two
insets/default composition. Add the cockpit's checkable rows and current captures
to the manifest, and preserve the camera/settings rows during integration.

## Data and requirement decisions to record

Before implementation is called complete, record a typed contract for source
identity and sample times; per-field availability/freshness; roll/pitch/heading
and heading datum; airspeed/groundspeed/VSI; barometric, GPS/MSL, relative-home
and estimated-terrain altitudes; mode/arm/energy/GPS status; FD desired attitude;
received mission, active item and guidance; local draft; traffic source/tracks;
camera identity and view status; command capabilities and results. Store missing
values as unavailable, not plausible zeroes. View interpolation must not change
the contract's validity.

Existing R-TEL-01…14, R-CMD-01…09, R-UI-01/04…16/19/20/22 and R-CFG-03 cover
much of the foundation. The newly approved persistent PFD, specific inset/split
behavior, synthetic terrain, traffic and contextual AP/mission interaction need
explicit requirement and blueprint traceability. R-TEL-13/14's older fullscreen
and swap language should be reconciled with the approval that keeps the PFD
visible; do not silently implement the old replacement-pane behavior.

The prototype's map/terrain directly fetch public tile services, and its traffic
data comes through a research service. At this audit base R-SEC-06 prohibits
external services and R-UI-01 prohibits runtime internet assets. The operator's
source allowance now permits optional map, terrain and airborne-traffic network
data; the coordinating implementation will narrow those requirements accordingly.
Keep executable code, fonts and UI assets packaged locally, with no runtime CDN
or phone-home. Implement an explicit opt-in data-source contract and preserve
source health, attribution and unavailable states. A grid fallback alone does
not satisfy the requested hybrid map; an unowned deferral is not completion.

The fixed forward ELP camera is the approved camera source. A direct component
props transport seam is recommended for both the cockpit and its embedded
picture: production and fixture adapters supply the same typed snapshot instead
of the display knowing any research host URL. The coordinating implementation
owns the new service snapshot contracts, console routes/middleware, flow wiring
and shared requirements; the cockpit work can own the Vue composition and its
fixture harness without editing those shared integration files concurrently.

## Migration sequence

1. Add the approved cockpit requirements/manifest and a source/field/command
   contract. Distinguish production availability from offline fixture replay.
2. Add the cockpit widget registration and a minimal production page that consumes
   a fixture through the actual adapter seam. Establish viewport sizing, palette,
   pending-apply visibility and Systems navigation before migrating instruments.
3. Port pure PFD/navigation/terrain/traffic/mission helpers with provenance and
   shared type/unit/freshness tests. Bundle browser dependencies offline.
4. Build the full-screen PFD composition and inset/split state in native Vue.
   Keep long-lived media/map/state owners above layout transitions.
5. Integrate the existing receiver through the supported embedded seam; validate
   both its original camera-page behavior and the new backdrop behavior.
6. Connect production telemetry, mission/traffic/tile sources and explicit
   command adapters. Add touch contextual workflows without making local bugs
   aircraft commands or allowing telemetry to emit actions.
7. Extend capture coverage for every inset, split view, drawer/dialog, source,
   palette, supported viewport and relevant unavailable/stale state. Review the
   actual current display beside the updated blueprint and close every row with
   evidence or an explicitly named owner.

## Verification entry points and needed extensions

Existing commands, from the repository root:

```sh
npm run test -w node-red-dashboard-2-yonder
npm run test -w node-red-contrib-yonder-mavlink
npm run test -w node-red-contrib-yonder-video
npm run test -w yonder-core
npm run build
npm run lint
node scripts/measure-page.test.mjs
./scripts/verify-pages.sh
```

`verify-pages.sh` requires Node 22.12+, curl, built packages, Playwright/Chromium,
and the staged `vendor/console` tree containing the installed Node-RED and
Dashboard. It starts a temporary daemon and console with stand-ins for hardware
services and uses `scripts/pages-daemon.mjs` for fixtures. `PORT` can select an
isolated loopback port. `HOLD=1` retains the running fixture console for manual
browser inspection and prints its URL and test credentials; `KEEP=1` preserves
its temporary tree. Capture artifacts go under `vendor/capture` and geometry
baselines under `docs/console/shape`. Deliberate baseline changes are accepted
only after inspection with `ACCEPT_SHAPE=1 ./scripts/verify-pages.sh`.

The capture CLI is `node scripts/capture-pages.mjs --base-url URL --password PW
--palette day`; it also accepts `--viewport 1440x900 --fold`, an individual page,
artifact directory and synthetic-camera fixture. It discovers pages/tabs from
the shipped flows and certain deck states from group classes. It **will not
discover arbitrary new cockpit inset expansions or contextual dialogs**. Add
an explicit cockpit state matrix instead of capturing only the initial page.

The shipped component gallery can provide fast isolated visual iteration:

```sh
npm run gallery -w node-red-dashboard-2-yonder
npx vite --config packages/node-red-dashboard-2-yonder/gallery/vite.config.mjs
```

The gallery is not a substitute for the installed Dashboard page, authenticated
media routes, flow action registration or full shell behavior.

New meaningful checks should cover:

- Unit/data: per-field stale/missing/invalid behavior, heading wrapping, attitude
  sign, units and altitude datums, nonlinear VSI, FD source validity, shared CDI
  direction, mission sequence remapping/draft isolation, traffic expiry/range,
  terrain projection and interpolation cutoff.
- Vue/action: default single PFD; inset expand/collapse retaining PFD; local
  settings never posting aircraft commands; cancel/refresh/resize remaining
  silent; explicit commands and readback states; capability gating; focus and
  pointer routing; lifecycle cleanup.
- Video regressions: existing `picture.component.test.ts` and deck suite, plus
  backdrop fitting, source switching, lost/stale frames, canceled handshakes,
  one receiver across layout changes, and fixed-camera gestures.
- Browser: laptop 1440×900 and 1280×800, tablet landscape 1024×768 and portrait
  768×1024, both palettes; initial PFD, each expanded inset, each contextual
  panel, both backgrounds and failure/empty states. Confirm actual instrument
  readability over bright and dark scene fixtures, not only CSS background
  contrast. A real canvas/video pixel is not accounted for by ordinary DOM
  alpha-compositing checks.
- Integration: package/widget discovery and resources load; authenticated
  telemetry/mission/video/tile/traffic adapters; Systems round trip; pending
  configuration banner; no prohibited external request; no research endpoints
  or fixture values in the production path.

No build/test/browser command above was executed by this read-only audit. Existing
prototype verification reports are useful regression inventories, not evidence
that the production Dashboard integration passes. The parent implementation must
run current checks and inspect current captures before completion claims.
