# Whether `v4l2h264enc` retunes its bitrate at runtime

Spec §8.1 needs a runtime encoder control channel: bitrate updates that do not respawn the
camera pipeline. This note measures whether the Pi 4's hardware H.264 encoder honours a
bitrate change made while it is running, on the exact pipeline shape the daemon uses
(`video/pipeline.ts`: MJPG capture, software JPEG decode, hardware encode). It does not
answer that question — the pipeline this spike was asked to test did not produce a single
encoded frame in any of its three runs, on this board, today. What follows is what was
measured and what it rules in and out.

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
Pipeline under test:

```
v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720,framerate=30/1 \
  ! jpegdec ! videoconvert \
  ! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000,h264_level=11 \
  ! h264parse ! identity name=tap ! fakesink sync=false
```

It samples bytes reaching `tap` for 10 s, sets `video_bitrate` to 3,000,000 via
`extra-controls` on the live element, samples for another 10 s, and counts any gap between
consecutive buffer timestamps wider than 3 frame-periods as a restart signal.

Before testing, `/dev/video0` and `/dev/video11` were confirmed idle (`sudo fuser -v`,
clean on both, and `/proc/<pid>/fd` for `yonder-core`'s main PID carried no video file
descriptor at all). The camera's own formats were independently re-confirmed with
`v4l2-ctl --device=/dev/video0 --list-formats-ext`: MJPG at 1280×720 up to 90 fps (90, 60,
30, 25, 20, 15, 10, 5), YUYV at 1280×720 only at 10 and 5 fps — matching the facts this
task was given, not rediscovering them from nothing.

## The three runs

Each is a fresh `python3 scripts/spikes/retune-bitrate.py` process. `vcgencmd get_throttled`
was read immediately before and immediately after each one:

| Run | Before | `before` Mb/s | `after` Mb/s | Gaps | Exit | After |
|---|---|---|---|---|---|---|
| 1 | `throttled=0x0` | 0.00 | 0.00 | 0 | 1 | `throttled=0x0` |
| 2 | `throttled=0x0` | 0.00 | 0.00 | 0 | 1 | `throttled=0x0` |
| 3 | `throttled=0x0` | 0.00 | 0.00 | 0 | 1 | `throttled=0x0` |

All six power readings are clean. None of the three runs brackets a non-zero
`get_throttled` value, so none is disqualified on power grounds — the board that gave a
brownout history an hour earlier (48 USB enumeration failures on GPIO header power) held a
clean supply through all three runs on USB-C power. The camera was confirmed present on the
bus (`lsusb`, `ls /dev/video0`) after every run and every diagnostic pipeline run below —
it never disappeared.

**The identical readings are not three confirmations of "no retuning."** `gaps` is 0 in
every run because `last_pts` never advances past `None` — the pad probe on `tap` never
fires at all, in either the 10 s "before" window or the 10 s "after" window. Zero bytes
before `extra-controls` was ever touched, and zero after, means no encoded frame reached
the tap point at any time during any run. That is a pipeline that never started producing
output, not an encoder that produced output at a steady rate and declined to change it.

## What actually happens when this pipeline runs

The Python script has no bus watch, so it cannot say why nothing arrived — it just samples
byte counts. Running the identical element graph through `gst-launch-1.0 -v` (read-only,
`fakesink`, nothing left on the board) shows the reason directly. Caps negotiate cleanly
all the way to the encoder's output — `v4l2src` produces MJPG 1280×720, `jpegdec` produces
`I420`, `videoconvert` passes it through unchanged, and `v4l2h264enc` even fixates its own
src caps (`video/x-h264, level=(string)1, profile=(string)baseline, width=1280, height=720`)
— and then fails on the first buffer handed to it:

```
ERROR: from element /GstPipeline:pipeline0/v4l2h264enc:enc: Failed to process frame.
Additional debug info:
../sys/v4l2/gstv4l2videoenc.c(898): gst_v4l2_video_enc_handle_frame (): /GstPipeline:pipeline0/v4l2h264enc:enc:
Maybe be due to not enough memory or failing driver
```

with the kernel recording the driver-level cause at the same moment:

```
bcm2835-codec bcm2835-codec: bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3
WARNING: CPU: 2 PID: 13881 at drivers/media/common/videobuf2/videobuf2-core.c:1803 vb2_start_streaming+0xec/0x188 [videobuf2_common]
```

`v4l2h264enc`'s sink side — its input port — refuses to start streaming, on the very first
frame, every time. This is not the JPEG-decoder defect already on record
(`usb-camera-on-a-pi-4.md`, Defect 1, `/dev/video10` advertising MJPEG and failing to
enable): `jpegdec` here is the software decoder, never touches `/dev/video10`, and the
failure is on the **encode** side, `/dev/video11`.

## Isolating the failure

None of this touched the deliverable script, which stays exactly as the spec brief wrote
it. These were read-only `gst-launch-1.0` probes, run to find out whether the zero
readings above meant anything about runtime retuning, or meant the measurement itself
never started. Each was confirmed not to disturb the camera (`lsusb`, `ls /dev/video0`
after every one) or the supply (`vcgencmd get_throttled` clean throughout).

| Pipeline (capture → decode → encode) | `extra-controls` | Result |
|---|---|---|
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000, h264_level=11` (the brief's script) | **Fails**, first frame |
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails**, first frame — rules out `h264_level` as the cause |
| 1280×720, `jpegdec` only, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails**, first frame — rules out `videoconvert` as the cause |
| 1920×1080, `jpegdec` only, capsfilter forces `level=(string)4` downstream | `video_bitrate=2000000` | **Succeeds** — reproduces the working pipeline already on record in `usb-camera-on-a-pi-4.md` |
| 1280×720, `jpegdec` only, capsfilter forces `level=(string)4` downstream, `num-buffers=100` | `video_bitrate=2000000` | **Succeeds** |

So: not the `h264_level` control, not `videoconvert`, and not the resolution alone — 720p
can run. What is not isolated is which of the three remaining differences between the last
row and the brief's script is what matters: a downstream capsfilter forcing the output
level, the bitrate value itself (2,000,000 against 1,000,000), or a bounded `num-buffers`
against none. Separating those three is pipeline engineering, not this spike's question,
and was not attempted — the brief is explicit that the question is what this encoder does,
not how to make it do what we hoped.

Resource contention was checked and ruled out before any of this: `sudo fuser -v` on
`/dev/video0`, `/dev/video1`, `/dev/video10`, `/dev/video11` and `/dev/video12` was clean
throughout, and a scan of every process's open file descriptors found none open against
`/dev/video10` or `/dev/video11` — `yonder-core` included.

## The decision

**Runtime retune is unproven, and this pipeline shape cannot currently be used to prove
it.** This is a stronger finding than "the control does not take" — the pipeline the
daemon actually uses at 1280×720 did not encode a single frame, three times, so there is no
running encoder in any of the three runs for `extra-controls` to have retuned or failed to
retune. Nothing here shows the control itself is inert; nothing here shows it works either.

Per the brief's decision branches, this is treated as the "not available" side, because
Task 30 cannot be built on a control path that has never been observed running once:
**Task 30 must isolate a preview-branch restart rather than assume `extra-controls` retunes
the main stream live.** The main stream's bitrate stays Apply-with-respawn, and the page
states plainly that changing it restarts the picture. This should be revisited — not
guessed around — once a pipeline shape at 1280×720 is confirmed to run continuously on this
board; the last row of the table above is a candidate starting point for that, not a fix
applied here.

## What this does not settle

- **Which of {downstream level capsfilter, bitrate value, bounded buffer count} makes the
  difference at 720p.** Three candidates, not separated.
- **Whether `video/pipeline.ts`'s actual runtime pipeline (as opposed to this spike's
  reconstruction of it) hits the same failure.** This spike built its own `gst-launch`
  graph from the shape described in the brief; it did not read or execute the daemon's own
  pipeline-construction code.
- **Whether this is new.** `usb-camera-on-a-pi-4.md` measured 1280×720 encoding
  successfully on 2026-09-02, on a board later found to be browning out (K-41). Whether
  something changed between then and now, or whether that measurement used a pipeline
  shape closer to the working rows above than to the brief's script, was not checked.
- **Runtime retune itself**, on any pipeline — the question this spike exists to answer.

## Reproducing this

```bash
scp scripts/spikes/retune-bitrate.py yonder@yonder.local:/tmp/retune-bitrate.py
ssh yonder@yonder.local 'vcgencmd get_throttled; python3 /tmp/retune-bitrate.py; echo exit:$?; vcgencmd get_throttled'
```

The diagnostic pipelines above, for the failing case:

```bash
ssh yonder@yonder.local 'gst-launch-1.0 -v v4l2src device=/dev/video0 \
  ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec ! videoconvert \
  ! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000,h264_level=11 \
  ! h264parse ! fakesink sync=false'
```

and for the working 720p case:

```bash
ssh yonder@yonder.local 'gst-launch-1.0 -q v4l2src device=/dev/video0 num-buffers=100 \
  ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec \
  ! v4l2h264enc extra-controls=controls,video_bitrate=2000000 \
  ! "video/x-h264,level=(string)4" ! h264parse ! fakesink'
```
