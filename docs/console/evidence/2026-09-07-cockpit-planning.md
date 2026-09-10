# Flight units and terrain planning (R-FLT-21/22)

The operator requested selectable units, touch waypoint altitudes, estimated
waypoint AGL, a FROM-to-active connector and a terrain/obstacle planning profile.
These are implemented in the native cockpit components. The existing mission
and command transport remains unchanged.

## Delivered behavior

- Feet/metres, knots/mph/m/s and ft/min/m/s selections persist with PFD preferences.
  Unit-aware inputs retain SI command/mission values. Instrument values and local
  references keep their existing canonical storage. Wind depiction and requested
  altitude/airspeed annunciation use the selected units.
- A separate altitude button on each mission row opens the draft editor. The
  active leg has a magenta bracket and target arrow; ordinary adjacent FROM/TO
  rows remain visible while following. Drafts suppress the aircraft-active marker.
- The profile distinguishes planned altitude, ground and mapped surface; shows
  independent coverage; provides waypoint selection and a distance slider; and
  exposes datum, source, survey dates and limitations. Waypoint AGL uses the same
  validated native samples. Source changes invalidate estimates and cancel work.
- Reads use the existing selected data provider. The route has at most 2,048
  samples, 192 native tiles, a 32 MiB decoded cache and two concurrent tile reads.
  Aircraft-proxied route loading has a separate explicit load control. It does not
  silently fall back from ground data to aircraft downloads.

## Validation

- **741 dashboard tests across 65 files passed.** Production dashboard/widget
  builds passed. New tests cover conversion and quantity preservation, SI review
  requests, draft-only altitude editing, datum/coverage rejection, terrain cache
  reuse and source invalidation, mission discontinuities, explicit aircraft-source
  loading and profile-control stability while home altitude changes.
- The automated browser walkthrough passed laptop, landscape tablet, portrait
  tablet and phone layouts. Larger layouts also checked the active FROM/TO bracket,
  row following, a 600-ft draft altitude edit, restoration of the aircraft mission,
  and opening the profile. Laptop interactions checked mph/m/s depiction and a
  500-ft entry converting to 152.4 m without changing its value. No vehicle requests
  were made by this fixture walkthrough.
- The landscape tablet mission capture was inspected against the operator's
  reference: FROM WP08 and active WP09 are visibly joined by the magenta bracket,
  ALTITUDE/AGL cells are distinct from waypoint buttons, and WP10 is marked next.
- The live preview's stored VTOL mission rendered against the existing USGS 2016
  Cove EGM96 pack: **100% ground and 97% mapped-surface coverage** along the sampled
  route. Its profile shows the 180-ft takeoff target followed by the 300-ft-above-home
  route. The inspector at about **0.75 NM** showed **312 ft AGL** and **304 ft above
  mapped surface** during the check. Values are estimates based on that home
  reference and survey, not aircraft measurements at the remote point.
- The first live slider interaction exposed a transient unmount during home
  updates. The replacement keeps its controls mounted and swaps calculated data
  atomically. A regression test and a successful subsequent live slider interaction
  verified the fix. The preview remained **QRTL / disarmed**; no arm, mode,
  altitude, speed or mission-upload command was issued to it by this work.

## Explicit limits

The centreline is sampled, with approximately two-metre spacing for this demo.
It is not a swept-volume obstruction check. Missing surface data stays unknown,
and unobserved objects or small peaks between samples are not certified absent.
Ordinary MSL legs interpolate endpoint heights; terrain-relative endpoint pairs
interpolate ground offsets. Actual climb capability and turn arcs are not modeled.
Loiter, return/landing and unresolved jump geometry are omitted and labeled.

The existing ArduPlane 4.7.1 altitude command accepted nonzero rate requests but
did not achieve the requested climb in the earlier isolated test. That evidence
remains in [the protocol record](2026-09-07-flight-control-protocol.md).
[Upstream issue 33846](https://github.com/ArduPilot/ardupilot/issues/33846) describes
the same rate-response problem. The interface calls the value a requested rate,
explains the limitation and does not present VS or IAS/FLC capture as available.
No new autopilot firmware was installed or tested in this change.
