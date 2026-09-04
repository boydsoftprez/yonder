# Whether `v4l2h264enc` retunes its bitrate at runtime

Spec §8.1 needs a runtime encoder control channel: bitrate updates that do not respawn the
camera pipeline. **It does.** On the exact pipeline shape the daemon uses
(`packages/yonder-core/src/video/pipeline.ts`: MJPG capture, software JPEG decode, a
`level=(string)4` capsfilter, hardware encode), setting `video_bitrate` on `v4l2h264enc`
through `extra-controls` while the pipeline is playing moves the encoder from one target
bitrate to another, with no gap in the stream across the change. Three runs agree exactly.

An earlier attempt at this measurement used a pipeline that omitted the `level=(string)4`
capsfilter `pipeline.ts` welds onto every encode. That pipeline never produced a frame at
all, at any bitrate — a measurement of a broken pipeline, not evidence about retuning. That
attempt and its full diagnosis are preserved in this file's git history and referenced
below; this revision replaces its conclusion with the real answer.

Requirement: R-VID-07. Spec: §8.1 (console-instrument-library).

## What was tested

<!-- yonder:hardware-observed -->

| Field | Observed |
|---|---|
| Board | Raspberry Pi 4 Model B Rev 1.5, aarch64 |
| OS / kernel | Debian 13 (trixie), `6.18.34+rpt-rpi-v8` |
| GStreamer | 1.26.2 |
| Camera | `Global Shutter Camera`, USB id `32e4:0234`, at `/dev/video0` |
| Encoder | `v4l2h264enc`, backed by `/dev/video11` (`bcm2835-codec-encode`) |
| `yonder-core` / `yonder-console` | active throughout; neither restarted or reconfigured; neither held `/dev/video0`, `/dev/video11` or any other video node at any point checked |
| Date | 2026-09-04 |

Script: [`scripts/spikes/retune-bitrate.py`](../../scripts/spikes/retune-bitrate.py).
Pipeline under test — matched to `encode()` in `video/pipeline.ts` exactly, including the
capsfilter that function welds onto every encode rather than adding at its call sites:

```
v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720,framerate=30/1 \
  ! jpegdec ! videoconvert \
  ! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000 \
  ! video/x-h264,level=(string)4 \
  ! h264parse ! identity name=tap ! fakesink sync=false
```

It samples bytes reaching `tap` for 10 s, sets `video_bitrate` to 3,000,000 via
`extra-controls` on the live element, samples for another 10 s, and counts any gap between
consecutive buffer timestamps wider than 3 frame-periods as a restart signal.

Before testing, `/dev/video0` and `/dev/video11` were confirmed idle (`sudo fuser -v`,
clean on both, and `/proc/<pid>/fd` for `yonder-core`'s main PID carried no video file
descriptor at all). The camera's own formats were independently re-confirmed with
`v4l2-ctl --device=/dev/video0 --list-formats-ext`: MJPG at 1280×720 up to 90 fps (90, 60,
30, 25, 20, 15, 10, 5), YUYV at 1280×720 only at 10 and 5 fps.

## The three runs

Each is a fresh `python3 scripts/spikes/retune-bitrate.py` process. `vcgencmd get_throttled`
was read immediately before and immediately after each one:

| Run | Before | `before` Mb/s | `after` Mb/s | Gaps | Exit | After |
|---|---|---|---|---|---|---|
| 1 | `throttled=0x0` | 0.97 | 3.01 | 1 | 1 | `throttled=0x0` |
| 2 | `throttled=0x0` | 0.97 | 3.01 | 1 | 1 | `throttled=0x0` |
| 3 | `throttled=0x0` | 0.97 | 3.01 | 1 | 1 | `throttled=0x0` |

All six power readings are clean; none of the three runs brackets a non-zero
`get_throttled` value. The camera was confirmed present on the bus (`lsusb`,
`ls /dev/video0`) after every run — it never disappeared.

**The bitrate change is real and lands on target.** `before` sits at 0.97 Mb/s against a
configured 1,000,000 bps, and `after` sits at 3.01 Mb/s against a configured 3,000,000 bps
— both within the overhead of H.264/RTP-style framing and measurement rounding, in all
three independent runs. `extra-controls` reached the running encoder and moved it.

**The gap count is 1 in every run, and it is not the retune.** The script's own heuristic
(`sys.exit(0 if after > before * 2 and gaps[0] == 0 else 1)`) fails on this, and the exit
code is 1 for all three runs — but per this task's own instruction, the number is recorded
and explained rather than deferred to the exit code. A timing-instrumented copy of the
identical pipeline (diagnostic only, never the deliverable script, deleted after use) located
the one gap precisely:

```
first buffer at wall t=0.00s (pts=149544039)
GAP #1 at wall t=0.01s  pts_delta=144.0ms
retune call at wall t=9.66s
before 0.97 Mb/s  after 3.01 Mb/s  timestamp gaps 1
```

The gap sits between the pipeline's first and second encoded buffers — 144 ms apart against
an expected ~33 ms at 30 fps — 9.65 seconds **before** `extra-controls` is ever touched, and
the "after" window that follows the retune call contributes no further gaps at all. This is
a pipeline-startup transient (buffer allocation and the encoder's first-frame latency), not
a restart triggered by the bitrate change. Timestamps are continuous across the retune
itself; they are not perfectly continuous from cold start, which is a different fact than
the one this spike exists to establish.

## Why the first attempt measured nothing

Read-only `gst-launch-1.0 -v` against the first attempt's pipeline (no downstream level
constraint) showed caps negotiating cleanly end-to-end, with `v4l2h264enc` fixating its own
src caps at `video/x-h264, level=(string)1, profile=(string)baseline, width=1280,
height=720` — and then failing on the first buffer handed to it:

```
ERROR: from element /GstPipeline:pipeline0/v4l2h264enc:enc: Failed to process frame.
../sys/v4l2/gstv4l2videoenc.c(898): gst_v4l2_video_enc_handle_frame ()
Maybe be due to not enough memory or failing driver
```

```
bcm2835-codec bcm2835-codec: bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3
```

**This is now a settled mechanism, not an open mystery.** H.264 level 1.0 permits at most 99
macroblocks per frame. 1280×720 is 80×45 = 3,600 macroblocks — the encoder fixated a level
that cannot describe the frame size it was being asked to carry, and `bcm2835-codec`
refused to enable streaming rather than encode something it could not legally label.
`video/pipeline.ts` already knows this — its own comment, at the point it welds
`video/x-h264,level=(string)4` onto every encode, says exactly why:

> The capsfilter is welded on here rather than added at the two call sites, because an
> encoder that reaches one of them without it does not survive its first frame.

The first attempt's spike pipeline omitted that capsfilter, so it reproduced precisely the
failure the daemon's own code was written to avoid. The daemon was never at risk; the
spike's reconstruction of its shape was incomplete.

### Isolating the failure (from the first attempt, preserved because it is still correct)

These read-only `gst-launch-1.0` probes (never the deliverable script) were run to
characterise the first attempt's zero readings before concluding anything:

| Pipeline (capture → decode → encode) | `extra-controls` | Result |
|---|---|---|
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000, h264_level=11` | **Fails**, first frame |
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails**, first frame — rules out `h264_level` as the cause |
| 1280×720, `jpegdec` only, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails**, first frame — rules out `videoconvert` as the cause |
| 1920×1080, `jpegdec` only, capsfilter forces `level=(string)4` downstream | `video_bitrate=2000000` | **Succeeds** — reproduces the working pipeline already on record in `usb-camera-on-a-pi-4.md` |
| 1280×720, `jpegdec` only, capsfilter forces `level=(string)4` downstream, `num-buffers=100` | `video_bitrate=2000000` | **Succeeds** |

At the time this table was first written, three things separated the last row from the
first (a downstream level capsfilter, the bitrate value, and a bounded `num-buffers`) and
none had been isolated from the others. That is now resolved: the level capsfilter is the
one that matters, for the macroblock-count reason above. The bitrate value and the bounded
buffer count were both incidental to the rows they appeared in.

## The decision

**Runtime retune is available. Task 30 uses `extra-controls` at runtime for the main
stream's bitrate.** Three independent runs each moved the encoder from ~1 Mb/s to ~3 Mb/s
on request, with zero timestamp discontinuities across the retune itself. The one gap
recorded in every run is a fixed pipeline-startup transient, 9.65 s before any retune call
and contributing nothing to the post-retune window — characterised above, not hand-waved.

One caveat for Task 30 to carry forward, not a reason to withhold the "available" answer:
a freshly started pipeline shows a single-frame-scale timing gap immediately after reaching
`PLAYING`, before settling. That is a property of pipeline start-up in general — relevant to
whatever Task 30 does when a preview branch or a whole pipeline restarts — not a property of
the bitrate retune path this spike was asked to answer for.

## What this does not settle

- **Preview-only size/rate reconfiguration**, which spec §8.1 also asks for — this spike
  only exercised `video_bitrate`. `h264_level`, resolution and framerate changes at runtime
  were not tested and should not be assumed to behave the same way.
- **Sustained behaviour under a longer or repeated retune sequence.** Each run here changes
  bitrate exactly once. Task 30's real controller will step up and down repeatedly with
  hysteresis (§8.1); whether repeated retunes ever produce a gap was not tested.
- **The startup transient's cause**, precisely — not chased further here, since it sits
  entirely outside the retune window this spike exists to measure.

## Reproducing this

```bash
scp scripts/spikes/retune-bitrate.py yonder@yonder.local:/tmp/retune-bitrate.py
ssh yonder@yonder.local 'vcgencmd get_throttled; python3 /tmp/retune-bitrate.py; echo exit:$?; vcgencmd get_throttled'
```

The diagnostic pipeline that reproduces the first attempt's failure (no downstream level
constraint):

```bash
ssh yonder@yonder.local 'gst-launch-1.0 -v v4l2src device=/dev/video0 \
  ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec ! videoconvert \
  ! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000,h264_level=11 \
  ! h264parse ! fakesink sync=false'
```

and the working case, matching `video/pipeline.ts`:

```bash
ssh yonder@yonder.local 'gst-launch-1.0 -q v4l2src device=/dev/video0 num-buffers=100 \
  ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec \
  ! v4l2h264enc extra-controls=controls,video_bitrate=2000000 \
  ! "video/x-h264,level=(string)4" ! h264parse ! fakesink'
```
