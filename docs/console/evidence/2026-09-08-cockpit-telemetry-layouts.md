# Configurable cockpit telemetry and layouts

Requirements: R-FLT-23 through R-FLT-26, R-UI-09, and the existing flight-command
and navigation requirements. The operator approved implementing the discussed
telemetry categories and supplied cockpit photographs to establish the layout
and instrument conventions. The default remains one PFD with expandable insets;
adjacent and stacked MFD arrangements are selectable.

## Delivered surfaces

- Configurable top navigation fields and graphical instrument bank, with source
  selection, ordering, arc/horizontal/vertical/numeric/timer/bearing/status
  presentation, local scales/bands, apply/cancel, restore defaults and persistence.
- Side, top, MFD and hidden instrument placement. MFD pages for map, flight plan
  and its terrain profile, graphical Systems overview, and searchable telemetry
  source/age/quality inspection with pinning and bounded history.
- The actual PFD and map remain mounted during layout changes. The HSI gains a
  separate reported-home bearing marker; active waypoint/distance/ETE fields
  use the current guidance context. Unit changes preserve physical display bounds.
- Reported VTOL/landed state is distinct from the autopilot's actual-mode and
  director display. Structured conditions and recent aircraft messages open a
  working notices view; historical messages are not asserted to be active faults.
- Gimbal Euler readings require a fresh normalized quaternion and valid reported
  reference flags. True-north and vehicle-relative bearings have different labels;
  invalid frame combinations remain unavailable. No camera calibration is implied.

The [field inventory](2026-09-08-cockpit-telemetry-fields.md) identifies collector
keys and sensor instances. Every category has a way to find and inspect reported
readings; the presence of a catalog entry does not establish installed hardware.

## Collection and bandwidth

Aircraft battery/energy and unambiguous per-cell voltages/spread, ESC/RPM/engine/generator, GPS/estimator, vibration,
rangefinder/terrain, state, fence, controller/MCU/power, RC/servo/radio and payload
messages use bounded per-source storage with independent expiry and source IDs.
Peripheral telemetry on the selected system cannot satisfy mission or command
ACKs. The existing explicit stream-setup operation requests optional reports at
1 Hz after essential flight streams; refusals remain visible and a timeout does
not blindly advance through indistinguishable interval ACKs.

Companion CPU uses aggregate `/proc/stat` deltas, not load average. Temperature,
memory, available storage, modem and media facts retain their actual reader
identity. Optional slow readers run independently with one pending read each;
a slow modem cannot block fresh aircraft or OS readings. This path does not run
signal setup, active connectivity probes, camera starts or flight commands.

`/cockpit/api/instruments` is authenticated and read-only. Its compact dictionary
and row envelope is independent of the fast flight wire, with a 512-reading /
128-KiB bound. The collector retains at most 450 fields, including four time
readings and its truncation indicator. With eight companion cameras, the maximum
merged 513 readings is truncated deterministically with the time readings and
diagnostic preserved. The omitted count is exposed. The browser polls no faster
than 1 Hz and counts instrumentation JSON separately in its bandwidth readout;
HTTP overhead, video and public geographic data are excluded from that readout.
The retained SITL snapshot contained 156 readings in 9,522 JSON bytes; that is
one measured payload, not a fixed bandwidth guarantee.

## Timer meaning

Power-on time uses the reported boot clock. GLOBAL_POSITION_INT becomes the sole
authority once established; SYSTEM_TIME is only an initial fallback. Buffered
epochs, delayed competing packets, gaps, hardware identity changes and rollover
have regression coverage. Expired authority is unavailable rather than replaced
by a conflicting clock.

Armed, airborne and AUTO time are **partial observed totals**, accumulated across
arm cycles since collection/confirmed boot history began. Airborne total counts
only intervals bracketed by IN_AIR reports: TAKEOFF, LANDING, transition
boundaries and gaps are excluded. AUTO total counts observed armed AUTO intervals.
These are not exact takeoff-to-landing or per-sortie clocks. The UI uses observed
labels and `*`, and the inspector explains each counter's scope.

## Verification

- **2,892 core tests** in 134 files passed; **806 dashboard tests** in 69 files
  passed. The production cockpit bundle built successfully: 780.67 kB,
  215.35 kB gzip.
- The existing responsive cockpit browser checks passed at 1440×900, 1024×768,
  768×1024 and 390×844. The illustrated guide walkthrough passed ten workflow
  groups and opened all 55 mission action forms. Terrain/profile and prepared
  offline reuse checks also passed without aircraft HTTP requests.
- The [layout walkthrough](2026-09-08-cockpit-layout-browser.json) exercised
  local band editing, source/style cancel, shared PFD/map identity, direct
  inspector search and pinning, saved-layout reload, instrument visibility,
  notice contents and landscape/portrait tablet arrangements. The images in
  the guide are captures of the native components with explicit fixture data.
- The [fresh QuadPlane run](2026-09-08-cockpit-layout-sitl.json) used the pinned
  ArduPlane 4.7.1 simulator. It requested telemetry, read and verified a 15-item
  mission, waited for GPS/EKF readiness, selected QLOITER, armed normally and
  started the mission. The run observed positive VSI, completion of the 180-ft
  takeoff item and waypoint advancement, then exercised heading, altitude,
  airspeed, Direct-To, loiter, AUTO resume and RTL through reviewed UI requests.
  It additionally verified live boot/armed/airborne/AUTO readings and controller
  load through the instrumentation endpoint. ACK and observed effect remain
  distinct. A startup gyro refusal led to an explicit readiness wait in the
  test; arming checks were never disabled or bypassed.

Independent reviews found and resolved ESC freshness/unit ambiguity, delayed
clock epochs, snapshot truncation, slow-reader blocking, editor focus and
stacking, notice links, and composite reading-age errors. Subsequent focused
checks covered source-aware bearing labels and deterministic display-band
boundaries. The full cockpit captures were compared with the supplied layout
references, including what must remain present while changing MFD pages.

The final rendered guide loaded all 22 screenshots without horizontal overflow
at 1440×1000 and 768×1024. All 43 checked guide links/images and 22 screenshot
SHA-256 hashes passed validation; the final diff passed whitespace checks.

## Practical limits

This is software, browser and simulator evidence. Physical-board startup, real
modem/sensor availability, camera registration, physical iPad performance and
live ADS-B/provider availability are not established by these tests. Unsupported
streams in the pinned simulator stay unavailable. The pre-existing unverified
nonzero climb-rate/capture behavior remains documented; no extra autopilot modes
or guarantees are inferred from the display.

## Approved instrument appearance restored

The operator reported that the production bank had lost the color and mixed
instrument styles of the approved design study. The comparison identified empty
production default bands, a muted replacement palette and different recommended
faces. The bank now uses the study's green/yellow/red palette, current/CPU arcs,
vertical battery gauge and horizontal charge/signal/telemetry-age bars. The guide
and editor identify their ranges as editable starter presentation presets, not
limits read from the aircraft. Telemetry sources and actual warnings are unchanged.

Only the exact untouched former six-slot gray bank upgrades on restoration.
Customized sources, styles, scales, order, bands and explicit empty selections
remain intact. The focused regression failed before the fix; all 62 covering
settings, instrument, host and layout tests then passed. The cockpit production
bundle built at 781.92 kB / 215.68 kB gzip. Browser inspection verified colored
faces, retained stacked arrangement, the real editor's three bands, cancellation,
and the existing terrain background. The earlier 22 guide captures above remain
historical workflow captures; their palette predates this correction.

The original study documents its source relationship in
[its README](../../../packages/node-red-dashboard-2-yonder/cockpit/instruments/README.md):
Vue/SVG gauges based on the community G3X conventions, not simulator-runtime
components or a claimed pixel-identical certified-aircraft implementation.


## Gauge sizing and control order correction

The operator requested larger faces in their allocated cells and the autopilot
buttons above the user fields. Fixed-height HTML titles and secondary readings
had reduced the SVG to 41 px inside a 77 px side-column gauge. Graphical titles,
faces and secondary readings now share a scalable SVG, with reduced cell padding.
The native DOM order and desktop grid both place flight controls before the
configurable field row. No aircraft or telemetry behavior changes.

At 1280×720 the side-bank numbers increased from roughly 10 px to 18–19 px high;
the face uses the full 83 px instrument height. The top-strip numbers measured
30–33 px. Browser checks at 768×1024 and 1024×768 verified the same row order,
readout heights of 19–21 px and no horizontal page overflow. Original side-bank
placement and normal browser dimensions were restored after checking. All 63
covering component/settings tests passed, including the order regression that
failed before the change. The production cockpit bundle built successfully.


## Preserve display height with an MFD

The operator's screenshot exposed a stacked-layout failure that the earlier
viewport-overflow checks missed. Fractional rows compressed the PFD to 220 px
(151 px of instrument canvas), the map to 200 px and a 145-px MFD instrument row
into 48 visible pixels. The stacked grid now assigns each display its own bounded
working height and lets the display area scroll under the persistent top controls.
The MFD bank retains its complete intrinsic row; it does not absorb grid shrinkage.
Short side-by-side views also scroll rather than clipping their instrument bank.

Browser reproduction and post-fix inspection covered 1280×720, 1024×768,
768×1024 and 390×844. PFD heights were 560–840 px, map heights 556–720 px,
and every MFD instrument row had clientHeight = scrollHeight = 145 px. There was
no horizontal page overflow. End/Home scrolling moved the displays while keeping
the controls and fields in place. Explicit MFD page access brought its tabs to
the top of the scrolling area. Side-by-side verification also retained the full
145-px bank and a 480-px map. Normal browser dimensions were restored.

A keyboard-focusable named display region and explicit-page reveal behavior are
covered by the host checks. All 64 covering component/settings tests passed and
the production bundle built (783.58 kB, 216.15 kB gzip). The reusable layout guide
now includes full-height, no-clipping and keyboard-scroll assertions; this pass
executed those behaviors through the browser tools, not another complete SITL run.
