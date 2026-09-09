# Illustrated cockpit guide and surface verification

Requirements: R-FLT-10, R-UI-12, R-FLT-21/22. Scope selected by the operator:
**cockpit first**. This pass updates the existing native cockpit guide and its
README entry, with captioned screenshots, exact visible control paths, expected
outcomes and a troubleshooting table. Setup, network and camera-management pages
were not reverified in this pass. No board deployment or merge is claimed.

## Surface checks

`cockpit/guide.mjs` walks the production Vue widget with explicit fixture data.
It blocks aircraft HTTP and public-provider requests. Ten workflow groups cover:

| Surface | Exercise and evidence boundary |
| --- | --- |
| PFD references | Airspeed, altitude, heading and VSI entry, Apply/reopen/Clear; no aircraft send. Local reference persistence between openings is distinct from measured targets. |
| Instrument display | Unit switches, strip placement, V-bar/crossbar, wind and slip/turn panels; settings are local. Responsive suite also checks saved wind and breadcrumbs, transparent hit regions, stable markers and actual map-trail geometry. |
| Persistent flight controls | Heading, altitude, speed, loiter, resume, RTL, mode and arm-state review/cancel; no send on cancel. Direct-To map selection and exactly one confirmed request to the in-memory collector. |
| Mission list/editor | Active FROM/TO bracket, draft altitude edit, action conversion to loiter, radius/direction, undo and return to received mission. |
| Mission authoring | WPL export and reimport; map placement and removal through undo. All **55** catalog command forms are opened. Form availability is not evidence that a connected aircraft can execute every command. |
| Map/data | Zoom/range framing, own-aircraft trail settings, traffic panel, connection setup, unavailable-camera fallback and offline/missing-data states. |
| Availability | A disconnected fixture disables flight review and sends nothing. Unit tests also cover command-detail refresh and Escape after lost focus. |

The separate `cockpit/guide-terrain.mjs` uses the actual prepared Cove ground and
mapped-surface data through a task-owned ground-only relay. Its source permits
no public-provider fetches. It checks streaming, profile distance inspection,
waypoint-altitude editing and unknown datum suppression, plus explicit offline
preparation/reuse. The sampled route reported **100% ground / 97% mapped surface**
coverage. After reload, the test reselected Offline and rendered from browser
storage with **zero relay requests**. Ground and surface coverage are independent.
The ground pack preload completed in about 0.8 seconds with terrain drawing off.
Two earlier attempts with drawing active exceeded the 30-second and 120-second
headless-browser timeouts. This pass documents offline preparation with terrain
off; it does not claim concurrent-render preload performance is resolved on every
client. Hardware browser profiling remains part of the board walkthrough.

## Real autopilot simulation

[The retained run](2026-09-08-cockpit-guide-sitl.json) used a new disposable
ArduPlane 4.7.1 QuadPlane. Every command was issued through the visible native
Vue controls and its separate review/confirmation surface. It verified:

- Explicit stream setup and mission read; 15-wire-item VTOL mission upload and
  verified readback, with local draft start disabled.
- QLOITER observed, normal arming, explicit mission start, AUTO climb with
  positive measured VSI, takeoff completion around the 180-ft target, then
  waypoint 02 and advancement beyond it.
- GUIDED heading, altitude and airspeed request acceptance. The maximum-rate
  altitude request reached within 5 m of the requested 450 ft above home.
- Direct-To, counterclockwise 180 m loiter request, AUTO resume and RTL.

Acceptance for the extended GUIDED requests is an ACK, not a capture signal.
The existing nonzero vertical-rate limitation remains unchanged and documented.
The run did not retest orbit-radius accuracy, IAS/FLC capture, real peripherals
or all catalog mission semantics. After recording the successful RTL result,
the test-owned launcher was stopped and its container removed. Other running
simulators and physical devices were not controlled by this pass.

## Defects corrected during the walk

1. A status request could disable the focused button and move focus to the page
   body. Escape then missed the cockpit root. The host now dismisses its open
   dialog when Escape arrives after that focus loss, and removes the listener
   on unmount. A failing regression test and successful rerun verify the fix.
2. Mission aircraft-action buttons previously remained available during a
   command-details refresh, although the shared review boundary refused the
   action. They now use that same availability condition and explain the refresh.
   Local editing remains available; no command is queued or retried for the user.
3. A nominal 300-ft imported altitude displayed as 299.999997 after conversion.
   Inputs now show at most three fractional digits. The underlying SI quantity
   is retained until the user edits it; opening a form or switching units emits
   no value change. A regression test checks both presentation and preservation.

## Validation and practical limits

- **744 dashboard tests in 65 files passed.** Dashboard/widget production build
  passed; cockpit bundle 682.30 kB, 189.55 kB gzip.
- Responsive browser checks passed at 1440×900, 1024×768, 768×1024 and 390×844.
- The guide walkthrough passed its ten groups, opened 55 catalog forms and
  captured the visible controls without aircraft HTTP requests.
- **15 selected screenshots**, 36 document link/image/anchor checks and 15 image
  hash checks passed. The rendered guide loaded every image and had no horizontal
  overflow at desktop and tablet widths. The selected pictures are instructional artifacts with [source and regeneration details](../../images/cockpit/README.md).

This is software and simulator evidence. Actual aircraft command behavior,
physical iPad/touch performance, ELP video/capture-time calibration, sunlight
readability and live ADS-B availability still require their own checks. Provider
traffic and satellite imagery were intentionally not substituted by fixture
pictures. The guide preserves the distinction between a mission planning profile,
a current-motion estimate and the autopilot's actual guidance.
