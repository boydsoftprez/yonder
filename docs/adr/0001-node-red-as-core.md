# ADR-0001 — Node-RED as the core, with logic in custom nodes

**Status:** accepted · **Date:** 2026-08-31

## Context

Node-RED is a mature, widely deployed flow runtime with a large node ecosystem and an
established dashboard. It is a credible core for a device control plane, and comparable
products in this space use it.

Arguments against making it our core were: `flows.json` is unreviewable, function nodes
are arbitrary JS as root, no CI or unit tests, one runtime means no fault isolation, and
~200–250 MB RSS does not fit a Pi Zero 2 W's 512 MB alongside GStreamer.

The alternative was purpose-built services on a local bus, with Node-RED as an optional
extension.

## Decision

**Node-RED is the core.** It serves the UI and orchestrates the other processes.

**With one binding constraint: logic lives in custom node packages, never in function
nodes.** The shipped flows contain wiring only. `functionExternalModules` is disabled and
the `function` node type is not enabled in the shipped profile.

## Rationale

The simpler architecture is the right default, and it is the proven one. Four of the five
objections are answered by the constraint rather than by the architecture:

| Objection | Answer |
|---|---|
| `flows.json` unreviewable | Logic is in source files; flows are thin wiring |
| Function nodes = RCE as root | Node type disabled by default; opt-in only |
| No CI / unit tests | `node-red-node-test-helper` runs node packages in CI |
| No fault isolation | Real, accepted — see below |
| Memory on Zero 2 W | Real, unsolved by architecture — a per-board profile problem |

Fault isolation: raw MAVLink to ground stations goes through `mavlink-router`, a separate
process, in every design. A Node-RED restart does not interrupt telemetry to Mission
Planner. What a crash costs is the UI and camera supervision for the couple of seconds
systemd takes to restart it. On a vehicle where the Pi is not flight-critical, that is an
acceptable trade for the simplicity.

## Consequences

- One thing to install, one log, one place to look.
- The node ecosystem is available to users, which is a genuine feature for this audience.
- The migration path stays open: a clean node package can be lifted into its own process
  later. Logic in function nodes could not be.
- The flow editor ships **password-gated** with a per-device password set at setup, not
  reachable from the cellular interface by default.
