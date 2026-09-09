# Pocket 2 preview recovery — 2026-09-09

Requirements: R-CAM-14, R-VID-14, R-UI-29.

## Observed failure

After a page reload, the browser fell back to stills and its thumbnail was
hours old. The camera source still supplied fresh 1280×720 video at about
30 fps and current gimbal telemetry. The encoder process was reported running,
but a local RTSP decoder received no frames within twelve seconds. This was
an encoder failure, not evidence that the camera had powered off.

A bounded debugger attachment captured the encoder's threads and then detached.
The main thread was blocked in GStreamer pad deactivation/state change. A
temporary capture queue was waiting on an element state lock, and the source
feeder was blocked behind the graph. Temporary thumbnail file descriptors were
still open. This identifies a stalled dynamic graph; it does not establish
every possible source of an encoder stall.

## Corrections

- Temporary capture file sinks disable asynchronous preroll and clock waiting.
  Their insertion must not send the live parent pipeline through another state
  transition. GStreamer's [BaseSink documentation](https://gstreamer.freedesktop.org/documentation/base/gstbasesink.html)
  describes the asynchronous parent notification that is disabled here.
- The encoder host watches actual encoded-frame progress. It permits fifteen
  seconds for initial output and five seconds without progress after frames have
  arrived. A stalled host exits for the existing supervisor to recover. It does
  not attempt another potentially blocked graph teardown, restart the core, or
  issue a command to the camera.
- Automatic stills fallback retains the viewer's request for live video. After
  five seconds it makes another bounded live attempt. Explicit Stills or Off
  choices and widget removal cancel recovery.
- Playback is started explicitly with the media element muted. If the browser
  refuses playback, a Resume live video action is available on the page.
- Freshness uses presented-frame callbacks where supported, with a timeupdate
  fallback, and a monotonic clock. A wall-clock correction cannot invent a
  period without frames. Callbacks from a retired session are ignored.

## Validation and deployment

The patched host produced fifty complete JPEGs from a synthetic live GStreamer
pipeline on the Pi. The main branch delivered 108 frames and there were no
parent-pipeline state changes during those captures. The host tests passed 38
cases, including bounded stalled-output recovery. The final browser tests passed
101 cases, including automatic recovery, explicit-mode cancellation, playback
refusal, stale callbacks and wall-clock changes. The widget build passed.

Only the encoder host and picture browser bundle were updated. The stalled
encoder was stopped and started through the existing camera-run API. The core
and console processes were unchanged; the camera's USB control generation stayed
at seven and native input remained live.

A local decoder then received thirty preview frames without error. Three page
reloads with the final browser bundle each returned live 1280×720 preview video,
with observed playback times of 16.343, 18.478 and 21.858 seconds at inspection.
Thumbnail age was three seconds in each of those checks. This verifies reload
recovery in the observed cases, not indefinite fault-free operation.
