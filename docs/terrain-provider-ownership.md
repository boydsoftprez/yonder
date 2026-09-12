# Terrain-provider ownership with multiple ground stations

Recorded: 2026-09-11. Status: **operator-managed single responder approved for this PR; exclusivity is not enforced**.

Owner: the Yonder terrain-service implementation. Revisit before enabling the responder in a multi-ground-station deployment, before claiming exclusive source provenance, and before closing the protocol integration task. This supplements R-FLT-02/05/08/23/26 and the planned official-terrain requirements R-FLT-27/28.

## What the controller actually does

The tested ArduPlane 4.7.1 implementation does not elect a preferred terrain sender. Its TERRAIN_DATA handler matches geographic origin, spacing and grid bit against an existing cache entry, then writes the received heights. It does not choose a provider by sender system/component ID or retain a provider identity for each sample. A later accepted reply can overwrite the same samples, and different subgrids can come from different senders.

This applies after ordinary message admission: it does not imply that invalid frames or otherwise rejected links bypass MAVLink validation. TERRAIN_DATA itself carries no target fields, source dataset identity, version priority or provider-ownership token. Different GCS IDs alone do not establish authority. Terrain capability, a matching TERRAIN_REPORT height, or Yonder transmitting successfully does not prove that Yonder supplied every value currently cached in the FC.

Consequences include duplicate bandwidth, mixed source generations and conflicting heights. Preparing the same named dataset on every station reduces some disagreement but does not provide exclusivity or prove identical content.

## Approved policy and its boundary

The operator selected one active terrain responder per aircraft for this PR: Yonder serves prepared data onboard, and the operator disables terrain delivery in other ground stations. Other ground-station functions remain available. The PFD must identify this as operator-managed and explicitly state that exclusivity is not enforced.

Filtering inbound TERRAIN_DATA at Yonder's routing boundary could enforce ownership for traffic that traverses that boundary. It cannot cover a GCS connected directly to another FC UART, USB port or independent radio. Enforcement over every route would require supported FC-side filtering/provider selection or an explicitly controlled topology. Routing changes also need their own command, reachability and rollback review.

Passive observation can reveal a competing responder but cannot prove its absence: another sender may be idle or on a route Yonder cannot observe. Do not label exclusive ownership as verified solely because no competing packets were observed. If source identity is used for filtering, distinguish an unauthenticated MAVLink ID from authenticated identity.

## Integration contract

The approved contract is operator-managed single responder. Observe competing TERRAIN_DATA on the existing route and report fresh competition without treating its absence as proof of exclusivity. Handover is deliberate: disable Yonder through its configuration workflow before enabling another responder. Do not introduce automatic provider failover, routing filters, or silently discard another GCS's traffic. Enforced exclusivity is outside this PR and remains a documented future decision.

Independent work on source validation, storage, coverage and sampling can continue. Multi-station exclusivity and provenance claims remain open until the chosen mechanism and its boundary have been tested. Do not treat this as a reason to block unrelated telemetry or ground-station access.

## Required acceptance evidence

- Two responder identities supplying identical data: measure duplicate traffic and verify the chosen ownership policy.
- Two identities supplying conflicting heights for the same subgrid: exercise both arrival orders and show exactly what is admitted, rejected or reported. Never describe arrival order as an authority rule.
- A second responder connected directly to an FC port: demonstrate the bypass boundary and ensure the PFD does not claim Yonder-enforced exclusivity there.
- A competing sender that becomes active after initial setup, plus responder restart and link reconnect: ownership observations must remain honest and fresh.
- Explicit handover and unavailable Yonder data: preserve the selected policy without inventing elevations or silently switching sources.
- When routing enforcement is selected, verify that ordinary telemetry, operator commands, mission traffic and recovery connectivity still work.

## References

- [Pinned ArduPilot terrain-data handler](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/TerrainGCS.cpp)
- [MAVLink terrain protocol](https://mavlink.io/en/services/terrain.html)
- [Approved terrain design](superpowers/specs/2026-09-11-onboard-terrain-service-design.md)
- [Implementation plan](superpowers/plans/2026-09-11-onboard-terrain-service.md)
- [Simulated-GPS bench evidence](terrain-controller-gps-simulation.md)
