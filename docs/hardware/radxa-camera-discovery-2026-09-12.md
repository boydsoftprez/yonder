# Radxa camera discovery recovery — 2026-09-12

The Radxa Zero 3W bench board at `192.168.68.73` detected its SeekerHD
camera correctly, but the Cameras page falsely said no cameras were found.
This was a daemon responsiveness regression, not a missing CSI driver.

## Evidence and cause

- Kernel `6.1.115-vendor-rk35xx` bound `imx462lqr` at I²C `2-001a`.
  The enabled media graph connected the sensor through the D-PHY and RKISP
  to `/dev/video0`. The camera overlay was already enabled.
- Direct `GET /cameras` returned the CSI sensor and three NV12 formats.
  The final pre-patch request took **11.186 seconds**. Individual V4L2
  format queries took roughly 16–20 ms in the earlier bounded checks.
- The console client has a five-second deadline. Its failed read emitted
  a null payload and a rejected command status. The index widget collapsed
  that missing report into the same display as a successful empty scan.
- The terrain receive path composed six full aircraft snapshots per ordinary
  telemetry datagram. Each included work unrelated to terrain admission.
  This occurred even with no active terrain transmission (`sent=0`).

An isolated benchmark used the installed classes, 1,000 serialized ATTITUDE
packets after a HEARTBEAT, a fixed clock, no real sockets, and a send callback
that throws. It did not operate the flight controller.

| Board benchmark | Before | After |
| --- | ---: | ---: |
| Vehicle + terrain, 1,000 packets | 6,046 ms | 577 ms |
| Full aircraft snapshots in that loop | 6,000 | 0 |
| Vehicle alone, 1,000 packets | 323 ms | 301 ms |

These are bounded single-run comparisons, not universal throughput claims.

## Fix

`VehicleService.context()` returns fresh identity, connection, and active
transaction state without composing a display report. It still runs `tick()`
and copies the identity. Terrain uses this narrower context on the packet
and send-admission paths. No state is cached; generation, expiry, transaction
precedence, compatibility checks, and send policy remain in place (R-FLT-28).

The camera index now distinguishes loading, missing, malformed, failed, and
successful-empty reports. Failed reads display their safe reason and do not
revive a stale configured report. Direct reactive message-key access handles
the first report arriving after component mount (R-CAM-12, R-UI-20).

No polling interval, client deadline, camera probing rule, flow, driver,
overlay, network configuration, terrain policy, or flight-controller setting
was changed.

## Deployment and live verification

The patch was built from tracked changes on `codex/onboard-terrain-service`
over `02c7bc6`. It is **not part of that base commit**. A future deployment
must include the source changes, not rebuild the unpatched base.

Only these three runtime files were replaced:

| Installed path | SHA-256 after deployment |
| --- | --- |
| `/opt/yonder/packages/yonder-core/dist/mav/vehicle.js` | `d04dfe5fab5af7db2009ec2e6974bbe1a0352ab314b056be11bcc246b8bdd555` |
| `/opt/yonder/packages/yonder-core/dist/terrain/official/runtime.js` | `a50f35473e179046f71eecbf3840b19c5a750ef3e8f009d1d6644e4f8e7ef741` |
| `/opt/yonder/console/node_modules/node-red-dashboard-2-yonder/resources/ui-yonder-index.umd.js` | `fdbc79d32c3ee8054d8bb48557b20af1765c5afd6dfc399ade3452778646091e` |

The console's `yonder-core` dependency resolves to the same core directory.
The root filesystem was briefly remounted writable for installation, then
returned to read-only. Only `yonder-core` was restarted. Router, console,
and camera AIQ PIDs remained unchanged; configuration checksum also remained
unchanged. No reboot or aircraft command was issued by this task.

- Five camera requests completed in **0.912, 1.023, 0.642, 0.481, and
  0.631 seconds**; a later request took **0.649 seconds**.
- Core CPU measured 49.2% of one core over 10 seconds after the queries,
  then 39.0% over a later 15-second window, versus prior saturation near
  one full core. The second window coincided with operator activity, not
  a controlled idle benchmark.
- The live Chrome Cameras page, including a reload, showed
  `m00_b_imx462 2-001a`, CSI `/dev/video0`, and an available Open action.
  It initially reported Idle. A later read reported Running with zero
  restarts while the operator was navigating the console. This task did
  not start the camera and does not claim decoded-frame verification.
- Aircraft telemetry remained connected, system 1/component 1, MANUAL,
  disarmed, with no active command transaction at the final check.
- Terrain remained enabled but incompatible until capability/parameter
  observation; the unchanged gates reported `refresh-terrain-capability`
  and `refresh-terrain-parameters`, with zero terrain packets/bytes sent.
- The pinned complete `N35W084 bench reference` area remained intact.
  The running daemon returned **740.3853374607861 m MSL** at 35.7, -83.36,
  generation `526db36d5d3d01027732ff93a3b9d09a22636d429a7b7311bea0d3fc036f4a2c`.
  No tile, mount hook, initramfs, or existing terrain rollback backup was changed.

## Recovery and source preservation

Original versions of the three files are on the board under
`/var/lib/yonder/captures/camera-detection-fix-20260912.LNg6x2/` as
`vehicle.js`, `runtime.js`, and `ui-yonder-index.umd.js`. Restore them as a
matched set to the destinations above if reverting, restore the root mount
to read-only, and restart core. This rolls back the responsiveness fix too.

`camera-discovery-source.patch` beside those originals preserves the tracked
source/test changes over `02c7bc6`. Apply only after checking the target
revision and existing changes; do not apply it twice to the shared worktree.
Its SHA-256 is
`13026ecdf2be9a2a7dacd9e217eed9118e29eecf1ea67adf5e59d677a2cf571d`.

## Software checks

- Backend build passed. Relevant MAV, all official-terrain, and daemon
  wiring/lifecycle integration tests: **32 suites, 516 tests passed**.
- Dashboard build and TypeScript check passed. Camera index component:
  **36 tests passed**, including empty/error/recovery and first-message arrival.
- Camera adapter nodes: **52 tests passed**.
- Independent integrated code review found no actionable findings.
- Full `scripts/verify-pages.sh`: **219 passed, 0 failed**, including all
  14 base pages in both palettes, camera selection, notebook/tablet layouts,
  telemetry lifecycle, and configuration rollback scenarios. Camera-index
  screenshots in both palettes were visually reviewed. No geometry baseline
  was changed. This is local integration evidence, not a claim about CI.
- The initial page run caught the new widget's first-message reactivity
  mistake. It was corrected with a failing-then-passing regression before
  deployment; the complete page gate was rerun on the final build.
- `git diff --check` passed. At bench deployment the source/test changes were
  uncommitted. This report accompanies the fix commit preserving them on the
  existing terrain PR; the deployed source patch is also preserved separately
  as described above.
