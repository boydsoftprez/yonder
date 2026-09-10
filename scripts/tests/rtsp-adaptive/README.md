# RTSP Adaptive delivery test

This test runs the production feedback collector and rate controller against
MediaMTX 1.20.1, a real GStreamer encoder controlled through Yonder's pipeline
host, and a separate GStreamer decoder. It requires Docker and built core output.

From the repository root:

```sh
npm ci
npm run build -w yonder-core
docker build -t yonder-rtsp-adaptive-test:local scripts/tests/rtsp-adaptive
scripts/tests/rtsp-adaptive/run.sh tcp
scripts/tests/rtsp-adaptive/run.sh udp
```

The fixture creates a private Docker network and two temporary containers. Only
the media-server container has NET_ADMIN, to shape its own egress. No host ports
are published. The pattern is synthetic; no camera, Pi, LTE connection, aircraft
or external video service is accessed. The containers/network are removed when
the test finishes; the printed results directory contains metadata and logs.

The test changes available bandwidth from 3,000 to 650 and back to 3,000 kb/s.
It checks actual encoder retunes, bounds, continuous production, decoded frame
rate after settling, and increasing quality when bandwidth returns. A final
Fixed-mode comparison must keep its rate even when the path is constrained.
The observer API must reject absent/player credentials and be unreachable from
the receiver network. The fixture uses obvious test-only credentials.

Files include phase summaries, receiver frame counts, sampled feedback, actual
retune acknowledgements, and server logs. This validates the network/control
loop with the software encoder; it does not establish Pocket 2 USB stability,
Pi hardware-encoder behavior, or real cellular performance.
