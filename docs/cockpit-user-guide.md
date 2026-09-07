# Cockpit walkthrough

The Cockpit page is the flight display. Systems opens the existing device settings;
Cameras retains capture, stream, exposure and other camera controls. The cockpit
uses the authenticated device session. Opening a panel or editing a local reference
never sends an aircraft command.

## Start with the flight display

The default view keeps one PFD visible, with a mission inset at the lower left and
a map/traffic inset at the lower right. Press either inset's expansion arrow for a
larger pane alongside the same PFD. The return arrow restores the full display.
Narrow screens provide a Mission/Map selector and stack an expanded pane below the
PFD. Keyboard Tab reaches controls; Escape dismisses an open panel.

The tapes show indicated airspeed in knots and reported MSL altitude in feet. The
VSI uses measured climb in feet per minute. The HSI heading is true north. Magenta
flight-director cues show the autopilot's reported desired pitch and bank, and
remain unavailable when those measurements are absent. Choose V-bar or crossbar
cues from FD settings. The numeric VSI and pitch/bank summaries remain in split
views; the full view uses their primary instruments to leave room for the insets.

Tap airspeed, altitude, heading or the VSI to enter a **local reference**. Cyan
marks are local display references. Sync live copies a current reading into that
reference; it is not a command. Display & data selects day/night palette, tape and
HSI transparency, background and optional sources. The PFD remains screen-fixed
over a camera image even when scene registration is unavailable.

The Instrument strip setting in PFD Display controls offers **Mission / navigation** (a data band above the PFD), **PFD**, or **Hidden**. The band shows current bus voltage, current, battery, throttle and GPS satellite count. Expand the mission pane to see the preserved lateral-deviation scale: its white center triangle stays fixed while the magenta bar uses the same guidance and full-scale setting as the HSI. GUIDED loiter labels radial OUT/IN error; unavailable guidance removes the bar.

Missing or expired measurements show unavailable indications. GPS altitude,
fused global altitude and height above home are separate readings in Aircraft
status. Navigation-controller cross-track, mission-current information and GUIDED
targets have their own freshness checks. AUTO straight-leg CDI and GUIDED loiter
radial error are different indications. ETE means estimated travel time to the
point; it is not a turn countdown.

## Read and author a mission

1. Open Aircraft status and press **Read aircraft mission**. A verified transfer
   supplies the aircraft mission and its revision, including ArduPilot's home
   record. The authored list excludes that home row explicitly.
2. Open **Mission controls**, or select a route point on the map. The 55-command
   Plane catalog supports search and Navigation, Condition and Action categories.
   Each form carries parameter names, units, enum choices and firmware notes.
3. Edit, insert, move or remove items to create a **LOCAL DRAFT**. Undo restores the
   previous edit. Changes are local until an explicit upload. DO_JUMP targets are
   remapped when items move; removing a referenced target requires resolving the
   jump first. Imported unknown commands remain inspectable and exportable.
4. Import Mission Planner WPL `.waypoints` or QGroundControl SimpleItem `.plan`
   files through Display & data. ComplexItem plans are rejected with a reason.
   The file limit is 2 MiB, and the aircraft transfer limit is 2,000 wire items,
   including home. Export saves a WPL file. Export drafts before leaving or
   reloading the page; draft and undo history are held in this browser session.
5. **Load cove example as local draft** explicitly selects the included
   “Take off around the cove then land” mission: its home and fourteen original
   items are preserved. Its name does not add a landing command to the file.
   Loading it does not change the aircraft mission or synthesize aircraft data.
6. Press **Upload draft to aircraft**, inspect the review, then **Confirm & send**.
   The service transfers and reads back the mission. Inspect the operation result
   and return to **Show aircraft mission** to see the received aircraft state.
   The aircraft mission must first have been read. After a verified empty
   ArduPlane mission, the upload includes its actual reported HOME_POSITION as
   wire item zero. This does not set the aircraft home. An unread mission or
   unavailable actual home remains blocked.

Imported sequence gaps are preserved for inspection/export; the aircraft service
validates the exact outgoing wire sequence and reports unsupported transfers.
Draft edits normalize authored ordering and remap jumps. A draft retains the vehicle generation and mission revision on which it began. A changed aircraft or mission requires an explicit conflict review before the draft can be kept for the current aircraft. A local draft item cannot
be selected as the aircraft's current item until uploaded and verified.

## Request an aircraft action

Mission controls offers the aircraft's available modes, arm/disarm, explicit
mission start and mission clear. Selecting an aircraft item offers **Set current
item** while keeping the mode, or **Continue AUTO from this item**. An immediate
command is offered only when the service advertises support. Catalog membership
alone is not evidence that a command is supported by this aircraft.

Right-click a map location, or hold a touch for approximately 650 ms, to open its
context. Alternatively, use **Add waypoint on map** and tap the desired location.
Choose a mission edit or review a fly-to/GUIDED loiter target. The target form
requires a numeric altitude and an explicit MSL or above-home reference. Unsupported
terrain-relative targets remain labeled unavailable; no home/terrain value is
silently converted to MSL. Terrain-relative mission items can be authored, but
require suitable autopilot support and data during execution.

Every aircraft-changing action opens a separate review showing its vehicle
identity generation and mission revision where applicable. Press **Confirm &
send** to submit it. A changed vehicle or mission invalidates the review. The
browser never arms implicitly, retries a command after reconnect, or takes an
action from traffic, terrain, link or battery state.

Request admission, autopilot acceptance and observed effect are separate. Aircraft
status lists queued, sent, in-progress, accepted, observed, rejected, failed and
unknown outcomes with their messages. A timeout can mean **unknown**, not failure.
Inspect the aircraft state before deciding to repeat an uncertain request. Request
flight telemetry and Read aircraft mission are explicit service requests, without
a hazardous-action confirmation.

## Terrain, imagery and traffic

Sources start from the device session's selected data options. Enable terrain,
hybrid imagery and internet traffic independently in Display & data. Executable
assets are served by the device. The grid map, mission geometry and instruments
remain useful with sources disabled or unavailable.

The bundled cove pack contains surveyed bare-earth and **mapped surface** data.
Near the aircraft, the renderer retains the native one-metre grid within a bounded
nearby tile set; farther away it uses a labeled lower detail level. Survey dates,
source attribution, vertical conversion and limitations are shown in Display &
data. Missing samples remain holes. Mapped surface may include buildings and
unclassified returns; it is not a current inventory of vegetation or obstacles.
Nearby imagery is an optional visual layer and does not change elevation geometry.

The aircraft height datum defaults to **Unknown** because MAVLink AMSL does not
identify its geoid model. Declare EGM96, NAVD88 or WGS84 ellipsoid only from a
verified receiver configuration. Native height comparisons require compatible
references. The named Terrarium fallback can provide approximate terrain when the
pack cannot be used; it does not supply numeric AGL without a verified common
reference. Estimated ground AGL is separate from clearance over mapped objects.

The **Current-motion forecast** samples reported track, ground speed and vertical
speed through the selected time/distance horizon. It checks a ±20 m corridor,
with bounded sampling, and reports coverage, minimum ground/surface clearance,
closure and time to the 30 m warning or 90 m caution threshold. A partial result
does not assert that the remaining path is clear. It is a constant-motion estimate;
it does not predict autopilot turns or control the aircraft. Static terrain colors
and the future-motion forecast are separate advisories.

Traffic controls select 1–100 NM depiction range and 60, 120 or 300 second observed
breadcrumbs. Fetch coverage follows the depiction range with a minimum 25 NM feed.
Gaps break the trail; old targets expire. Unknown target altitude or incompatible
ownship altitude keeps targets on the map. Perspective traffic requires compatible
EGM96 heights and fresh ownship pose. Provider errors, delay and attribution remain
visible. An empty display is not evidence that airspace is clear.

## Select a camera and review calibration

Select a detected/configured camera in Display & data, then choose Camera as the
background. Automatic selection uses an identified ELP or a sole configured
camera; an arbitrary camera is not described as forward-facing. The existing
YonderPicture viewer handles connection, stale-frame reporting and frame geometry.
Capture profiles and whether streams run remain in Cameras settings.

Camera + registered terrain adds measured scene annotations only when all required
inputs are valid: matching camera/profile calibration, lens intrinsics and
distortion, mounting transform, crop/rotation/mirroring, residual bounds, an
explicit compatible height reference, observed terrain and a bracketed pose at the
actual frame capture time. The overlay uses the displayed video rectangle.

Importing calibration JSON loads a local candidate, not timing evidence. It must
match the selected camera and capture profile, and pass the shared runtime
validator. The format is `CameraCalibration` in
[`packages/yonder-core/src/terrain/types.ts`](../packages/yonder-core/src/terrain/types.ts).
A validated geometry file cannot manufacture frame timestamps or prove a capture
clock relationship. When those inputs are unavailable, the cockpit states the
reason and keeps the screen-fixed instruments. Physical camera registration has
not been established by the synthetic browser tests.

## Development verification

From the repository root, `npm run cockpit:dev -w node-red-dashboard-2-yonder`
serves the real Vue widget with an explicit synthetic snapshot and in-memory
transport on loopback port 4192. The default harness cannot send an aircraft
request. `npm run cockpit:verify -w node-red-dashboard-2-yonder` checks notebook,
landscape/portrait tablet and narrow viewports using that fixture. Component and
ported instrument tests run with the dashboard package's normal test command.

For real geography with synthetic flight data, run
`node scripts/cockpit/data-preview.mjs --public-data`, then start the cockpit
harness with `COCKPIT_API=http://127.0.0.1:4194` and open `/?live=1`. The preview
service refuses aircraft writes. Public data is enabled only by the explicit
flag. This verifies native pack/imagery/traffic rendering separately from MAVLink
SITL and physical camera/aircraft evidence.

## Native ArduPlane SITL walkthrough

Build `yonder-core`, then start
`node scripts/cockpit/sitl-preview.mjs --firmware-dir DIR --public-data`.
The script verifies the pinned official ArduPlane 4.7.1 files and owns an isolated
port-5766 container. Firmware acquisition and checksums are documented in
[`scripts/cockpit/README.md`](../scripts/cockpit/README.md). It sends no automatic
aircraft command and leaves an existing port-5762 simulator untouched.

Start `COCKPIT_API=http://127.0.0.1:4195 npm run cockpit:dev -w node-red-dashboard-2-yonder -- --port 4193`
and open the loopback port-4193 page with `/?live=1`. This mounts the production
Vue cockpit and production command service against the isolated simulator.

Read the aircraft mission first. For a fresh simulator, a verified empty read plus
actual HOME_POSITION permits the first upload. Load the cove example as a local
draft, review it, and confirm upload. Wait for verified readback. Arming and mission
start are separate explicit actions, each requiring review and confirmation.
Closing the preview script cleans up its own container. These steps establish
simulator evidence; they do not establish physical camera or aircraft readiness.
