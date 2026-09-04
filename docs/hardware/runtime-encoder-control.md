# Whether `v4l2h264enc` retunes its bitrate at runtime

Spec §8.1 needs a runtime encoder control channel: bitrate updates that do not respawn the
camera pipeline. **It does.** On the daemon's own pipeline — `compose()`/`encode()` in
`packages/yonder-core/src/video/pipeline.ts`, matched element for element, not
reconstructed from description — setting `video_bitrate` on `v4l2h264enc` through
`extra-controls` while the pipeline is playing moves the encoder from one target bitrate to
another, with no gap in the stream after the change, in three clean runs.

Two earlier attempts at this measurement are preserved in this file's git history and are
not repeated in full here. The first omitted the `level=(string)4` capsfilter
`encode()` welds onto every encode and measured a pipeline that never produced a frame. The
second added a `videoconvert` and dropped `io-mode=4` and the leaky queue that
`compose()` actually uses — a different element graph, which the note at the time
mislabeled as matching the daemon. Both errors are fixed below: this pipeline is checked
against `compose()`/`encode()` line by line, quoted where it matters, and the one
deliberate difference from it is named rather than left to be found by a reader who diffs
the two.

Requirement: R-VID-07. Spec: §8.1 (console-instrument-library).

## What was tested

<!-- yonder:hardware-observed -->

Every field below was observed this session, with the command that produced it. The board
was rebooted between the previous attempt and this one (an operator reseated the camera on
a different port), so nothing here is carried over from an earlier check.

| Field | Observed | Command |
|---|---|---|
| Board | `Raspberry Pi 4 Model B Rev 1.5`, aarch64 | `cat /proc/device-tree/model`; `uname -srm` |
| Kernel | `6.18.34+rpt-rpi-v8` | `uname -srm` |
| OS | Debian 13 (trixie) | `grep PRETTY_NAME /etc/os-release` |
| GStreamer | 1.26.2 | `gst-launch-1.0 --version` |
| Camera | `Global Shutter Camera`, USB id `32e4:0234`, hub port `1-1.3`, `Bus 001 Device 007` at the time of the runs below | `lsusb -d 32e4:0234` |
| Camera stable path | `/dev/v4l/by-path/platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0` → `../../video0` | `ls -la /dev/v4l/by-path/` |
| Encoder | `v4l2h264enc`, backed by `/dev/video11`, `Card type: bcm2835-codec-encode` | `gst-inspect-1.0 v4l2h264enc \| grep -A2 device`; `v4l2-ctl -d /dev/video11 --info` |
| `/dev/video0` idle | `sudo fuser -v /dev/video0` exit 1 (no holder), immediately before the runs | `sudo fuser -v /dev/video0` |
| `yonder-core` / `yonder-console` | active throughout; neither restarted or reconfigured; `yonder-core`'s main PID held no video file descriptor at any point checked | `systemctl is-active`; `sudo ls -l /proc/<pid>/fd \| grep video` |
| Date | 2026-09-05 (00:04–00:10 local, board clock) | — |

**This camera's connection is a mechanical fault, not power or thermal — established, not
re-derived here.** The modem shares its internal hub, draws considerably more current, and
transmits on cellular; it has never dropped once across any of these events. The SoC held
62–65 °C flat across the drops recorded in the previous 43-minute session, with no
throttling. Every drop is a clean disconnect with no preceding communication error — a
contact break, not a device giving up. This is why the device-number bracket below exists:
on this bench, a bitrate reading and a camera pulled out from under the pipeline can look
identical from the encoder's side.

## The pipeline, checked against the daemon rather than described from memory

`compose()` builds the full-rate branch as:

```ts
push(
  "v4l2src", `device=/dev/v4l/by-path/${camera.device}`, "io-mode=4", LINK,
  `image/jpeg,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
  "jpegdec", LINK,
  "tee", "name=raw",
);
push("raw.", LINK, ...QUEUE, LINK, ...encode(encoder, camera.bitrate_kbps, false), LINK,
  "h264parse", LINK, "tee", "name=main");
```

(`packages/yonder-core/src/video/pipeline.ts`, `compose()`, and `QUEUE` at line 80:
`["queue", "leaky=downstream", "max-size-time=200000000", "max-size-buffers=0",
"max-size-bytes=0"]`.) `encode()` returns `["v4l2h264enc",
"extra-controls=controls,video_bitrate=…", LINK, H264_LEVEL]`, where `H264_LEVEL =
"video/x-h264,level=(string)4"`. **There is no `videoconvert` or `v4l2convert` in this
branch** — the only converter in the whole file is in the *preview* branch (a later,
separate `push` using `v4l2convert`, for the cheap copy the interface watches under
R-VID-13), which this spike does not touch.

The spike's pipeline:

```
v4l2src device=/dev/video0 io-mode=4 ! image/jpeg,width=1280,height=720,framerate=30/1 \
  ! jpegdec \
  ! queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 \
  ! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000 \
  ! video/x-h264,level=(string)4 \
  ! h264parse ! identity name=tap ! fakesink sync=false
```

Element for element, this **is** `compose()`'s full-rate branch through `h264parse`, with
one deliberate difference: the daemon opens the camera through
`/dev/v4l/by-path/<name>`, and the spike opens `/dev/video0` directly. That path is how the
daemon keeps a camera's identity stable across replugs (R-CAM-05); it resolves to the same
`/dev/video0` node this session, and it is not a difference `v4l2h264enc` can observe —
the device node it reads frames from is identical either way. `io-mode=4` (`DMABUF`,
requesting zero-copy import) negotiated without incident on this camera; it did not need to
be dropped.

Script: [`scripts/spikes/retune-bitrate.py`](../../scripts/spikes/retune-bitrate.py). It
samples bytes reaching `tap` for 10 s, sets `video_bitrate` to 3,000,000 via
`extra-controls` on the live element, samples for another 10 s, and records the wall-clock
position of every timestamp gap wider than 3 frame-periods and of the retune call itself,
so a gap can be placed before or after the retune rather than merely counted.

## The three runs

Each is a fresh `python3 scripts/spikes/retune-bitrate.py` process. Every run is bracketed
with `vcgencmd get_throttled` **and** `lsusb -d 32e4:0234` immediately before and after —
a device number that differs from start to end means the camera re-enumerated mid-run and
the reading is void.

| Run | Before | `before` Mb/s | `after` Mb/s | Retune at | Gaps (wall-clock) | After retune | Exit | After |
|---|---|---|---|---|---|---|---|---|
| 1 | `0x0`, Dev 007 | 0.96 | 3.01 | 10.01s | 0.47s | 0 | 0 | `0x0`, Dev 007 |
| 2 | `0x0`, Dev 007 | 0.97 | 3.01 | 10.01s | 0.35s | 0 | 0 | `0x0`, Dev 007 |
| 3 | `0x0`, Dev 007 | 0.97 | 3.01 | 10.02s | 0.36s | 0 | 0 | `0x0`, Dev 007 |

**Zero runs were voided.** The camera's device number held at 007 across all three runs;
none needed discarding or repeating. Cross-checked independently against a USB-watch log
sampling the camera's device number and SoC temperature every 5 s through the whole
session (`cam=007` in every sample spanning all three runs, temperature climbing from
~63 °C to ~68.6 °C under the encode load, `thr=0x0` throughout) — a second, independent
witness that the camera did not move under any of these three readings.

**The bitrate change is real and lands on target.** `before` sits at 0.96–0.97 Mb/s against
a configured 1,000,000 bps, and `after` sits at 3.01 Mb/s against a configured 3,000,000
bps, in all three runs. `extra-controls` reached the running encoder and moved it.

**Every gap in every run falls before the retune call, and none falls after it.** The one
gap per run sits at 0.35–0.47 s — between the pipeline's first and second encoded buffers,
a fixed start-up transient — against a retune call at ~10.0 s. The 10 s window that follows
the retune in every run carries zero gaps. Per the brief's own standard, a gap after the
retune is the finding that would settle this against runtime retuning; there isn't one, in
nine seconds of combined post-retune observation across three independent processes.

## Why an earlier attempt measured nothing (kept for the record)

Read-only `gst-launch-1.0 -v` against a pipeline lacking the level capsfilter showed caps
negotiating cleanly end-to-end, with `v4l2h264enc` fixating its own src caps at
`video/x-h264, level=(string)1, ...` — level 1.0 permits at most 99 macroblocks per frame,
1280×720 is 80×45 = 3,600 — and then failing on the first buffer handed to it:

```
ERROR: from element /GstPipeline:pipeline0/v4l2h264enc:enc: Failed to process frame.
../sys/v4l2/gstv4l2videoenc.c(898): gst_v4l2_video_enc_handle_frame ()
```

```
bcm2835-codec bcm2835-codec: bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3
```

`encode()`'s own comment says exactly why the capsfilter is welded on rather than left to
each call site: "an encoder that reaches one of them without it does not survive its first
frame." An attempt that omits it reproduces precisely the failure the daemon's own code was
written to avoid.

### Isolating that failure

| Pipeline (capture → decode → encode) | `extra-controls` | Result |
|---|---|---|
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000, h264_level=11` | **Fails**, first frame |
| 1280×720, `jpegdec ! videoconvert`, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails** — rules out `h264_level` as the cause |
| 1280×720, `jpegdec` only, downstream caps unconstrained | `video_bitrate=1000000` only | **Fails** — rules out `videoconvert` as the cause |
| 1920×1080, `jpegdec` only, capsfilter forces `level=(string)4` downstream | `video_bitrate=2000000` | **Succeeds** |
| 1280×720, `jpegdec` only, capsfilter forces `level=(string)4` downstream, `num-buffers=100` | `video_bitrate=2000000` | **Succeeds** |

The level capsfilter is the row that matters, for the macroblock-count reason above; the
bitrate value and a bounded `num-buffers` in that last row were both incidental.

## The decision

**Runtime retune is available. Task 30 uses `extra-controls` at runtime for the main
stream's bitrate.** Three independent runs of the daemon's own full-rate pipeline each
moved the encoder from ~1 Mb/s to ~3 Mb/s on request, with zero timestamp gaps in the ten
seconds following the retune in every run, and zero runs voided by a mid-run
re-enumeration.

Two things for Task 30 to carry forward, neither a reason to withhold the "available"
answer:

- **A freshly started pipeline shows a single-frame-scale timing gap immediately after
  reaching `PLAYING`,** before settling — a property of start-up in general, not of the
  bitrate retune path.
- **This camera's connection is mechanically marginal** (cable/connector, established
  above). A live controller reading real telemetry from this board should expect the
  camera's device number to change under it occasionally and treat that as a
  reconnect/respawn event, not as an encoder or link-quality signal — exactly what the
  device-number bracket in this spike's runs stands in for.

## What this does not settle

- **Preview-only size/rate reconfiguration**, which spec §8.1 also asks for — this spike
  only exercised `video_bitrate` on the full-rate branch. The preview branch's
  `v4l2convert`/`videorate` path was not touched.
- **Sustained behaviour under a longer or repeated retune sequence.** Each run here changes
  bitrate exactly once. Task 30's real controller will step up and down repeatedly with
  hysteresis (§8.1); whether repeated retunes ever produce a gap was not tested.
- **The start-up transient's cause**, precisely — not chased further, since it sits
  entirely outside the retune window this spike exists to measure.

## Reproducing this

```bash
scp scripts/spikes/retune-bitrate.py yonder@yonder.local:/tmp/retune-bitrate.py
ssh yonder@yonder.local 'vcgencmd get_throttled; lsusb -d 32e4:0234; \
  python3 /tmp/retune-bitrate.py; echo exit:$?; \
  vcgencmd get_throttled; lsusb -d 32e4:0234'
```

If the reported device number differs before and after, discard the run and repeat.
