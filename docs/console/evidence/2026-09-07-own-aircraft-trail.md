# Own-aircraft breadcrumbs — R-FLT-15

The production cockpit now depicts a gold dotted observed path with a dark
outline over both grid and hybrid maps. The map's Trail button and Display &
data expose time, travelled-distance and since-power-on windows, mi/NM units,
show/hide and browser-local clear/restore.

The passive recorder consumes fresh selected-aircraft positions and a valid GPS
fix. Its boot clock comes from
[GLOBAL_POSITION_INT](https://mavlink.io/en/messages/common.html#GLOBAL_POSITION_INT).
Three advancing lower-clock samples spanning at least half a second establish a
new boot observation epoch; isolated delayed samples are ignored. The uint32
clock wraps without creating a reboot, including a delayed pre-wrap datagram.
Same-aircraft reconnection preserves history with a segment break. Vehicle
replacement starts new history. No recorder path submits a vehicle command.

The service retains at most 20,000 points in memory. Compaction preserves segment
endpoints and marks older detail as simplified; extreme fragmentation explicitly
marks truncated history. Service restart and late telemetry attachment cannot
recover observations that were not retained. The UI reports the first recorded
point's time after autopilot power-on.

Flight responses carry only the summary/latest point. Missing history uses
authenticated GET pages of at most 1,024 points, filtered on the aircraft by the
selected time or distance window. Distance uses cumulative observed travel,
including turns, and excludes unknown travel across gaps. Hidden depiction does
not initiate history recovery. Browser settings never change flight state.

## Verification

- Complete workspace suite: 3,801 tests passed before the final review correction.
  After the correction, all 655 dashboard tests passed; unchanged core tests
  numbered 2,804. Build and lint passed; the final dashboard bundle also rebuilt.
- Regression coverage includes byte-decoded real MAVLink positions, passive
  recording, reconnect/aircraft replacement, reboot, rollover and late packets,
  invalid fixes/positions and jumps, retention bounds, paged window recovery,
  route authentication, time/distance filters and local clear/restore.
- Code review found stationary async recovery did not invalidate map geometry.
  A failing regression reproduced the unchanged render key. The fix includes
  recovered-point progress, so drawing no longer waits for aircraft movement.
- The fixture browser check passed laptop, tablet, portrait and narrow layouts,
  exercised distance/power settings and actual SVG clear/restore, inspected the
  outlined trail, and recorded zero vehicle requests.
- A separate ArduPlane 4.7.1 instance on API port 4203 / vehicle port 5772 flew the
  Cove mission after explicit reviewed browser upload, arm and start. The page
  on port 4198 was reloaded while flying. The service retained its original first
  point and boot epoch; the browser recovered and drew the path. Detailed local
  terrain was prepared from a ground relay on port 4199. Earlier previews and
  simulator state were left intact.

[Recorded live measurements](2026-09-07-own-aircraft-trail.json) show 60 points /
1,203.3 m before reload and 375 points / 8,679.1 m at the later check, without a
recording gap. That later sample used 1,858 bytes of recurring flight JSON;
16,798 bytes represented the full retained history read for evidence, not every
flight update. These figures exclude transport overhead and public map data.
