# Cockpit integration verification

Base `0f1e9b92485a7f4e23c7d75a6e2fde195124a2ca` on
`claude/exciting-merkle-e4cd39`; integration branch `codex/single-glass-cockpit`.
All work is in the isolated integration checkout. The source checkout's existing
camera edits and original research previews are preserved.

## Evidence

- The full workspace run passed **3,652 tests**: core 2,740; dashboard 573;
  MAVLink nodes 95; modem 90; network 38; remote 56; system 16; video 44.
- `npm run build` and `npm run lint` passed after the protocol, data, terrain and
  native-widget integration. Subsequent presentation changes are rechecked in
  the dashboard suite and production bundle build.
- Terrain preparation passed **10 tests**, using the actual checked vertical
  grids. Runtime terrain includes 19 tests within the core total.
- The capture gate's own mutation checks pass: real text overflow is still
  rejected; scaled/rotated SVG text is measured against its rendered viewport,
  and clipping geographic objects does not exempt overflowing map controls.
- Browser fixtures cover laptop, landscape/portrait tablet, narrow layouts,
  both palettes, instrument panels, mission catalog, inset expansion and bounded
  repeated map updates. The existing authored pure instrument/mission tests are
  retained, including CDI/FD signs and measured VSI behavior.
- [Isolated firmware evidence](console/evidence/cockpit-sitl-smoke.json) verifies
  stream setup, read, upload/readback, normal arm, AUTO takeoff, GUIDED target,
  LOITER and RTL against official ArduPlane 4.7.1. This bounded run was completed
  and its own container removed.
- [Native API evidence](console/evidence/cockpit-native-integration.json) verifies
  the same console-route adapters with real SITL telemetry and a 15-wire-item Cove
  mission upload/readback. A native browser upload also completed with verified
  readback. Later interactive Arm/AUTO requests are recorded separately from the
  API checks; the ongoing simulator's flight state is not a test assertion.
- The public traffic provider returned actual observations during live checks,
  including 16 tracks within the requested feed area. Provider HTTP 429 also
  occurred; backoff, source-error state and observation expiry remain visible.
  Test fixtures do not substitute for provider traffic.

## Installed console capture

The normal `scripts/verify-pages.sh` run used actual Node-RED 5.0.6 and Dashboard
2.0 v1.31.0, the built local widget packages, and the repository's isolated fake
device/daemon harness. It completed **189 checks**, with **12 capture groups
failing** on the first integrated run. The new cockpit findings (widget height,
native containment and SVG measurements) were corrected and checked separately
against the final shipped flow on a second actual Dashboard instance.

The remaining historical shape differences are Camera Live/Setup at desktop,
notebook and tablet sizes in both palettes. Those surfaces' component sources are
unchanged from the requested base. Their references predate the base's camera
changes; the blueprint already records that capture debt. No old camera shape was
silently accepted or overwritten to make this cockpit's gate pass.

The final targeted installed-console capture passed at 1280×900 and 1024×768
in both palettes, with no clipped/truncated/spanning/unreadable findings and no
page scrolling. Both insets, the restored navigation strip, and transparent PFD
touch regions were visually reviewed.

Final cockpit captures use auto-height `cockpit-display`, preserve the sidebar and
configuration-pending group, and measure the available component width. Geometry
references accompany the new page. Browser PNGs remain local capture artifacts.

## Practical limits

This is the preserved authored cockpit with production interfaces, rather than a
claim of complete Garmin/MSFS behavior. The included GPL geometry retains its
provenance; restricted simulator assets are not imported. Local reference bugs
are distinct from measured autopilot targets. Missing turn intent is unavailable,
and a motion-vector estimate is not an autopilot turn countdown.

Aircraft command evidence is ArduPlane-specific. Dynamic advertised capability
discovery, authenticated signed MAVLink, other firmware command families and
direct terrain-datum GUIDED targets remain unsupported here. The six immediate
commands and 55 mission forms have distinct capability meanings. The operation
ledger accepts at most 256 distinct requests per service lifetime, then explicitly
refuses further requests instead of silently discarding idempotency history.

Registered camera geometry requires physical ELP lens/mount calibration, matching
capture profile, actual capture-time pose and verified clock/datum relationships.
The current generic WebRTC camera service does not manufacture those timestamps;
without them the camera background and screen-fixed instruments work, and scene
registration remains visibly unavailable. No physical flight or camera alignment
is established by the fixture or SITL evidence.

The 2016 USGS pack contains measured ground and quality-screened mapped surface.
Its 28 isolated high-return cells remain unknown, with raw values and the explicit
preparation heuristic retained in provenance. One-metre sample spacing is not
one-metre horizontal survey accuracy. Coverage, stale surveys and missing cells
remain separate from a present-day obstacle inventory. Full point-cloud viewing
is the agreed stretch goal.
