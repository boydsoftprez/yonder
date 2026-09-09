# Ground traffic recovery

R-FLT-07/11. Verified against the native Vue cockpit and an isolated, disarmed
ArduPlane SITL preview on 2026-09-07.

The original preview had lost its flight API when Docker stopped. With no fresh
aircraft position, the browser correctly withheld geographically scoped traffic
queries. The simulator service was restarted disarmed; no arm, mission-start or
flight-path command was sent during this repair.

ADSB.lol returned HTTP 403 to the ground relay's generic Node request identity,
with a response asking for valid project contact information. The Yonder project
identity returned HTTP 200 and actual traffic observations. Responses lacked
browser CORS permission on this network, so the preview explicitly selected the
laptop ground relay. The browser subsequently reported two actual targets within
10 NM. Provider HTTP 429 responses also occurred: this is evidence of successful
ingestion and intermittent availability, not a continuous-service guarantee.

The repaired relay sends the project identity, reuses identical traffic searches
for five seconds and shares provider cooldowns across ranges and clients. The
browser polls public traffic every five seconds, honors Retry-After, distinguishes
empty searches from connection/rate errors, and preserves the two-second explicit
aircraft-proxy read cadence. It never selects the aircraft connection as fallback.

Follow mode previously replaced any zoom below level 10 with level 14 on the next
telemetry render. The browser regression reproduced this snap-back. Follow now
preserves the chosen zoom after first centering. Fit traffic range frames the
selected radius without sending an aircraft command.

Validation:

- 700 dashboard tests in 54 files passed.
- Three ground-relay HTTP tests passed, including project identification and
  shared cooldown behavior.
- Production widget build passed.
- Native Chromium fixture checks passed for laptop, tablet, portrait and phone,
  including traffic-range framing, retained zoom across updates, breadcrumb
  geometry and zero vehicle requests.
- Regression tests were observed failing before their corresponding changes.

Traffic in synthetic vision still requires a locally imported EGM96 geoid,
geometric target altitude, compatible ownship altitude and a target in the forward
field of view. The geoid import lasts for that page session. Tests do not establish
continuous public coverage or latency; stale targets expire under the existing
observation rules.
