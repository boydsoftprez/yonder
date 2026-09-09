# Flight planning controls implementation plan

**Goal:** Make units selectable across flight instruments and controls; provide touch waypoint altitudes, active-leg bracket and terrain/surface profile.

**Architecture:** Keep MAVLink and stored references in their existing canonical units. Add pure conversion and planning adapters, Vue presentation components and bounded ground-provider terrain reads. Preserve the existing authenticated review/send path.

**Scope:** User-approved cockpit extension in docs/cockpit-integration-design.md; R-FLT-03/04/08/13/20, with new units/profile requirements in this change. Firmware modifications are not selected. Current GUIDED rate limitation remains explicit.

- [x] Add conversion tests for feet/metres, knots/mph/m/s and ft/min/m/s, preserving physical quantities during unit changes. Add shared input/unit controls. Wire instrument values, local references, aircraft request forms and mission altitude/speed parameters.
- [x] Extract the mission list into a component. Draw a magenta FROM-to-active bracket with target arrow; keep both endpoints visible when following ordinary adjacent legs. Add distinct altitude cells which open the existing draft editor; preserve missing values as unavailable.
- [x] Add a pure route adapter resolving MSL/home/terrain altitude, geographic leg boundaries, jump/loiter gaps, cumulative distance and bounded samples. Unit-test missing coverage/datum, sign, altitude interpolation and discontinuities.
- [x] Load native ground/surface samples through the selected ground provider with cancellation, revision checks, bounded tile/byte counts and concurrency. Do not create a new public service or aircraft download fallback.
- [x] Add a profile view with separate ground, mapped surface and planned altitude, waypoint selection, coverage/source/date and sampled clearance. Label straight-leg interpolation and omitted turn/loiter geometry. Feed waypoint AGL estimates to the list.
- [x] Run focused tests, complete dashboard suite/build, fixture browser walkthrough and actual ground-data profile check. Do not arm or move the existing simulator. Document evidence, remaining firmware limitations and usage. Review and sign the completed commit.
