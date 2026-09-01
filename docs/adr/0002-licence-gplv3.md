# ADR-0002 — GPL-3.0

**Status:** accepted · **Date:** 2026-08-31

## Context

This category has a pattern: capable stacks get built on open-source components, then
closed — wrapped in filesystem encryption and bytecode obfuscation and sold under a
licence key. The one open project that did the work was archived the moment it became a
business.

Apache-2.0 would maximise adoption, including by commercial integrators. It would also
permit exactly the enclosure that motivated the project.

## Decision

**GPL-3.0.** Not AGPL.

## Rationale

- Copyleft is the mechanism that prevents a closed fork. Given the motivation, any
  permissive licence is self-defeating.
- **ArduPilot is GPL-3.0.** The target community already lives under this licence.
  Rpanion-server is GPL-3.0; BlueOS is AGPL-3.0. Permissive would make us the outlier.
- It makes borrowing from Rpanion-server *legal* where it is genuinely better than
  writing from scratch — turning an all-or-nothing fork decision into a
  component-by-component one.
- AGPL is rejected: its network clause addresses a hosted-service threat we do not have,
  and it deters the small integrators most likely to contribute hardware support.

Dependency licences were checked and none force our hand: mavlink-router (Apache-2.0),
mediamtx (MIT), GStreamer (LGPL), Node-RED (Apache-2.0), pymavlink (LGPL-3.0). Janus is
GPL-3.0, but see [ADR-0003](0003-mediamtx-not-janus.md) — we do not use it.

## Consequences

- A closed-source derivative is a licence violation, not a business model.
- Some commercial integrators will not adopt. Accepted.
- Contributions are taken under DCO sign-off. No CLA, no copyright assignment — this
  project will not be relicensed out from under its contributors.
