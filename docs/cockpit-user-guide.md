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
PFD. The scene fills the available viewport. The tapes move toward its edges while
the attitude reference, VSI, HSI circles and director retain a uniform scale; touch
regions follow those positions. Insets remain below the primary tape scales.
Keyboard Tab reaches controls; Escape dismisses an open panel.

The persistent control strip provides **Direct-To**, **Heading**, **Altitude /
Speed**, **Loiter**, **Resume Mission**, **RTL**, **Modes**, and **Arm / Disarm**.
It wraps to two rows on smaller screens. Opening these controls only prepares an
operator request; the separate review and confirmation still apply.

The top-center annunciator shows **ACTUAL MODE** and the reported armed state.
Its mode and arm controls open separate pickers. **FD CUES**, **FD NO DATA**, or
**FD OFF** describes the director display, not a heading or altitude capture mode.
Requested actions and their outcomes remain distinct from that actual mode.
An accepted GUIDED request does not change the displayed mode until fresh aircraft
telemetry reports the change. An unavailable mode is stated rather than retained
as current. Aircraft status contains the complete operation messages.

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

During a GUIDED heading request, ArduPlane continues transmitting its previous
geographic target. The cockpit suppresses that target's bearing, distance, ETE
and CDI instead of presenting it as the commanded path. Measured flight-director
pitch/bank remain available. A later accepted Direct-To/Loiter with matching
fresh target coordinates restores geographic guidance; actual AUTO restores
mission navigation. Missing request history and external heading overrides are
explicit limitations of GUIDED ownership, not evidence of an active waypoint.

## Read and author a mission

1. Open Aircraft status and press **Read aircraft mission**. A verified transfer
   supplies the aircraft mission and its revision, including ArduPilot's home
   record. The authored list excludes that home row explicitly.
2. Open **Mission controls**, or select a route point on the map. The 55-command
   Plane catalog supports search and Navigation, Condition and Action categories.
   Each form carries parameter names, units, enum choices and firmware notes.
3. Select an item and choose **Edit parameters** to change its existing action's
   fields, or **Change action** to choose another command. For example, choose
   **Change action → Loiter Unlim**, enter its radius and direction, and press
   **Save draft item**. Changing action retains the item's sequence identity and
   geographic values where the new action uses them. Incompatible command
   parameters reset to the new command's defaults; an acceptance radius does not
   silently become a loiter radius. Review the new form before saving.
   Changing a relative-altitude item to **Do Set Home** clears its altitude and
   requires a new MSL value; the previous height is never relabeled as MSL.
   Edit, insert, move or remove items to create a **LOCAL DRAFT**. Undo restores the
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

Every aircraft-changing action opens a separate review showing the requested
values, vehicle identity generation and mission revision where applicable.
**Review** prepares that dialog. **Confirm & send** submits the request. Changing
the aircraft while editing requires reopening the controls; changing the aircraft
or mission after review invalidates the confirmation. Controls remain unavailable
while their aircraft details are recovering.

1. **Modes:** open the complete mode list supplied by the service and choose a
   mode. The highlighted entry is the reported aircraft mode. Entries identify
   firmware-known or aircraft-advertised knowledge; optional firmware features
   still require autopilot acceptance. Review and confirm the mode request.
   Selecting a mode never arms the aircraft.
2. **Direct-To:** enter latitude, longitude, altitude in metres and an **Above
   home** or **Mean sea level** datum. **Choose target on map** expands the map;
   tap a location to return to the target form with those coordinates. This
   selection does not insert or edit a mission item. Review the complete target
   and confirm. The service enters GUIDED before sending the target. To use an
   existing item's position and altitude directly, select that item and choose
   **Review fly-to**.
3. **Heading:** enter a true heading and turn acceleration in m/s². Review the
   GUIDED transition and heading request, then confirm. The heading is retained by
   the autopilot after the one-shot command. The cyan heading bug on the HSI
   remains a separate local reference; changing that bug sends no command.
4. **Altitude / Speed:** choose the **Altitude** tab, enter metres and the altitude
   datum, then choose a vertical rate in m/s. The default **0** requests the aircraft
   maximum; it is not zero climb. The firmware reserves altitude values **-1**
   and **0**, which the form refuses. Review and confirm. In the **Airspeed** tab,
   enter m/s and acceleration in m/s²; acceleration **0** requests the aircraft
   maximum. For comparison with the knots tape, 25 m/s is approximately 48.6 kt.
   Each tab submits its own reviewed one-shot request, and the autopilot enforces
   its configured envelope.
5. **Loiter:** enter or pick the circle center, choose altitude and datum, then
   enter radius in whole metres and **Clockwise** or **Counterclockwise**. The
   circle is a local plan preview, not the observed aircraft path. Immediate
   GUIDED loiter lasts until another operator command; it has no timed exit.
   Review and confirm. An aircraft mission item also offers **Loiter at this
   item…**, and a map-position context offers **Loiter here…**.
6. **Resume Mission:** read and verify the aircraft mission, then open this panel.
   With a fresh current authored item **1–1999**, **Review Resume Mission** reviews
   continuation in AUTO from that item. Confirm to send. If the fresh current
   item is **Home (0)** and the verified mission contains authored items, the panel
   instead offers **Review start mission**. Home is not an executable waypoint:
   this explicit start uses the existing mission-start command and never sends a
   continue-AUTO request for item 0. Review and confirm that start separately from
   arming. Neither action arms the aircraft. A stale current item, unverified
   mission or empty home-only mission blocks the request. To choose a different
   authored item, select it and use **Continue AUTO from this item**. **Set current
   item** changes only the current item and keeps the mode. Upload and verify
   local draft items before using them as aircraft mission positions.
7. **RTL:** review and confirm selection of the aircraft's return mode. The
   autopilot owns its return path, altitude and execution. The cockpit does not
   calculate or send a return trajectory.

**Arm / Disarm** opens its own panel. Choose the desired state, review it and
confirm. Ordinary autopilot arming checks remain active. Mission controls retain
explicit mission start, mission clear and supported immediate peripheral actions.
Catalog membership alone does not prove that a peripheral command is supported.

Right-click a map location, or hold a touch for approximately 650 ms, to open its
context without entering a picker. Mission authoring can use terrain-relative
altitudes, but execution requires suitable autopilot support and data. Immediate
flight targets accept MSL or above-home values; they never reinterpret a terrain
or home-relative altitude as MSL.

Request admission, autopilot acceptance and observed effect are separate. Aircraft
status lists queued, sent, in-progress, accepted, observed, rejected, failed and
unknown outcomes with their messages. A timeout can mean **unknown**, not failure.
Inspect the aircraft state before deciding to repeat an uncertain request. Request
flight telemetry and Read aircraft mission are explicit service requests without
a flight-action confirmation. Opening a page, rendering telemetry, reconnecting,
or receiving a terrain, traffic, link or battery warning never submits or repeats
a flight action.

### What the GUIDED command result means

Heading, altitude, airspeed and radius/direction controls require a fresh
ArduPlane **4.7.1** firmware identity. Other versions show an unavailable reason.
When necessary, the service waits for a new GUIDED heartbeat before sending the
requested control. These four controls finish **accepted** after a successful ACK;
subscribed MAVLink messages do not establish capture or confirm the selected
loiter radius/direction. Use the instruments for measured motion, and Aircraft
status for the exact request and ACK.

In particular, POSITION_TARGET_GLOBAL_INT can retain the preceding waypoint's
altitude during a GUIDED altitude slew. That displayed geographic target does not
confirm the requested slew altitude. Reported altitude and vertical speed remain
the measurements to inspect. No HDG or ALT capture state is inferred from them.

The [isolated protocol verification](console/evidence/2026-09-07-flight-control-protocol.md)
records a one-shot heading still at 0° after eight seconds, later measured height
of 150.000 m above home and airspeed of 24.991 m/s for 150 m / 25 m/s requests,
and both directions of a requested 180 m loiter. Sampled orbit radii were about
195.5 m. Resume Mission and RTL received fresh observed-state confirmation.
These are simulator measurements, not autopilot-reported capture indicators.

A separate test accepted a **3 m/s** altitude-rate request but climbed only about
9.2 m during its 90-second observation. The successful run used **0** for the
maximum-rate request. A requested rate is not a promise of achieved vertical
speed; the [retained runs](console/evidence/2026-09-07-flight-control-protocol.md#observed-firmware-limit)
document both outcomes.

### Author a timed or turn-count loiter

Use **Change action** or **Insert after this item** in the mission editor. The
form separates radius, direction and duration and shows a local circle preview:

| Mission action | Radius and direction | Duration |
| --- | --- | --- |
| Loiter Unlim | Signed radius in metres; the form stores its sign from the direction choice. Zero uses the aircraft default. | Unlimited |
| Loiter Turns | Signed radius in metres; direction is separate in the form. | Number of turns |
| Loiter Time | Radius comes from the aircraft's `WP_LOITER_RAD`; the mission stores only direction. A numeric radius override is unavailable here. | Whole seconds after entering loiter |
| Loiter To Alt | Signed radius in its command-specific field; zero uses the aircraft default. | Until target altitude |

For a nonzero authored radius, enter its magnitude and choose direction. The
editor uses the pinned Plane command mapping; it does not treat the old
`Dir 1=CW` label as a universal parameter definition. The schematic circle is
dashed when its numeric radius comes from an unreported aircraft setting.

Press **Save draft item**, inspect the mission order and jump references, then
**Upload draft to aircraft → Confirm & send**. Wait for verified readback before
selecting the new aircraft item or resuming the mission. Editing radius,
direction, duration, coordinates or action changes only the local draft.

## Terrain, imagery and traffic

Public-data placement, offline preparation and the explicit aircraft-proxy option
are described in [Ground geographic data](cockpit-ground-data.md). Sources start
from the session's selected data options. Enable terrain,
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
breadcrumbs. Fetch coverage follows the selected 1–100 NM depiction range; a
5 NM display requests a 5 NM feed. Changing this range preserves cached map and
terrain data.
Gaps break the trail; old targets expire. Unknown target altitude or incompatible
ownship altitude keeps targets on the map. Perspective traffic requires compatible
EGM96 heights and fresh ownship pose. Provider errors, delay and attribution remain
visible. An empty display is not evidence that airspace is clear.

## Select a camera and review calibration

Select a detected/configured camera in Display & data, then choose Camera as the
background. Automatic selection uses an identified ELP or a sole configured
camera; an arbitrary camera is not described as forward-facing. The existing
YonderPicture viewer handles connection, stale-frame reporting and frame geometry.
Capture profiles and whether streams run remain in Cameras settings. When the
selected camera is unavailable, **Use synthetic terrain** explicitly switches the
background and enables terrain. Available coverage and datum checks still apply;
the cockpit does not substitute camera registration evidence.

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
The flight workflow checks are in `flight-workflow.test.ts`,
`flight-controls.component.test.ts`, and `flight-host.component.test.ts` beside the
cockpit components. They cover actual/request separation, stale context, mission
conversion, map target selection and one confirmed send. Interactive fixture
checks covered 1280×720 laptop layouts in both palettes, a 768×1024 tablet and a
390×844 narrow viewport. These checks do not establish physical-flight behavior.

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
