# Camera controls and receiver feedback — September 9, 2026

Requirements: R-CAM-11, R-CTL-04, R-CTL-05, R-CTL-07, R-VID-07,
R-VID-19, R-UI-29.

The Camera page now places video state and readings in a solid strip above the
image, gives the image more desktop width, and compacts the gimbal controls.
Unknown joint scales use numeric position readings. Visible labels use Color
and Recenter. Applied flips and rotation transform screen-directed aiming;
changing the applied transform revokes a held gesture without replacing the USB
owner. Native limits, command expiry and fresh-state checks remain in force.

Draft controls show their proposed values, an unsaved indication and a highlight.
The existing Apply/Keep/Revert flow remains responsible for configuration changes.
Outputs offers Enable RTSP even when no outputs exist. Applying it creates an
RTSP output using the existing protected credential; displaying the control does
not enable it. Receive instructions point to the Camera page's Outputs controls.

Native exposure compensation is labeled Brightness (EV), alongside exposure and
white balance. Stream color separately adjusts brightness, contrast, saturation
and hue for Yonder streams and thumbnails. Camera-card files retain the camera's
native settings. Neutral defaults omit the filter from the pipeline. Adjusted
settings insert one videobalance element before the shared raw-video tee, with
no additional queue, decode or encode.

## Adaptive behavior

Previously the browser discarded all reception feedback whenever WebRTC omitted
an incoming-bandwidth estimate. It also ignored the report response, and the
configuration deck displayed a saved starting rate as Going out. These are now
separate facts: unknown capacity still carries loss, RTT and delivery evidence;
report responses update video state; Going out reads the encoder's actual rate.
Frame-age measurements use a consistent monotonic clock.

For browser receivers, fresh healthy delivery earns a bounded upward probe
after five seconds: approximately 10%, limited to 50–200 kb/s per step. Sustained
loss above 2% or RTT inflation above the receiver's recent baseline backs off
25%, subject to a one-second dwell. Applied floors and ceilings always bound
requests. Automatic preview sizes use the existing dwell times and ladder.
Fixed rates and explicitly held sizes remain fixed. Duplicate/stale feedback is
not headroom; unseen outputs hold, and the UI says why. Refused targets are
latched, asynchronous changes do not overlap in this fallback, and completed
requests are removed from pending bookkeeping.

Browser bitrate estimates are retained as estimates, not treated as hard link
capacity. In the live check, an estimate near 400 kb/s still produced a shortfall
while the configured preview remained at 1150 kb/s. Browser receivers now use
bounded delivery probes even when an estimate is present. This also prevents a
configured RTSP output from consuming a separate browser connection's budget.
Legacy independent aggregate-link reports retain the measured-capacity path and
no longer reserve an unused main encode. RTT history is
per receiver and expires, so a bench LAN baseline does not persist indefinitely
on a different path. These are media-path observations, not a modem speed test;
a LAN preview does not validate an independent LTE/ground-station path.

## Processing measurements

Measured on the development Pi 4 at its normal 1.8 GHz maximum, while the existing
camera session remained active:

| Measurement | Median | 95th percentile | Scope |
| --- | ---: | ---: | --- |
| Neutral videobalance probe | 0.26 ms | 0.79 ms | Synthetic 720p I420, 170 measured frames |
| Adjusted videobalance, first run | 3.25 ms | 6.99 ms | Brightness +10%, contrast 110%, saturation 115%, hue +9° |
| Adjusted videobalance, second run | 3.38 ms | 7.16 ms | Same settings and frame count |
| Native Pocket 2 H.264 decode, automatic threading | 57.34 ms | 75.79 ms | 150 captured access units replayed at their native cadence |
| Same access units, slice threading | 60.21 ms | 76.46 ms | No demonstrated latency improvement |

Neutral production settings bypass videobalance entirely; the first row includes
Python pad-probe overhead and is not an added production cost. Adjustments cost
a few milliseconds per frame, not literally zero. The decoder comparison did not
justify changing threading. All 150 access units decoded in both runs.

The page additionally reports interval-average browser jitter-buffer residence
and decode time when WebRTC exposes those counters. These measurements cover
individual stages. They do not establish total exposure-to-display latency or
assign the reported 1–1.5 seconds to USB. A synchronized scene/display observation
is still needed for that total.

Validation before installation: 3,382 core tests, 549 dashboard tests, the final
20-test accessory-source suite, generated schema and full workspace build.
Regression coverage includes congestion/recovery, RTT inflation, stale reports,
multiple receivers, bounds, held sizes, refusal latching, transform cancellation,
RTSP creation, neutral processing bypass and report-response readback.


## Live integration corrections

The first installed UI showed a real 720p live image, 29 ms browser buffering and
3 ms browser decode time in one observation. Buffer residence varied with the
session; this is not a fixed end-to-end latency figure. The native thumbnail
endpoint returned a valid image, while its CSS background painted blank. The
thumbnail now uses a normal image element with fixed sizing.

An Adaptive/RTSP apply exposed two additional defects. Camera Apply used the
ordinary five-second console timeout although rendering continued afterward.
It now gets a bounded 60-second wait; ordinary reads keep their shorter timeout.
When rollback removed an RTSP path while the encoder was in crash backoff, the
renderer skipped it because no process was currently present. Apply and rollback
now update intended running recipes during backoff, while an explicit operator
Stop remains stopped. A regression reproduces removal of the RTSP path between
crash and retry.

Validation: all 3,386 core tests passed after the apply/rollback correction,
along with 60 video-node and 106 picture/thumbnail tests. The final browser-probe
change passed 133 rate, adaptation and daemon wiring tests and the core build.
No decoder threading change was installed.
