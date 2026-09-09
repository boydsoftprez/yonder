# Mission list and CDI sequencing (R-FLT-03/20)

The list previously highlighted an item without following it or showing its next
planned geographic target. The HSI course also used ArduPlane's steering bearing,
which varies with cross-track capture, rather than the uploaded leg course.

The list now shows FROM → TO and NEXT IN PLAN, marks both rows, and follows the
active row on sequence changes. Manual scrolling or touch pauses following; its
footer control restores it. Drafts and stale/unverified mission state do not show
aircraft-active badges. Planned-next traversal stops at jumps and return commands.

Both deviation displays use the uploaded leg course and the same fresh autopilot
cross-track error. Target coordinates, target distance/bearing, sample position
and geometric path error must agree before a sample is attached to the leg.
These checks address navigation packets straddling a mission-current update.
When the autopilot is flying a different path origin, target bearing remains
available but the cockpit does not invent a lateral course. Source interpretation
is recorded in the component's PROVENANCE.md.

## Verification

- Dashboard: **727 tests across 60 files passed**; production widget build passed.
  New cases cover leg changes, opposite deviation directions, old-target samples,
  unverified missions, jump boundaries and a current-location VTOL takeoff origin.
- Browser fixture: laptop 1440×900, tablet 1024×768, portrait 768×1024 and phone
  390×844 passed the existing responsive walkthrough. Laptop/tablet/portrait also
  advanced the fixture through WP03 and WP09, checked both CDI displays, verified
  the active row scrolled into view, and exercised pause/resume following.
  The browser test reported no aircraft requests. Tablet mission and phone full
  captures were visually inspected; this is fixture evidence, not a flight.
- A separate real ArduPlane 4.7.1 QuadPlane SITL flew the VTOL demo through route
  items 02, 03 and 04. It climbed vertically to the 180-ft transition threshold
  and continued toward the 300-ft route. The tracked smoke script asserts each
  leg has multiple valid CDI samples, matching displayed/source sequence and
  predecessor, finite course and bounded deviation. The test exited successfully
  and removed its disposable simulator.
- The existing user preview was refreshed and its already-stored 14 executable
  mission items were read back. It remained QRTL and disarmed. No flight-changing
  request was issued to that simulator.

The completed SITL observation window was 2026-09-08 01:24:32–01:26:16 UTC
(September 7 locally). The compact [record](2026-09-07-cockpit-sequencing.json)
retains sample counts, courses and an example observation for each leg:

| Active target | Valid CDI observations / all samples | Fixed leg course, true |
|---|---:|---:|
| WP02 | 14 / 16 | 101.829° |
| WP03 | 25 / 25 | 1.574° |
| WP04 | 19 / 20 | 38.298° |

Unavailable samples remain unavailable; they are not interpolated into guidance.
This flight validates the ordinary uploaded route and VTOL-origin case, not all
possible mission jumps or external route changes.

Reproduce with the checksummed firmware inputs documented by
`packages/yonder-core/scripts/quadplane-sitl-smoke.mjs`, build `yonder-core`, then
run that script with `--firmware-dir DIR --output FILE`. The smoke always creates
its own simulator. For UI checks, use the package's `cockpit:dev` fixture and
`cockpit:verify` scripts; the fixture has no vehicle transport.
