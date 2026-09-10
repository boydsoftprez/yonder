# Telemetry disconnect status implementation plan

**Goal:** Make a silent GPIO telemetry link visible and recover its displayed heartbeat rate when the flight controller resumes (R-MAV-10, R-UI-11).

**Evidence:** With the GPIO lead removed and replaced, the router remained active while the UART receive counter stayed unchanged. The operator restarted the flight controller and traffic returned. Re-detection happened at the same time, so it does not establish a Pi-side recovery mechanism. No automatic router restart or autopilot command is justified by this observation.

**Architecture:** Keep serial detection and routing unchanged. Use the path check's existing three-second heartbeat timeout for the live annunciator and rate. A new heartbeat after an outage starts a new rate sample; one arrival confirms presence but cannot establish a rate.

**Files:** `packages/yonder-core/src/mav/link.ts`, `packages/node-red-contrib-yonder-mavlink/src/state.ts`, their adjacent tests, and `docs/requirements.md`.

- [x] Add regression tests for a stale rate, resume without an intervening poll, absent first heartbeat, and disconnect/reconnect presentation.
- [x] Run the tests against the existing implementation and verify behavioral failures.
- [x] Expire the rate at three seconds and clear its history on the first post-outage arrival. Use the same timeout in the live link and heartbeat arrow.
- [x] Run core and MAVLink node tests and TypeScript builds; review the complete diff.
- [x] Install only verified changed modules on the development board with backups, preserving the router process, then verify live heartbeat and ground-station traffic.


## Verification

- Core: 1,819 tests passed. MAVLink nodes: 105 tests passed, including seven new disconnect/recovery cases demonstrated failing before the fixes.
- Core and MAVLink node builds, repository lint, and diff whitespace checks passed. Independent code review found and resolved a first-returning-heartbeat arrow inconsistency.
- Installed the six changed JavaScript/declaration artifacts on the development board after matching the previous installed code hashes and saving a rollback copy. One old declaration file differed only in its documentation; its actual hash was checked separately.
- The router kept the same process and start time across the control-plane and console reload. Live heartbeats remained about 1 Hz and outbound telemetry continued. The newly restarted status tracker had not observed a fresh ground-station reply in the final sample.
- Executed the installed modules against a simulated clock on the board: timeout, first returning heartbeat, and restored 1 Hz rate all passed without opening the serial port.
- The physical flight-controller stall is not diagnosed by this patch. The operator's flight-controller restart restored transmission. A 12-second passive sample after recovery measured heartbeat at 1 Hz, attitude/HUD at about 4 Hz, and position at 2 Hz; stream settings were not changed.
