# Cockpit control and telemetry integration audit

Audit date: 2026-09-07. Production baseline: `0f1e9b9` on
`claude/exciting-merkle-e4cd39`. The baseline audit below preceded implementation
and commanded no aircraft, simulator, router, network configuration or runtime
service. The implementation and independent simulator verification added after
approval are recorded in the final section.

## Finding

The existing production MAVLink layer carries raw traffic and reports link
health. It cannot yet supply the aircraft data, vehicle commands, or mission
transactions a mission cockpit needs. The integration should add a typed
MAVLink session, measured aircraft state, and explicit operator transactions to
`yonder-core`, then expose these through the existing authenticated console and
package-based Vue instruments. A new visual surface alone cannot satisfy the
requested behavior.

## Current production interfaces

| Layer | Current contract | Consequence for the cockpit |
| --- | --- | --- |
| Router | `packages/yonder-core/src/mav/router/config.ts` generates the UART endpoint, an unconditional `Mode = Normal` UDP copy to `127.0.0.1:14559`, and configured ground stations. The UDP server on port 14540 exists only when network ingest is explicitly opened. TCP also remains subject to the ingest gate. | Use the router's control-plane copy and an explicit loopback return path. Port 14540 is not an existing always-on private command endpoint. Never open network ingest to make cockpit commands work. |
| Decoder | `mav/frame.ts` implements `HeartbeatScanner` for MAVLink v1/v2 heartbeat CRC validation only. `Heartbeat` contains system/component, vehicle type, autopilot and `fromVehicle`; it omits custom mode, base mode and system status. Its comment explicitly calls for a real dialect dependency when full telemetry is implemented. | Adopt and pin a full codec. Do not extend this scanner message by message. Signed-frame length handling is not signature authentication. |
| Listener | `mav/listener.ts` binds UDP only on loopback, parses each datagram independently and calls `LinkTracker.heard()`. It deliberately never sends; the message handler does not retain the router peer address. | Add a deliberate session/transport abstraction with a gated send operation and identified peer. Do not hide command emission in a read callback. Preserve harmless bind failure and independent raw routing. |
| Link state | `mav/link.ts` exposes phase, serial port/baud, detected vehicle/system, heartbeat rate/age, endpoint answering state, traffic history and TCP count. `heard()` updates heartbeat timing, not a persistent command target identity. | Keep this as link health. It is not an aircraft telemetry snapshot or a sufficient target-selection contract. |
| Daemon API | `daemon/routes.ts` defines `MavlinkControl` with `state`, `telemetryRunning`, `routerRunning`, `detectNow`, `startTelemetry`, `stopTelemetry`. `GET /mav/state` returns `{link, telemetryRunning, routerRunning}`. `GET /mav/check` returns the diagnostic chain. `POST /mav/detect`, `/mav/start`, `/mav/stop` operate telemetry plumbing. | There are no production aircraft-state, mission, mode, arm, goto or command-result routes. Preserve existing route meanings; “start telemetry” must never become “start mission.” |
| Daemon transport | `daemon/server.ts` serves HTTP/JSON on its Unix domain socket, mode `0660`. It injects the renderer into the router and starts/closes the loopback listener with the daemon. No aircraft streaming endpoint or WebSocket upgrade handler is present. | Inject the new session and transaction services here. A cockpit stream must be implemented explicitly and must not make the router dependent on this process. |
| Console client | `console/client.ts` has `{method,path,body?}` requests, a 5-second request timeout and 1 MiB response cap. `console/node.ts` floors ordinary page polling at 2 seconds, default 5 seconds. | A mission transfer can exceed the HTTP timeout, and attitude cannot use ordinary settings polling. Return an operation ID promptly and publish result/state separately. |
| Console authentication | `console/settings.ts` installs `consoleGate` through `httpNodeAuth`. `console/middleware.ts` checks an in-memory `SessionStore`, then admits requests. Cookies are `HttpOnly; SameSite=Strict`; the media-statistics proxy derives session attribution server-side with `viewerFor()`. | Reuse the gate and server-derived provenance. The daemon request contract currently carries no authenticated operator identity. A browser-supplied session name or `_client.socketId` is not sufficient command attribution. |
| Dashboard transport | Vue widgets register via `node-red-dashboard-2-yonder/src/widget.ts`. Action widgets use `onAction: true`; all widgets set `passthru: false` to prevent telemetry input becoming an output action. Dashboard owns its socket connection. | A working Dashboard socket is not a reviewed aircraft command API. Socket upgrade authorization, session expiry/revocation and action attribution need explicit tests if commands use that transport. Prefer a dedicated authenticated HTTP command proxy until those guarantees are established. |
| Existing nodes | `node-red-contrib-yonder-mavlink/src/state.ts` reads `/mav/state` and formats the Telemetry/Status panels; `run.ts`, `check.ts`, `endpoints.ts` operate the same plumbing. | Add separate cockpit state/action adapters. Do not repurpose these nodes or place behavior in `flows/flows.json`. |

The current command presentation in `console/command.ts` is shared across the
product: `idle`, `pending`, `confirmed`, `rejected`. Its definition explicitly
groups an unknown outcome with a rejection and labels rejection “Not applied.”
That loses information for an aircraft command: a missing ACK does not establish
that the aircraft did nothing. Add a richer vehicle transaction model and map
its distinct states into the shared visual language without relabeling an
unknown outcome as a proven refusal.

## Requirements and scope

The existing requirements already cover attitude, heading, separate barometric
and GPS altitude, position/GPS quality, speeds, mode/arm state and battery
(`R-TEL-01`–`08`), map/video overlay and pane behavior (`R-TEL-11`–`14`), operator
commands and mode selection (`R-CMD-01`–`09`), useful control feedback and latency
(`R-UI-05`, `R-UI-06`), and authenticated operation (`R-SEC-04`, `09`, `11`).
`R-MAV-11` requires all ArduPilot vehicle types; `R-MAV-12` separately names PX4.
`docs/roadmap.md` places full telemetry in M5 and vehicle commanding in M7. The
integrated cockpit brings those requirements together; update the roadmap to
state that scope rather than claiming link plumbing already delivers it.

No existing requirement specifies mission import/export, draft editing, upload
and readback, active mission sequencing, goto, mission altitude datums or loiter
guidance. Add stable IDs for those behaviors in the same implementation change.
Also state the distinction between protocol acceptance and observed effect, and
the provenance/freshness rules for flight-director and navigation cues. Preserve
`R-CMD-04` and `R-CMD-05`: the autopilot decides whether a request is acceptable
and how to execute it; the console does not run flight logic.

`R-CMD-06` already requires a distinct confirmation for hazardous actions. Make
the confirmation describe the exact requested command, target, altitude datum
and compound steps. Draft edits, map selection and previews must emit no
aircraft messages. The confirmation should bind to the reviewed values and
mission revision so later edits cannot change what is sent.

## Research behavior worth carrying forward

The inspected research sources are `research/g3000-proof/mission_telemetry.py`,
`navigation.mjs`, `sitl_bridge.py`, `mission-controller.js`, `mission-touch.js`
and `mission-control-client.mjs`, with their neighboring tests. The base decoder
is in `research/g3x-proof/telemetry.py`. They are evidence and test-case sources,
not installed production dependencies.

* **Atomic mission publication.** The decoder holds partial items separately,
  checks count and contiguous sequence membership, accepts identical duplicates,
  rejects conflicting duplicates and publishes only a complete mission. It
  preserves command/frame/parameters, including NaN defaults as JSON null, and
  marks unmappable items instead of inventing positions. Content versions permit
  a displayed draft to remain separate from a received mission.
* **Altitude and home semantics.** It distinguishes MSL frames 0/5, home-relative
  3/6 and terrain-relative 10/11. The bridge normalizes equivalent wire frames,
  uses integer mission coordinates with command-aware raw x/y handling, treats
  ArduPilot sequence zero as home, and verifies downloaded values using storage
  tolerances. It explicitly reports that uploading a mission does not set the
  vehicle's home.
* **Navigation tied to receipt context.** The decoder captures navigation mode,
  system/vehicle type, mission sequence and position target at message receipt.
  Mode, current-item and target changes invalidate controller associations.
  The navigation adapter uses fresh, matching ArduPlane controller telemetry for
  AUTO waypoint deviation. GUIDED loiter uses radial error with an IN/OUT
  interpretation; it does not draw that value as straight-leg course deviation.
  Other cases offer a bearing reference or unavailable guidance. Local preview
  geometry remains separately labeled.
* **Explicit serialized operations.** The bridge serializes commands and mission
  transfers, correlates ACK command/recipient fields, waits past IN_PROGRESS,
  distinguishes timeout, and blocks ambiguous repeats. Upload answers only after
  mission ACK and a download comparison. The browser client never retries a
  command automatically. The draft survives a verified upload whose subsequent
  display refresh fails.

## Prototype limitations to resolve in production

1. **Vehicle identity and capability.** The bridge fixes aircraft system/component
   to 1/1, client IDs to 255/190, transport to a dedicated local simulator, and
   its mode and mission catalogs to ArduPlane. Production must discover and bind
   to the selected autopilot, isolate other systems/components, and expose raw
   unknown mode IDs honestly. Do not apply Plane mode numbers or navigation
   semantics to Copter, Rover or another firmware. A catalog documents commands;
   it is not proof that connected firmware advertises or accepts them
   (`R-CMD-03`). Distinguish advertised, known for this firmware, unverified and
   rejected capabilities.
2. **ACK is not observed effect.** `_command()` finishes on a final ACK. It does
   not wait for HEARTBEAT mode/armed state, MISSION_CURRENT sequence, or a reported
   GUIDED target. `continue-auto` currently calls set-current and then AUTO in
   the browser after ACK alone. Move compound operations into the service, expose
   each step, and require the agreed fresh observation before the next dependent
   step. Do not call acceptance proof of reaching a position or achieving a
   payload outcome. Preserve a later observed effect even if the ACK was lost.
3. **Confirmation and provenance.** The research touch actions send immediately;
   its loopback Host/Origin checks are appropriate research containment, not the
   authenticated production boundary or session audit log required by R-CMD.
4. **Reliable mission ownership.** The local operation lock cannot exclude a
   separate ground station. Associate incoming mission transfers with target,
   sender, mission type and session generation. Detect external mission changes;
   invalidate verified revisions and active guidance. Add bounded retry and
   timeout handling for count, requested items, ACK and readback; retain the last
   complete observed mission with explicit synchronization status on failure.
   Preserve unknown imported items and wire fields, and distinguish inspectable
   items from commands supported for editing or immediate execution. Do not
   silently erase them because they are outside the research catalog.
5. **Empty missions and revisions.** Research upload requires 1–1999 authored
   items. Production must define an explicit confirmed clear/empty-upload action,
   draft base revision, concurrent-edit refusal, item-reorder effects on jump
   targets, and actual home updates. Upload is a transaction; it must never
   implicitly arm, start, select AUTO or set home.
6. **Per-field truth.** The base research decoder calls `GLOBAL_POSITION_INT.alt`
   `gpsAltitudeM` and `VFR_HUD.alt` `altitudeFt`; those names alone do not establish
   separate raw GPS versus barometric measurements. Bind displayed labels to the
   actual message definition and estimator/source. Carry source, units, frame,
   datum and age for each relevant field. Missing/stale data must not become zero
   or stay fresh because unrelated packets arrived. Raw GPS altitude and fused
   global altitude need distinct identities. Terrain-relative targets require a
   valid terrain datum; never silently convert them using home altitude.
7. **Flight-director context.** Research `fdReady` checks NAV_CONTROLLER_OUTPUT
   age alone; it can retain targets after a mode transition while still inside
   the freshness window. Gate director bars on fresh attitude, fresh applicable
   autopilot mode/controller context and matching source generation. Keep
   autopilot demanded roll/pitch separate from actual attitude. Do not synthesize
   control demands from mission geometry. Course, heading, track, target bearing,
   nav bearing and radial error need distinct labels and validity.
8. **Stream setup is a command decision.** Research initialization sends recurring
   GCS heartbeats, SET_MESSAGE_INTERVAL and REQUEST_MESSAGE, then downloads the
   mission. Define which telemetry/protocol setup transmissions an explicit
   operator connection authorizes, and their rate/bandwidth impact. Do not copy
   automatic simulator initialization into production and assume it settles
   `R-CMD-04` or cannot interact with autopilot link monitoring. These setup
   messages must never include arm, mode, mission execution or target changes.

## Focused production design

Use a single vehicle-session owner for decode, identity, receive ordering and
bounded protocol transactions, with injected transport and clock. Keep it out of
the ground-station forwarding path. Introduce a `VehicleSnapshot` separate from
`LinkState`: identity and generation; timestamped attitude, velocities and
altitudes; mode/arm state; GPS/battery; actual home; current mission/revision;
reported target; controller output with the context captured when received; and
bounded status text. Snapshot publication should coalesce fast telemetry to a
defined cockpit rate and bound slow-client buffering.

A vehicle operation should retain an opaque ID, authenticated requesting-session
ID, target identity/generation, exact request, mission revision where applicable,
issued/sent/ACK/observation times and separate results:

* transport: queued, sent, failed before send, outcome unknown;
* protocol: awaiting ACK, in progress, accepted, refused, unsupported, timeout;
* effect: awaiting observation, observed, mismatch, unavailable, expired.

These are proposed domains, not existing API fields. Final UI captions should
say “Accepted; awaiting AUTO,” “AUTO observed,” or “No ACK; outcome unknown” as
appropriate. A repeated HTTP request with the same operation token should return
the existing operation, never emit another command. Browser reload/reconnect
recovers operation status and does not replay a flight action.

Suggested route seams, also new rather than current contracts:

| Route | Purpose |
| --- | --- |
| `GET /mav/vehicle` | Latest snapshot, explicit unavailable/stale state and advertised capabilities. |
| `GET /mav/mission` | Last complete vehicle mission, revision and synchronization/transfer status. |
| `POST /mav/operations` | Admit one reviewed operator command or mission transaction; return operation ID promptly. |
| `GET /mav/operations/:id` | Recover protocol and observed-effect state without reissuing the action. |
| Authenticated console stream | Publish snapshots and operation updates, using SSE or a reviewed Dashboard/WebSocket channel. |

The public console proxy validates the live session, same-origin request and
bounded body, supplies provenance itself and forwards over the Unix socket. The
daemon validates request structure and protocol encodability without inventing
autopilot flight-envelope rules. The command service owns transaction sequencing.
The Vue surface owns only local edits, exact confirmation presentation and
explicit action emission. Telemetry callbacks, rendering, timers, and reconnect
handlers never dispatch a flight command.

For goto, keep latitude/longitude, altitude value/unit and datum explicit and
show the actual reported GUIDED target beside the request. For loiter, distinguish
a mode request at the autopilot's own chosen point from an operator-defined
geographic loiter mission item/target with radius, direction, duration/turns and
datum. RTL is a requested autopilot mode, with its actual mode and home data
reported; the cockpit must not calculate and command its own return path.

## Focused files and tests

| Change area | Files/seams | Required evidence |
| --- | --- | --- |
| Requirements | `docs/requirements.md`, `docs/roadmap.md`, cockpit blueprint/manifest | Stable IDs cover mission lifecycle, datums, live navigation provenance, operation outcomes and exact confirmation. Each drawn control has an implementation or named owner. |
| Codec/session | New modules under `packages/yonder-core/src/mav/`; `mav/frame.ts`, `mav/listener.ts`, `mav/router/config.ts`; package manifest/lock | Recorded byte fixtures for v1/v2, malformed/truncated input, integer scaling, extension fields, sentinels, source isolation, identity change and chosen signing policy. Local fake transport proves sends use the intended router path while ingest remains closed. |
| Measured state/navigation | New `mav/telemetry.ts`, `mav/navigation.ts` and tests, or equivalent focused modules | Fake-clock expiration per message/field; heartbeat and mode transition invalidation; packet-order associations; heading/track distinction; separate altitude sources/datums; actual versus demanded attitude; AUTO XTE signs and GUIDED radial signs; no geometry promoted to live autopilot guidance. |
| Operations | New `mav/commands.ts`, `mav/mission.ts` and tests | Accepted/refused/unsupported ACKs, IN_PROGRESS, loss before/after send, stale/wrong-source ACK, late ACK and repeated same command, observed state without ACK, ACK without effect, link-generation change, duplicate HTTP token, bounded queues and no replay on reconnect. Compound set-current/AUTO stops on an unobserved/refused first step. |
| Mission transactions | Same mission module plus canonical import/edit/export helpers | Out-of-order and duplicate items, omitted item, conflicting duplicates, wrong target/type, unexpected count, timeout at every phase, external change, empty mission, home versus mission-zero, raw non-position x/y, NaN/default preservation, float precision, readback mismatch, invalid jump target after reorder, concurrent draft revision and draft preservation after failed readback/display refresh. |
| Daemon wiring/API | `daemon/routes.ts`, `daemon/server.ts`, `daemon/routes.test.ts`, `daemon/server.wiring.test.ts`, `src/index.ts` | Injected service tests cover 400/403/409/503, early operation response, unknown outcome recovery, body bounds and shutdown cleanup. Console/core failure leaves raw routing and reachability intact. |
| Console auth/stream | `console/middleware.ts`, `console/wiring.ts`, `console/session.ts`, `console/client.ts` and tests | Unprovisioned/unauthenticated requests emit zero commands; revoked/expired session, forged session fields, cross-origin request, oversized body, slow/disconnected stream and reconnect. If using sockets, test actual upgrade and action paths rather than assuming HTTP middleware protects them. |
| Package UI/wiring | `node-red-contrib-yonder-mavlink/src/`; Vue cockpit components under `node-red-dashboard-2-yonder/src/ui/`; `flows/flows.json` wiring only | Node helper tests prove polls/replayed messages emit no actions. Browser tests press every control through the installed production path: edit and cancel, exact confirmation, denied command, timeout, observed effect, draft upload/readback, target/datum/loiter behavior, AUTO/GUIDED/RTL, stale instrument flag and small viewport. |
| Installed console validation | Existing `scripts/verify-console.sh`, gallery/capture and installer package manifests | Run required package tests/build/lint, then browser geometry and legibility checks in both palettes with every hidden cockpit state captured. Ensure the installer and capture harness install the same packages. |

## Implemented service and verification

The approved integration now adds `mav/types.ts`, `protocol.ts`,
`vehicle-telemetry.ts`, `vehicle.ts` and `mission.ts` in `yonder-core`. The codec
uses pinned `node-mavlink` 2.3.0. `VehicleService` accepts an injected
`send(Uint8Array)` callback, `Clock` and audit logger; its public methods are
`receive(Uint8Array)`, `snapshot()`, `submit(OperatorRequest)` and `close()`.
Daemon transport, authenticated console routes and native dashboard integration
are separate changes with their own tests.

The snapshot preserves the prototype's flat PFD telemetry fields while adding
source, age and validity metadata. Raw GPS and fused global altitude remain
separate. Navigation captures receipt context and expires across mode, mission
sequence, target and vehicle-generation changes. A mission includes the actual
ArduPlane home at sequence zero; canonical geographic `x`/`y` values are degrees,
local coordinates are metres, and non-geographic command fields retain raw values.

An authenticated command request carries `id`, server-injected `sessionId`,
`vehicleGeneration`, optional `expectedMissionRevision`, `confirmed` and a typed
`action`. Admission returns an operation ID immediately. The service keeps one
active transaction and retains at most 256 operations/idempotency guards per
service lifetime; it refuses further admission at that bound. It emits nothing
at initialization. Explicit stream setup requests telemetry rates and home/version
messages. Commands require the selected fresh autopilot generation, and writes
have a single injected transport path. Timeouts preserve unknown outcomes;
ordinary command retries are never automatic.

The implemented actions are mode, arm/disarm, GUIDED target, set-current,
continue-AUTO, mission-start, mission download/upload/clear, explicit stream
setup and six immediate peripheral command forms. Continue-AUTO observes the
selected sequence before sending AUTO. ACK acceptance and fresh observed state
have separate fields; a payload ACK does not claim a measured physical effect.
Upload only becomes verified after the accepted mission is fully downloaded and
compared. Readback preserves the actual autopilot mission and reports a mismatch
without calling it a refusal. The copied 55-form mission catalog supplies basic
syntax/range checks and preserves unknown encodable command IDs.

Verification commands:

```sh
npm run build -w yonder-core
npm test -w yonder-core -- src/mav/
node packages/yonder-core/scripts/vehicle-sitl-smoke.mjs --firmware-dir DIR --output docs/console/evidence/cockpit-sitl-smoke.json
```

The MAVLink suite passed 238 tests, including 30 new codec, mission and service
tests. Serialized bytes, rather than mocked decoded objects alone, cover v1/v2,
CRC failures, extension truncation, signed-envelope exclusion, integer command
parameters, mission coordinates and defaults. Fake-clock tests cover per-field
expiry, context invalidation, identity changes, malformed request rejection,
ACK/IN_PROGRESS/refusal, fresh observation without an ACK, late-ACK quarantine,
idempotency bounds, compound-step ordering and atomic upload/readback.

The opt-in smoke requires checksummed official ArduPlane 4.7.1 firmware and
default parameters supplied through `DIR`. It creates a uniquely named,
task-owned Docker simulator with its own data directory, listens only on loopback
port 5764, and removes only that simulator after the bounded run. It does not
attach to an existing research preview, simulator or physical aircraft. The
[recorded evidence](console/evidence/cockpit-sitl-smoke.json) covers explicit
stream setup, mission download, upload/readback, ordinary arm, AUTO takeoff,
GUIDED target observation, LOITER and RTL. The autopilot's ordinary arming checks
remain enabled. An earlier fresh-instance run refused arm while the gyros were
settling; that refusal was reported without force-arm or automatic retry.

Remaining limits belong to the vehicle-service integration owner:

* Aircraft command handling is currently verified for ArduPlane. Other firmware
  retains telemetry and raw mode IDs; Plane mode numbers are not applied to it.
* Mode and immediate-action entries are explicitly `firmware-known`; dynamic
  advertised capability discovery remains outstanding under `R-CMD-03`.
* The 55 mission forms are encoding/editing knowledge, not proof of peripheral
  support by the connected autopilot. Only six forms support immediate execution.
* Signed MAVLink is not authenticated by this adapter and is excluded from its
  aircraft state/command service. Independent raw routing is unchanged.
* Direct terrain-relative GUIDED targets are refused. MSL and home-relative
  requests retain their explicit wire datum; equivalent reported MSL targets use
  actual home telemetry for comparison.
* A wire MSL altitude does not identify its geoid model. The optional
  `telemetry.altitudeDatum` field is supplied by explicit configuration; unknown
  remains unknown. No physical-aircraft or peripheral-actuation test is claimed.
