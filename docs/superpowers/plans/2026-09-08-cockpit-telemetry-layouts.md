# Configurable cockpit telemetry and display layouts

User approved implementing the discussed telemetry catalog, instruments and
detail pages in the actual cockpit. Supplied cockpit photos establish the visual
direction: configurable navigation fields across the top, compact graphical
instruments beside the PFD, and a separate tabbed multifunction pane. Default
remains one PFD with expandable insets; stacked MFD is optional (explicit answer).

## Global constraints

- Keep the actual PFD, terrain, camera, mission editing, map and reviewed command
  components. Never manufacture autopilot intent or capture annunciations.
- Opening, pinning, arranging or polling an instrument sends no flight command.
  Stream configuration is an explicit operator action. No physical aircraft is
  commanded by verification; use fixtures and owned disposable SITL only.
- Missing, stale, unsupported or ambiguous sensor data is unavailable, not zero.
  Preserve source/component IDs, units, sample age and independent expiry.
- Counters distinguish boot, armed and airborne time. Late attachment, reboot,
  gaps and partial histories remain visible; browser reload does not reset a
  vehicle-service counter. Home distance/bearing are calculated, not RTL route
  length or a flight-director target.
- Use a separate bounded 1 Hz instrumentation read, with compact dictionary/row
  encoding. Do not add all diagnostic fields to every fast attitude packet.
  Maintain the existing fast flight wire format and aircraft admission checks.
- Preserve defaults and per-browser saved layouts with validation, fallback and
  restore-default controls. Data-field selection and gauge presentation are
  independent. Display limits never change autopilot failsafe parameters.
- Every catalog category has a working method to inspect/pin received readings.
  Hardware-dependent absence is explained. No fixture values enter live views.
- The approved images are behavioral/layout references, not instructions to
  reproduce unavailable radios, proprietary assets or unsupported flight modes.
- Tests are evidence for software behavior; hardware functionality is not
  claimed without hardware evidence. Commits are GPG signed with DCO sign-off.

## Shared interface

`packages/yonder-core/src/mav/instrumentation-types.ts` defines:

```ts
export interface InstrumentReading {
  value: number | string | boolean | null;
  unit: string;
  source: string;
  ageMs: number | null;
  ttlMs: number;
  quality: 'reported' | 'calculated' | 'partial' | 'unavailable';
  reason?: string;
}
export interface InstrumentationSnapshot {
  at: number;
  generation: string | null;
  connected: boolean;
  fields: Record<string, InstrumentReading>;
}
```

Stable keys include `battery.0.voltageV`, `battery.0.currentA`,
`battery.0.remainingPercent`, `battery.0.consumedMah`,
`battery.0.consumedWh`, `flight.bootSeconds`, `flight.armedSeconds`,
`flight.airborneSeconds`, `flight.autoSeconds`, `flight.landedState`, `flight.vtolState`,
`host.cpuPercent`, `host.temperatureC`, `host.memoryPercent`,
`modem.rsrpDbm`, `modem.rsrqDb`, `modem.sinrDb`.
Other keys are grouped by `gps`, `ekf`, `vibration`, `esc`, `efi`, `generator`,
`rangefinder`, `terrain`, `fence`, `rc`, `servo`, `radio`, `fc`, `camera`, `gimbal`.
Instance IDs stay in keys; no unrelated sensors are combined silently.

UI items normalize these readings into `{id,label,category,value,unit,available,
source,ageMs,reason,quality,kind,min,max,bands,secondary}`. `kind` supports number,
timer, bearing, status, arc, horizontal and vertical. Defaults can be overridden
only through validated local layout settings. Timeline history is bounded and
gaps are retained.

## Tasks and ownership

- [x] **1. Aircraft instrumentation and timers.** Implement the shared types,
  bounded MAVLink collector, per-field expiry and service-side counters. Cover
  battery/energy, propulsion, GPS/estimator, terrain/range, VTOL/landed state,
  flight-controller health, fence, radio/RC/outputs and payload messages present
  in the installed dialect. Expose `VehicleService.instrumentation()`; accept
  telemetry from components on the selected system without relaxing command or
  mission origin checks. Integrate the collector into explicit stream setup.
  Tests: sentinel units, instance isolation, expiry, source filtering, timer
  late attach/gap/reboot, and zero unsolicited commands.
- [x] **2. Host readings and compact route.** Implement true CPU utilisation,
  memory/temperature/uptime/storage, modem signal and available recording/video
  facts with injected readers and shared caches. Add authenticated
  `/cockpit/instruments`, merge vehicle and host readings, and bounded compact
  serialization separate from the flight wire. Add a client decoder module.
  Own `cockpit/routes.ts`, new host/wire modules, daemon wiring and relevant
  route tests. Tests: CPU delta, unavailable OS fields, cache/coalescing,
  authorization, wire validation and payload size.
- [x] **3. Instrument and data-field surfaces.** Promote the approved graphical
  style into native cockpit components: reusable gauge faces, configurable bank,
  configurable navigation data bar, grouped systems page, inspector and bounded
  trend view. All operate on normalized UI items; no backend fetches/commands.
  Own new components under `src/ui/cockpit/instruments/`; do not edit the host.
  Test local apply/cancel/default/reorder, source selection, no-data/expiry,
  range validation, accessible tap targets and trend gaps.
- [x] **4. Host layout and navigation integration.** Root owns `YonderCockpit`,
  PFD integration, client API and UI catalog/derived navigation adapter. Add
  display setup with single-PFD default, split and stacked MFD, MFD tabs for map,
  flight plan/profile and systems/inspector, and instrument placements top/side/
  MFD/hidden. Preserve one PFD and map instance during changes. Add home bearing,
  timers, waypoint/ETE formatting and reported VTOL indications. Connect 1 Hz
  instrument polling independently from flight updates; clamp history and cancel
  requests on unmount. Tests: saved config validation, stale source suppression,
  home geometry, actual mission sequencing, layout switch identity, no sends.
- [x] **5. Verify and document.** Run targeted package tests and builds, then
  production browser workflows at laptop/iPad sizes with fixture and owned SITL.
  Compare current screenshots to the supplied reference structure and inspect
  absent elements. Update guide, screenshots, blueprint and evidence, listing
  actual integrations and unavailable hardware features. Review final diff,
  resolve findings, commit signed, open the working cockpit for operator review.

## Integration checks

Task 1 produces `InstrumentationSnapshot` and `VehicleService.instrumentation()`;
Task 2 consumes them. Task 2 produces a wire decoder; Task 4 consumes it. Task 3
consumes normalized UI items and emits local settings; Task 4 owns that adapter
and persistence. These boundaries avoid shared-file edits. Aircraft telemetry
keys and grouped availability are communicated before UI adapter finalization.
Task 4 preserves the existing guidance derivations and validates presentation
against known mission handoffs rather than replacing them with guessed guidance.
