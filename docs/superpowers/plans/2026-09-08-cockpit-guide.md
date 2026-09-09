# Cockpit guide and surface walkthrough

**Goal:** Bring the cockpit user guide up to date, add reproducible screenshots and exercise its instructions in the actual Vue surfaces.

**Scope:** Cockpit only, as selected by the operator. R-FLT-10 (complete walkthrough), R-UI-12 (surface verification), R-FLT-21/22 (units and planning). Existing branch and native cockpit components; no merge, board deployment or physical-aircraft commands.

**Approach:** Keep the detailed reference and add a task-based “How to use it” section. Use explicit fixture data for reproducible UI captures, and a separate disposable QuadPlane for mission/command effects. Record the difference between an exercised UI action, a simulated aircraft result and an unverified hardware feature.

- [x] Check current labels and control paths against the guide; inventory each cockpit surface.
- [x] Add an executable guide walkthrough with assertions and screenshots, including local edit/cancel, review/send, map selection, units, mission actions, terrain/profile, traffic and unavailable states.
- [x] Exercise the documented takeoff/mission path against isolated QuadPlane SITL; record observations and limits.
- [x] Rewrite first-use instructions, insert captioned screenshots, add troubleshooting and link the guide from README.
- [x] Fix concrete defects exposed by the walkthrough with regression coverage; run relevant package checks and inspect captures.
- [x] Verify document links, image provenance and the final rendered guide; commit signed with test evidence.
