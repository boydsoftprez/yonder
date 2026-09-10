# Single-screen flight cockpit

Approved scope, 2026-09-07. Base: `claude/exciting-merkle-e4cd39`,
`0f1e9b92485a7f4e23c7d75a6e2fde195124a2ca`.

## Screen and controls

The default is one full PFD: translucent airspeed/altitude tapes, measured VSI,
attitude, flight director, HSI, active aircraft mode and mission status. Lower-left
mission and lower-right hybrid-map insets expand on touch into a pane beside the
still-visible PFD. Instrument taps open contextual controls. Mouse and touch share
the interaction; landscape tablet/notebook layouts fit the viewport, and narrow
layouts show one selectable inset without shrinking controls. Both palettes and
existing systems/camera pages remain available.

Background choices are terrain, camera, and camera with terrain overlays. The first
camera is a fixed forward-facing ELP USBGS1200P01-H120. Its actual lens, mounting,
crop/rotation and capture-time relationship need calibration. Screen-fixed flight
readings remain available without calibration; registered scene overlays require
valid camera geometry, height reference and frame-time pose. Stale video/telemetry
are independently visible. Any fallback names the source it is displaying.

## Flight execution

Yonder relays only explicit operator commands. Every aircraft-changing action has
an authenticated session, review and distinct confirmation. The autopilot retains
validation, sequencing, turns and execution. There are no browser control loops,
automatic mode changes or reactions to terrain, camera, link or battery state.

Production telemetry/commands use the MAVLink router's loopback connection. Mission
Planner remains an optional routed GCS; a separate loopback SITL connection provides
development evidence. Raw GCS traffic never depends on the browser or control plane.

The telemetry model includes field ages, attitude, measured vertical speed,
air/ground speed, separate altitude references, HOME, current mission sequence,
navigation-controller output, GUIDED target and actual arm/mode state. Straight-leg
CDI and GUIDED loiter radial error remain distinct. Desired attitude comes from the
autopilot. Local references never present themselves as confirmed aircraft targets.

Mission import/export supports WPL/QGC plans and an explicitly selected cove demo.
Local draft and aircraft mission are separate. Upload performs the mission handshake
and readback, with vehicle and mission revision guards. The Plane catalog carries
55 parameterized forms with capability limits. Waypoint/map selection offers edit,
fly-to and loiter actions with explicit MSL/HOME/terrain altitude references.
Terrain-relative commands require actual autopilot/data support; no datum is silently
substituted. Outcomes distinguish pending, accepted, observed, rejected and unknown;
timeouts and reconnects neither claim rejection nor repeat actuation.

ETE is distinct from turn anticipation. Time/distance track vectors use measured
motion, with curved short-time prediction when turn-rate data is available. Estimated
turn cues are labeled as estimates, not asserted to be autopilot intent.

## Terrain, camera and traffic

Executable assets are served locally. Explicitly enabled public terrain, imagery
and ADS-B are permitted data sources; this does not permit analytics, activation or
runtime script CDNs. Offline mission-corridor packages are supported.

Use validated one-metre data nearby and bounded lower detail farther away. Packages
carry bare-earth and LiDAR-derived canopy/roof heights separately, survey dates,
coverage, missing cells and horizontal/vertical reference. Convert source NAVD88 to
the telemetry reference before comparing heights. Keep ground AGL distinct from
clearance over mapped objects. Candidate cove data is USGS Eastern Tennessee 2016,
`x28y399` DEM and `2738597NE` plus neighboring LAZ files, surveyed February–April
2016. Data is preprocessed, not decoded in the browser animation loop.

Terrain-relative coloring and forward-path alerts are separate. Advisory warnings
consider predicted clearance/closure, not screen position below the horizon. Camera
patches use calibrated optics and pose at frame capture. Invalid registration hides
those patches with a stated reason. Mapped data does not establish the present
absence of wires, trees, vehicles or construction. No certification claim is made.

ADS-B uses a bounded shared provider cache, configurable depiction radius, actual
observation breadcrumbs, timestamp-based expiry, gap handling and error backoff.
Unknown altitude datum means map-only traffic. Polling stops while unused. Provider
attribution and licenses remain visible.

## Delivery and verification

Reuse permitted legacy components with attribution. Missing behavior can be
independently implemented from public documentation/observed behavior with original
tests. Do not copy restricted simulator source. All runtime code, demo data and
documentation are self-contained; the research server is not a runtime dependency.

Verify protocol bytes, mission handshakes/readback, stale/changing context, uncertain
command outcomes, navigation signs, altitude datums, camera timing/calibration gates,
bounded data resources and touch/browser interactions in both palettes. Report fixture,
SITL and physical camera/aircraft evidence separately. Full point-cloud visualization
is the agreed stretch goal; deriving a usable surface from LiDAR is in scope.
