# Adaptive bitrate for external RTSP receivers

R-VID-07, R-VID-08 and R-UI-29 require the selected mode to describe behavior
that actually occurs. RTSP players such as QGroundControl have a separate
receiver-feedback path from the browser preview.

## Control loop

The daemon samples existing MediaMTX RTSP sessions once per second. For TCP it
also reads Linux socket statistics: acknowledged bytes, recent delivery rate,
round-trip time and queued bytes. For UDP it reads RTCP activity and the loss
reported by the receiver. Both transports include video discarded by MediaMTX
before transmission. Incoming publisher-loss counters are not receiver loss.

Only configured main-stream paths and external active readers participate.
Loopback and the device's own addresses are excluded. Each receiver retains its
own counter baseline; reconnects, counter resets, absent fields, time jumps and
stale samples cannot become evidence of spare bandwidth. Missing feedback from
an active reader prevents increases. An unreachable observer withdraws its old
measurements and is reported as unavailable.

Adaptive lowers the existing encoder target when sustained queue pressure,
reported loss or server discards indicate congestion. A congested TCP reader's
acknowledged delivery can justify a faster downward step. Healthy delivery earns
small upward steps after a dwell interval. A short keyframe burst is evaluated
against the kernel's recent delivery rate, rather than treating the offered
average video rate as total connection capacity. Every target remains within the
applied minimum and maximum. Fixed mode never retunes itself.

The existing encoder channel remains the sole writer. Refused targets are not
repeated indefinitely, and an encoder-reported interruption pauses automatic
retunes until the policy changes. This feature does not change encoder bitrate
mode, camera orientation, flight controls, or the USB driver.

## Operator-visible states and limits

The Stream column shows the encoder target, controller decision, RTSP feedback
state and available delivery/loss/queue readings. A draft selection is explicitly
staged until Apply. Waiting, incomplete and unavailable feedback are stated;
selecting Adaptive is not presented as proof that a reader is being measured.

All readers of the same camera share its encoding, so a constrained receiver
can reduce the quality seen by other readers. The browser preview retains its
separate encoding and feedback loop. A plain outbound RTP push supplies no RTSP
feedback; the page explains that a feedback-capable receiver is needed.

Bitrate changes preserve the configured resolution and frame rate. If congestion
persists at the minimum, the page states that limitation and points to reducing
the minimum, resolution or frame rate. This is not a promise to sustain video
when the path cannot carry the configured minimum or is disconnected.

## Private observation interface

MediaMTX's session API supplies peer identity and the required counters. Its
listener binds only to 127.0.0.1:9997 and uses a separate generated per-device
credential in the existing private secret store. It is enabled only when an
RTSP output is configured. Player credentials cannot access it, and the console
exposes no proxy to it. The API itself supports administration; its credential
therefore remains private to the privileged daemon. The observer uses only a
fixed GET endpoint with bounded response size, timeouts, no redirects and no
response-body logging. Receiver query strings and credentials are not forwarded
to the dashboard. Sampling uses existing traffic; it is not an internet speedtest.

## Validation

The reproducible integration fixture is documented in
[scripts/tests/rtsp-adaptive](../../scripts/tests/rtsp-adaptive/README.md).
It uses a real MediaMTX server, encoder, decoder and bandwidth-shaped Docker
network, alongside unit, daemon-wiring and component tests.

Initial runs at a 650 kb/s link retained approximately 29.5–29.6 decoded fps
under Adaptive. Fixed at 1,200 kb/s on the same constrained link delivered
approximately 15–16 fps. Both TCP and UDP reduced the real encoder target and
began increasing it when the link returned to 3 Mb/s. These are synthetic-network
results, not claims about LTE or the live Pocket 2. The installed hardware check and its limits are recorded below.

## Installed Pi verification

The combined implementation was installed and its private session API returned
successful responses while listening only on loopback. Existing secret values
were preserved; the observer received its own generated credential. The prior
camera pipeline and USB helpers were retained.

With the actual Pocket 2 streaming from the Pi to one temporary external
GStreamer receiver, main-stream Adaptive was applied and kept within the
existing 400–4000 kb/s bounds. Encoder readback increased through 2600, 2800,
3000, 3200, 3400, 3600, 3800 and 4000 kb/s as delivery remained healthy. The
same camera run and USB generation continued, with zero pipeline restarts and
no MediaMTX slow-reader discard warnings in the observation window. The
receiver decoded approximately 30 fps throughout the changes and exited
without decoder errors after 100 seconds. It recorded no media files.

This was a wired, external-receiver hardware check. QGroundControl itself was
closed, so it is not a QGC visual acceptance claim, and it does not establish
real LTE performance. The isolated TCP and UDP bandwidth tests supply the
congestion/recovery evidence. After the temporary receiver left, the live
surface correctly returned to waiting for a receiver rather than inventing
healthy feedback. Adaptive remains enabled with the operator's existing bounds.
