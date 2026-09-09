# Cockpit flight workflow verification — 2026-09-07

R-FLT-11 through R-FLT-14. This change extends the production Vue cockpit and
authenticated vehicle service. It does not replace the existing instruments or
depend on the research server.

## Real protocol and browser workflow

[Protocol evidence](2026-09-07-flight-control-protocol.md) records isolated
ArduPlane 4.7.1 heading, altitude, speed, clockwise/counterclockwise loiter,
mission resume and RTL. The rate-limited altitude trial is retained alongside
the successful maximum-rate trial; an ACK is not a measured capture state.

A separate native preview used API port 4201, vehicle port 5770 and page port
4196. Browser interaction exercised source selection, terrain preload, mission
action conversion and undo, explicit mission read, upload with verified
readback, separate arming, initial mission start, and a reviewed 90° true heading
request. The header changed from actual AUTO to GUIDED after aircraft telemetry;
the request annunciation showed the accepted heading separately. The PFD showed
measured airspeed, altitude, VSI and flight-director demands over textured terrain.
No command was sent by loading the page, editing/undoing the draft or choosing
data sources. Before the first explicit mission read, the operation list was empty.

The initial-start walkthrough exposed Home (0) being offered as a resume item.
Regression tests now require a distinct reviewed mission start there; normal
resume uses verified current authored items 1–1999. GUIDED heading also exposed
the firmware's retained geographic target. The shared navigation guard suppresses
its bearing/distance/ETE/CDI during heading ownership and preserves measured FD
demands. A subsequent accepted geographic request and matching fresh coordinates
restore geographic cues. Unreported external overrides remain explicitly unknown.

Laptop 1280×720 in both palettes, tablet 768×1024 and narrow 390×844 were
inspected. Automated fixture checks cover no horizontal overflow, inset
expansion, transparent touch regions, stable marker counts and zero vehicle
requests. The full scene fills the available PFD aspect without stretching the
instrument circles. A selected unavailable camera offers synthetic terrain.

## Bandwidth and offline data

A live GUIDED sample measured 1,626 bytes for `/cockpit/api/flight` versus 17,681
bytes for the compatible full `/state` response: 90.8% less JSON per recurring
read. This is one sample, not a bound on wire bandwidth. At four reads per second
that flight payload is approximately 6.35 KiB/s, plus occasional changed details
and missions. HTTP/TLS overhead, compression, video and geographic transfers are
excluded. The browser displays measured received JSON and permits 1/2/4/8 Hz.

Recurring responses omit mission items, operation history and traffic trails.
Deferred details/mission reads have independent revision and vehicle-generation
checks; a slow mission download does not block flight updates. Command delivery
is independent of this read loop and never retries automatically.

[Actual Chromium storage evidence](2026-09-07-ground-browser-terrain.json)
records all 227 prepared Cove terrain files (20,973,049 bytes) imported, reloaded
from IndexedDB, and sampled as one-metre nearby / four-metre distant terrain with
zero aircraft API requests. The production page's explicit ground-relay preload
also displayed the saved package and rendered it. Offline mode disabled internet
traffic and reported missing offline imagery while retaining mission geometry.

Direct Esri imagery and Terrarium elevation were readable in Chromium. ADSB.lol
returned HTTP 403 on this network; both direct/ground-relay failures remain
visible. There were no substituted traffic targets. The optional ground relay
does not bypass provider refusal or proxy aircraft control. Provider/source
ownership and offline preparation are documented in the
[ground data guide](../../cockpit-ground-data.md).

## Review regressions

- Tile opt-out aborts active and queued aircraft downloads; retired requests
  cannot adopt a new controller or populate a new cache.
- Traffic-only range/toggle changes preserve map and terrain caches and leave
  in-flight tiles alone, while traffic opt-out aborts its own request.
- Offline imports enforce a 64 MiB expanded storage budget even when multiple
  tile keys reference the same input file.
- Delayed initial aircraft details preserve operator edits and merge untouched
  camera/datum fields before sending settings.
- Command notices replace queued text with the matching reported result.
- Action conversion requires a new MSL altitude when changing a relative-altitude
  item to Do Set Home; terminal unknown/failed states remain visible after an ACK.

Physical camera calibration/capture timing, actual aircraft control performance,
sunlight readability and provider service availability remain outside this
software and isolated-simulator verification.

## Integrated branch verification

The signed cockpit implementation commit `9db18f5` was merged with the requested
base through `bfe2898` in signed merge `d5a4e8a`. The wiring conflict retained
both the cockpit page and the base's camera Start action. The resulting flow
contains 375 unique node IDs; the existing camera page implementations and their
shape baselines were not changed by this cockpit integration.

- `npm test`: **3,780 tests passed across 189 test files**, including 644 dashboard
  and 2,793 core tests. The tests use explicit failure fixtures for link loss,
  invalid inputs and unavailable system services; those fixture messages are not
  test failures.
- `npm run build` and `npm run lint`: passed.
- The merge-focused flow, authentication and route checks: **395 tests passed**.
- `npm run cockpit:verify -w node-red-dashboard-2-yonder`: passed the responsive
  fixture checks without issuing vehicle requests.
- Installed Node-RED cockpit captures passed in day and night at 1280×900 and
  in night at 1024×768. The captured PFD, insets and persistent controls were
  visually inspected. Missing flight measurements remain explicitly unavailable.
- The complete installed-page visual gate finished with **189 passed and 12
  failed checks**. It is **not green**: the camera index,
  live and setup captures differ from their stored geometry, and the Record
  action spans its surface at the tested widths. These findings concern camera
  pages retained from the merged base. Their shape baselines were not accepted
  in this cockpit work.

The operator preview remains on page port 4196 against the isolated native
ArduPlane simulator, separate from the earlier previews. The walkthrough includes
the HTTPS/localhost requirement for cryptographically verified offline imports
and distinguishes a tablet's loopback address from a laptop ground service.
