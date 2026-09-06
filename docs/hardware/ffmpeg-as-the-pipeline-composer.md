# Whether ffmpeg can replace GStreamer as Yonder's pipeline composer

The Rockchip design decides that **Yonder composes its pipelines with ffmpeg, on every
board, and the GStreamer composer is replaced rather than joined**
([§2](../superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md)). It also names
two things that must be true before that ships, and calls them gates on the decision rather
than work to schedule afterwards:

- **the Pi re-proof** — the 300-frame two-branch measurement, on a Pi with a camera,
  because the decision currently rests on inference for that board; and
- **end-to-end latency** — roughly two seconds was seen in QGroundControl against an
  ffmpeg-composed stream, and *"one composer, and it is ffmpeg" is a much weaker
  proposition if ffmpeg costs seconds of latency that GStreamer's `latency=0` sinks do
  not*.

This note answers both, and a third question the project has reason to ask carefully:
whether ffmpeg can change a bitrate on a running encode, and **driven from what**. K-48 and
K-53 record what happens when only half of that is asked — Task 1 proved `v4l2h264enc`
retunes by holding the pipeline object, the daemon runs `gst-launch-1.0` which answers
nothing, and the half-answer rode through five tasks before anyone noticed.

**The short answers.** ffmpeg holds real time on a Pi and costs about twice the CPU.
Latency is a real cost and a small one — about 120 ms on the sending side, nowhere near
seconds. And ffmpeg cannot retune this encoder at all, from any channel, including from a
program holding the encoder context: **the device retunes and ffmpeg's wrapper cannot make
it**, measured side by side on one board in one session.

Requirements: R-VID-07, R-CAM-07, R-CAM-13, R-HW-03. Spec: §2, §11.

## What was in front of us

<!-- yonder:hardware-observed -->

Every field was read this session, on the board, with the command that produced it. Nothing
here is carried over from another note or another day.

| Field | Observed | Command |
|---|---|---|
| Board | `Raspberry Pi 4 Model B Rev 1.5`, aarch64, 4 cores | `cat /proc/device-tree/model`; `nproc` |
| Kernel | `6.18.34+rpt-rpi-v8` | `uname -srm` |
| OS | Debian GNU/Linux 13 (trixie) | `grep PRETTY_NAME /etc/os-release` |
| GStreamer | 1.26.2 | `gst-launch-1.0 --version` |
| ffmpeg | 7.1.5, package `8:7.1.5-0+deb13u1+rpt2` | `ffmpeg -version`; `dpkg-query -W ffmpeg` |
| libavcodec | 61.19.101 | `pkg-config --modversion libavcodec` |
| Camera | `Webcam gadget: UVC HD Camera`, USB id `1d6b:0102`, hub port `1-1.3`, device 5 throughout | `v4l2-ctl -d /dev/video0 --info`; `lsusb -d 1d6b:0102` |
| Camera stable path | `platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0` → `../../video0` | `ls -la /dev/v4l/by-path/` |
| Camera port power | `power/control = on` — K-46's fix holding, checked before every interval quoted | `cat /sys/bus/usb/devices/1-1.3/power/control` |
| Encoder | `/dev/video11`, card `bcm2835-codec-encode`, driver 6.18.34 | `v4l2-ctl -d /dev/video11 --info` |
| Encoder bitrate control | `video_bitrate` min 25000, max 25000000, step 25000 | `v4l2-ctl -d /dev/video11 --list-ctrls` |
| mediamtx | v1.20.1 | `mediamtx --version` |
| Supply and thermals | `throttled=0x80000` throughout, 64.2–78.4 °C | `vcgencmd get_throttled`; `vcgencmd measure_temp` |
| Date | 2026-09-06, 15:06–16:01 BST (board clock) | `date` |

**`throttled=0x80000` is bit 19 — *soft temperature limit has occurred* — and it read that
way before this session's first measurement and after its last.** No under-voltage bit was
ever set. It is recorded because it is what the board said, not because anything here
provoked it; the highest reading taken was 78.4 °C, immediately after another session's
install, and every measurement below was taken between 64 °C and 74 °C.

**ffmpeg was not installed on this board and was installed for this work.** That is a
change this spike made and did not undo, and the design needs it installed anyway (§3).
`libavcodec-dev`, `libavutil-dev`, `libavformat-dev` and `python3-zmq` were installed too,
for the two tests that need them.

### The board changed under this session, twice, and neither was this spike

- **Another session ran a full `installer/install.sh` while this one was starting.** It was
  found by `pgrep` at the outset, mid-copy of the console's `node_modules`, and finished
  about five seconds later; the dpkg lock was then free and both services active. No
  measurement here was taken while it ran.
- **The operator started `cam0` from the console mid-session**, which is why the daemon's
  camera reappeared after being stopped. It was not the supervisor reacting to anything
  this spike did — worth stating, because "the supervisor restarted it" was this session's
  first and wrong inference.

### The camera is a black-frame gadget, and it wedges

The camera on the Pi is a Linux device presenting itself as a webcam. It offers MJPG, H264
and HEVC at 640×480, 1280×720 and 1920×1080, and it produces **black frames** — there is
nothing behind it. **The ELP global-shutter camera is on the Radxa, not on this board**, so
it was not available for these runs.

Black frames are usable here, and one measured fact is why: this encoder's rate control
tracks its target regardless of picture content. The camera at a 2 Mb/s target produced
2.04 Mb/s, twice, and 2.01 Mb/s on a third run. So output bitrate reads the encoder's
*target* directly, which is exactly what a retune measurement needs. Where a moving picture
was needed anyway — the rate-control questions in Question 2 — `testsrc2` was used and the
substitution is named at that point.

It also **wedges**, which is K-51, and it wedged repeatedly here: `Failed to set UVC probe
control : -75`, `VIDIOC_STREAMON returned -1 (Connection timed out)`, and an `open()` that
then returns `Input/output error` while `fuser` names no holder. The first ffmpeg reading of
this session was `0.00 Mb/s` for exactly that reason and **not** for any reason about
ffmpeg — which is the trap this directory exists to avoid, met on the first attempt.

So every measurement below is bracketed by
[`camguard.sh`](../../scripts/spikes/camguard.sh), which proves the camera streams before
the run rather than trusting that it did last time, and rebinds the port through
`/sys/bus/usb/drivers/usb/{unbind,bind}` when it does not. **Every script here refuses to
report a zero as a number.** A run that produced no bytes is printed as
`** NO OUTPUT — not a measurement **` and excluded.

One more thing camguard has to do, and it is not in K-51: a successful `v4l2-ctl` check
*closes* the device, and an `open()` issued immediately afterwards fails with
`Input/output error` on a port that is perfectly healthy. A three-second settle after the
check removes it. Without the settle it is indistinguishable from the wedge.

## The two command lines, derived from `compose()` rather than described

An ffmpeg command that is not doing what the GStreamer one does is not a comparison, it is
two unrelated numbers. Both lines below come from `compose()` in
`packages/yonder-core/src/video/pipeline.ts`. The GStreamer side was additionally checked
against what the daemon was **actually running**, read out of `/proc/<pid>/cmdline` while
`cam0` was up:

```
gst-launch-1.0 -q v4l2src device=/dev/v4l/by-path/…-usb-0:1.3:1.0-video-index0 io-mode=4
  ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec ! tee name=raw
  raw. ! queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0
       ! v4l2h264enc name=enc-stream extra-controls=controls,video_bitrate=1100000
       ! video/x-h264,level=(string)4 ! h264parse ! tee name=main
    main. ! queue … ! rtspclientsink location=rtsp://127.0.0.1:8554/cam0 latency=0
  raw. ! queue … ! v4l2convert
       ! capsfilter name=preview-scale caps=video/x-raw,width=1280,height=720
       ! videorate ! capsfilter name=preview-rate caps=video/x-raw,framerate=30/1
       ! v4l2h264enc name=enc-preview
         extra-controls=controls,video_bitrate=800000,h264_i_frame_period=15
       ! video/x-h264,level=(string)4 ! h264parse
       ! rtspclientsink location=rtsp://127.0.0.1:8554/cam0-preview latency=0
```

### Every place the ffmpeg line differs, and why

This is the section a reader should hold the numbers against. It is also printed by
`composer-throughput.py --differences`, so it cannot drift away from the script.

| | difference | why |
|---|---|---|
| 1 | **`io-mode=4`** has no counterpart | `compose()` asks `v4l2src` for DMABUF import. ffmpeg's v4l2 demuxer has no equivalent switch and uses mmap. Neither reaches the encoder as a dmabuf on this board |
| 2 | **`-pix_fmt yuv420p` is added, and is mandatory** | ffmpeg's mjpeg decoder emits `yuvj420p`; `h264_v4l2m2m` accepts only `yuv420p` and refuses to open — *"Encoder requires yuv420p pixel format"*, then `Error while opening encoder`. The naive translation of `compose()` **does not run at all**. The fix inserts a swscale full-to-limited range pass over every frame. GStreamer's `jpegdec` hands I420 straight to `v4l2h264enc` with no conversion, so this pass exists only in the ffmpeg arm and its cost is inside the ffmpeg numbers |
| 3 | **no leaky queue** | `QUEUE` bounds every branch at 200 ms and drops downstream when full, so a stalled consumer cannot back-pressure the shared encoder. ffmpeg's filter graph blocks instead. Nothing here measures that difference — both arms discard as fast as they are fed — but it is the property `QUEUE`'s own comment says the pipeline depends on, and an ffmpeg composer owes it an answer |
| 4 | **no level capsfilter** | `v4l2h264enc` fixates level 1 without `video/x-h264,level=(string)4` and dies on its first frame. `h264_v4l2m2m` sets the level itself and needs no such filter. Adding one would be the ritual `pipeline.ts`'s own comment warns against |
| 5 | **the preview scaler is software** | `compose()` scales the preview with `v4l2convert`, the board's ISP hardware M2M converter at `/dev/video12`. **ffmpeg has no element that can reach it**; `scale` is software. This is the one difference that is not incidental, and §4's answer for Rockchip — `scale_rkrga` — has no Pi equivalent |
| 6 | **both arms end in a file**, not `rtspclientsink`/`udpsink` | Equally, in both composers, so that a media server's buffering is not inside a number about the composer. Transport is Question 1b's subject |
| 7 | **the preview rung is 640×360** | `compose()` reads it from configuration, and this board's config currently holds 1280×720 — the same size as the full rate, which would put a converter in the graph that scales nothing. 640×360 is the rung the Radxa measurement used |

Difference 2 is worth reading twice. It is not a tuning choice: **the direct translation of
the daemon's pipeline into ffmpeg fails to start**, and the smallest repair adds a
per-pixel pass that GStreamer does not perform.

## Question 1a — the Pi re-proof

300 frames, 1280×720 MJPEG at 30 fps, full-rate encode at 2000 kb/s, preview branch at
640×360 and 800 kb/s. Three runs of each arm, interleaved with camera checks. CPU is busy
jiffies from `/proc/stat` across all four cores, not load average — the Radxa note records
why load average is not usable for this, and the same argument applies to any encoder that
waits on hardware.

Script: [`composer-throughput.py`](../../scripts/spikes/composer-throughput.py).
**Twelve runs, none failed, none void.**

| pipeline | run 1 | run 2 | run 3 | median | effective | cpu (4 cores) | above idle |
|---|---|---|---|---|---|---|---|
| GStreamer, full-rate only | 10.39 s | 12.05 s | 10.22 s | **10.39 s** | ~29 fps | 17.6% | +5.8 |
| GStreamer, two branches | 10.23 s | 12.13 s | 10.23 s | **10.23 s** | ~29 fps | 22.3% | +10.5 |
| ffmpeg, full-rate only | 10.45 s | 10.47 s | 10.50 s | **10.47 s** | ~29 fps | 24.2% | +12.4 |
| ffmpeg, two branches | 12.37 s | 10.45 s | 10.44 s | **10.45 s** | ~29 fps | 30.6% | +18.8 |

Board baseline over 5 s with no pipeline: **11.8% busy**, 68.1 °C.

**Both composers hold real time.** 300 frames at 30 fps cannot take less than 10.00 s, and
every median sits between 10.23 and 10.47 s including process start-up. The three 12-second
outliers are one per arm-ish and are camera start-up variance on this gadget, which is why
the median is quoted beside every run rather than a mean over three.

**ffmpeg costs about twice the CPU.** Against an 11.8% idle board the marginal cost is 5.8
points for GStreamer's full-rate branch against 12.4 for ffmpeg's, and 10.5 against 18.8 for
the two-branch shape — 2.1× and 1.8×. The CPU figures are stable across runs in a way the
timings are not (17.5/17.6/17.6 against 23.5/25.0/24.0), so this is the reliable half of
the table.

**Where the extra CPU goes is known, and it is differences 2 and 5.** ffmpeg *is* using the
hardware encoder — this was not assumed:

```
[h264_v4l2m2m] Using device /dev/video11
[h264_v4l2m2m] driver 'bcm2835-codec' on card 'bcm2835-codec-encode' in mplane mode
```

and `fuser /dev/video11` named the running `ffmpeg` process during a live arm. What ffmpeg
does *not* use is the ISP scaler at `/dev/video12`, and it additionally performs a range
conversion on every frame that GStreamer does not. The MJPEG decode is software in both
arms — the Pi 4's hardware JPEG decoder advertises MJPEG and cannot be started (K-40) — so
that term is equal and explains none of the gap.

## Question 1b — latency

### Why this is not a glass-to-glass number, and what it is instead

The spec asks for "one stream carrying a burned-in frame counter, compared against what the
receiver displays". **The camera on this board emits black frames, so it cannot carry a
burned-in anything.** A source that cannot carry an event cannot carry a timestamp.

So the source is raw frames fed in on a pipe: black, with one white frame every three
seconds. The writer records `time.monotonic()` as the white frame goes in; the reader
records it when mean luminance rises at the far end. Sender and receiver are the same
process on the same board, so there is **one clock and nothing to synchronise**, which is
what the spec said the measurement would need. No OCR, and detection needs no tuning
between arms.

What this measures is **encode → RTP → depacketise → decode**: precisely the part that
differs between the two composers, and precisely the part the spec says is unmeasured.
Camera capture and MJPEG decode sit ahead of it, are identical in both arms, and add the
same amount to both. The transport is the daemon's own — H.264 in RTP over UDP at `pt=96`,
the `rtph264pay config-interval=-1` that `sink()` composes — on loopback, so no network is
in the figure either.

**The measurement crosses sender against receiver**, because one number could not tell
those apart and that is exactly why the original two-second observation could not settle
anything. The spec's own reading of it was that the evidence pointed at the receiver, and
said plainly that this was an inference. Crossing tests it.

Script: [`composer-latency.py`](../../scripts/spikes/composer-latency.py). 1280×720 at
30 fps, 4000 kb/s, GOP 15. Two runs per arm, five flashes each after discarding the first
as a joining cost; the median of each run is given.

| sender | receiver | receiver tuned for low latency | receiver at its defaults |
|---|---|---|---|
| GStreamer | GStreamer | **34, 29 ms** | 30, 30 ms |
| GStreamer | ffmpeg | 100, 138 ms | 327, 326 ms |
| ffmpeg | GStreamer | 155, 152 ms | 185, 185 ms |
| ffmpeg | ffmpeg | 176, 156 ms | **384, 417 ms** |

**The ffmpeg composer does not cost seconds of latency. It costs about 120 ms.** Holding
the receiver fixed at GStreamer, replacing the GStreamer sender with ffmpeg moves the
median from ~31 ms to ~153 ms. That is real, it is a fifth of R-UI-06's 300 ms budget on
its own, and it is an order of magnitude below the two seconds §2 was worried about.

**The receiver is the larger term, and the spec's inference about that was right.** Holding
the sender fixed at GStreamer, replacing the receiver moves ~31 ms to ~119 ms tuned and
~326 ms at defaults. The two contributions are roughly additive: worst measured corner is
ffmpeg into ffmpeg at defaults, at 384–417 ms.

**GStreamer's receive path is insensitive to the setting that ought to hurt it.** The
`defaults` column ran `rtpjitterbuffer latency=200` against `latency=0`, and read 30 ms
either way — the jitter buffer's latency is a maximum wait, and on a loopback with no
jitter there is nothing to wait for. ffmpeg's receiver, by contrast, costs an extra ~200 ms
if its low-latency switches are not set.

**None of this reproduces two seconds, and this measurement cannot rule it back in.** What
was observed in QGroundControl included a real network, a different receiver, H.265 rather
than H.264, and a different board. What this establishes is narrower and is the thing §2
actually asked for: **the pipeline's own contribution is about 120 ms, not seconds**, so
the two-second observation is not explained by the composer and the receiver remains the
place to look.

## Question 2 — can ffmpeg change a bitrate on a running encode, and driven from what?

### The device can. This was re-measured this session, not carried forward

Four runs of the existing [`retune-bitrate.py`](../../scripts/spikes/retune-bitrate.py) —
GStreamer holding the pipeline object and setting `extra-controls` on the live
`v4l2h264enc`:

| run | before | after | gaps after the retune |
|---|---|---|---|
| 1 | 0.99 Mb/s | 3.00 Mb/s | 0 |
| 2 | 0.99 Mb/s | 3.02 Mb/s | 0 |
| 3 | 0.78 Mb/s | 2.78 Mb/s | 0 |
| 4 | 0.80 Mb/s | 2.81 Mb/s | 0 |

`usbdev` held at 5 across all four; `throttled=0x80000` and 65.2 → 65.7 °C either side.
Runs 3 and 4 sit low because the source is black, and the ratio is what matters.

**So the encoder, the driver and this board all take a runtime bitrate change.** Anything
that follows is about ffmpeg, not about the hardware.

### ffmpeg cannot, from any channel the CLI offers

Script: [`ffmpeg-retune.py`](../../scripts/spikes/ffmpeg-retune.py). One `h264_v4l2m2m`
encode of a moving synthetic source, opened at 1000 kb/s; eight seconds measured, the
change requested to 4000 kb/s, eight seconds measured again.

| channel | before | after | verdict | what ffmpeg said |
|---|---|---|---|---|
| `none` (control) | 0.98 Mb/s | 0.98 Mb/s | unchanged | — |
| interactive `c`, to the encoder | 0.98 Mb/s | 0.98 Mb/s | unchanged | `Command reply for stream -1: ret:-38` |
| interactive `C`, broadcast | 1.05 Mb/s | 0.98 Mb/s | unchanged | `Command reply for stream -1: ret:-38` |
| **`zmq`, to a filter** (positive control) | 0.98 Mb/s | 0.98 Mb/s | — | **`0 Success`** |
| `zmq`, to the encoder | 0.98 Mb/s | 0.98 Mb/s | unchanged | `38 Function not implemented` |
| `v4l2-ctl --set-ctrl` from outside | 0.98 Mb/s | 0.98 Mb/s | unchanged | `rc=0`, no output |

**The positive control is what makes the rest of this table mean anything.** `zmq → eq`
answered `0 Success`, so the socket was bound, the syntax was right and commands were
landing. The same socket, the same syntax, addressed to the encoder, answers **errno 38 —
`ENOSYS`, function not implemented**. That is ffmpeg declining, not a request that never
arrived.

Two supporting observations, both read off the board:

- **`h264_v4l2m2m` has exactly two private options**, `num_output_buffers` and
  `num_capture_buffers`. Bitrate is not among them; it comes from the generic `-b:v` and is
  programmed once, at initialisation.
- **`v4l2-ctl` succeeded and changed nothing.** It returned `rc=0` because it did set the
  control — on *its own* file handle. These controls are per-open-handle, so a second
  process cannot reach the encoder ffmpeg is holding. This is K-53's finding about
  `v4l2h264enc`, reproduced for `h264_v4l2m2m`.

### ffmpeg cannot, even from a program holding the encoder context

This is the half that Task 1 skipped, so it is asked explicitly. A small program
([`ffmpeg-retune-libav.c`](../../scripts/spikes/ffmpeg-retune-libav.c)) opens
`h264_v4l2m2m` through libavcodec, encodes 300 frames, sets the bitrate on the live context
by **both** routes ffmpeg offers — `ctx->bit_rate = …` and `av_opt_set_int(ctx, "b", …)` —
and encodes 300 more. A single run cannot answer alone, so it is run against two controls:

| run | phase 1 | phase 2 | |
|---|---|---|---|
| 1000 → 4000 kb/s — **the change under test** | 1.066 Mb/s | **1.084 Mb/s** | |
| 1000 → 1000 kb/s — what *no change* looks like | 1.066 Mb/s | **1.084 Mb/s** | identical |
| 4000 → 4000 kb/s — what *changed* would look like | 3.927 Mb/s | **4.073 Mb/s** | |

**The retune run's second phase is identical to the no-change control's, to three decimal
places, and nowhere near the 4.073 that a working change produces.** A program holding the
encoder context outright cannot move this encoder's bitrate.

### The answer, stated plainly

**No, at every level.** `h264_v4l2m2m` fixes its bitrate at initialisation. The CLI's
command channels — interactive keys and the `zmq` filter alike — reach **filters**, and the
encoder answers `ENOSYS` when addressed through them. No outside process can reach it
because the V4L2 controls are per-handle. And a program owning the `AVCodecContext`, which
is the best case any future pipeline host could have, changes nothing either.

This is the good result the question was framed to allow. **Respawn-on-apply is not a
stopgap; for an ffmpeg composer it is the design.** `video/renderer.ts` already implements
that respawn and it survives the pivot untouched. K-53's proposed remedy — a pipeline host
that answers an NDJSON protocol — does not survive it: such a host would be built on
GStreamer's live-element retune, which is the capability the composer change removes.

## The Rockchip board

A Radxa Zero 3 **was** on the network, and the brief's instruction was to ask it the same
questions rather than infer. It was surveyed and then **went off the network entirely**
mid-session — no ping, no ssh — before the retune test could be run on it. It had been up
19 hours. That board has a recorded brownout fault (K-41), and this note does not claim to
know which happened.

Two boards on this bench both answer to the hostname `yonder`, which is the mDNS collision
the Radxa install note warns about. It did not affect anything here, and that was checked
rather than assumed: the host key `yonder.local` presents is byte-identical to the Pi's and
differs from the Radxa's, so **every Pi measurement in this note went to the Pi**.

### What was established before it went

<!-- yonder:hardware-observed -->

| Field | Observed |
|---|---|
| Board | `Radxa ZERO 3`, RK3566, Armbian 26.8.1 trixie, kernel `6.1.115-vendor-rk35xx` |
| MPP devices | `/dev/mpp_service` and `/dev/rga` both present, mode `0600` |
| V4L2 nodes | `video0`, `video1` only — the camera's own, no M2M nodes |
| Camera | `Global Shutter Camera` — the ELP, on this board rather than on the Pi |
| GStreamer | 1.26.2, with `gst-inspect-1.0` **installed** |
| Rockchip GStreamer elements | **none** — `gst-inspect-1.0 \| grep -iE 'mpp\|rockchip'` matched only a musepack file extension |
| H.264 encoders GStreamer can see | `openh264enc`, `x264enc` — **both software** |
| V4L2 encoder elements | none |
| Rockchip GStreamer package availability | `gstreamer1.0-rockchip`, `gstreamer1.0-rockchip1` and `gstreamer1.0-mpp` each returned **no candidate**. Three guessed names, against a package cache that was not refreshed first — enough to say none of these is installable as things stand, **not** enough to say no such package exists anywhere |
| jellyfin-ffmpeg encoders | `h264_rkmpp`, `hevc_rkmpp`, `mjpeg_rkmpp` |
| jellyfin-ffmpeg filters | `scale_rkrga`, `vpp_rkrga`, `overlay_rkrga` |
| `h264_rkmpp` options, **first 30 lines only** | `rc_mode`, `qp_init`, `qp_max`, `qp_min`, `qp_max_i`, `qp_min_i`, `intra_refresh`, `refresh_mode`, `refresh_num`, `profile`, `level` — each flagged `E..V.......`, none carrying the runtime flag. **The listing was truncated and the rest was never read** |

**This settles a question the repository had left open on inference.** The Radxa note
records that a first pass reported `mpph264enc` and four other encoders absent and that
*"all five were false negatives"*, because `gst-inspect-1.0` was not installed. So nobody
had ever successfully asked this board what GStreamer can see. It has now been asked, with
the tool present: **GStreamer 1.26.2 on this board, as installed, has no route to the
Rockchip hardware, and ffmpeg on the same board does.** That is §2's premise, measured
rather than argued from a 404 upstream.

**"As installed" is the whole of the claim.** This establishes what that board can do
today, with the packages it has. It does not establish that no GStreamer plugin could be
built to reach MPP — that is a question about carrying patches against 1.26, and it is not
answered here.

The version framing is worth correcting while this is on the record, because it is an easy
thing to get wrong. The mainline `v4l2codecs` route that GStreamer 1.22+ added is
**stateless decoders only**, and that was checked rather than recalled — though on the
**Pi's** build, which is `gstreamer1.0-plugins-bad 1.26.2-3+rpt3+deb13u2` against the
Radxa's `1.26.2-3+deb13u3`. Same upstream 1.26.2, different Debian revisions, and the
Radxa's own copy of this plugin was never inspected:

```
$ gst-inspect-1.0 v4l2codecs
  v4l2slh265dec: V4L2 Stateless H.265 Video Decoder
  1 features:
```

One element, and it decodes. On this build `v4l2codecs` ships no encoder at all, and
upstream it is a stateless-decoder plugin by design — so it is not a route to a Rockchip
*encoder* on any GStreamer version. The `v4l2h264enc` the Pi uses comes from the older
stateful `video4linux2` plugin and needs an M2M encoder node, which the Radxa does not
have.

The corresponding claim that rests on a *Radxa* observation rather than on this one is the
row in the table above: `gst-inspect-1.0` on that board listed no V4L2 encoder elements at
all. Mainline's `hantro` encode support on RK3566 covers JPEG rather than H.264, and the
vendor `rockchipmpp` plugin targets GStreamer 1.18–1.20 while that board runs 1.26. "Use
the right GStreamer version" therefore has no answer on this OS that does not involve
carrying patches, which is what §2 says.

### What is still owed on that board

- **The retune question, asked of `h264_rkmpp`.** Not run. `ffmpeg-retune.py` takes
  `--ffmpeg` and `--encoder` for exactly this, and the AVOption evidence above points the
  same way as the Pi's, but pointing is not measuring.
- **Whether `gst-libav` can wrap `h264_rkmpp`**, giving a GStreamer composer that reaches
  Rockchip hardware through libavcodec. It would remove the whole trade this note prices.
  `gst-libav` does not normally expose hardware encoders, and that expectation is exactly
  the sort of inference this spike exists to remove.
- **Latency and throughput on Rockchip.** Not asked for here, and moot for the composer
  comparison while GStreamer cannot reach that board's hardware at all.

## The recommendation to §2

**The evidence supports "one composer, and it is ffmpeg", and prices it.** Both gates §2
named are cleared on the Pi:

- **The Pi re-proof passes.** ffmpeg holds 30 fps in the two-branch shape on this board.
- **The latency risk does not materialise.** The composer's own contribution is ~120 ms,
  not seconds. §2 can stop treating two seconds as an open charge against ffmpeg.

And the Rockchip premise, which §2 argued from repository archaeology, now has board
evidence behind it: GStreamer on that board sees no Rockchip elements, no such plugin is
installable from its repos, and jellyfin-ffmpeg sees all three encoders and the RGA
filters.

**Three things should change in §2's account, none of which reverses it:**

1. **The Pi pays for this, and §2 does not say so.** About twice the CPU: +12.4 points
   against +5.8 for one branch, +18.8 against +10.5 for two. The board has the headroom —
   30.6% of four cores — but R-VID-13's "cheap second copy" gets measurably less cheap, and
   the M4 figures in `usb-camera-on-a-pi-4.md` were taken on the GStreamer path.
2. **The Pi loses its hardware scaler.** §4 gives Rockchip `scale_rkrga` and a Pi
   `v4l2convert`, but `v4l2convert` is a *GStreamer* element. Under an ffmpeg composer the
   Pi's preview downscale is software, and the ISP block at `/dev/video12` goes unused.
   §4's converter probe should say what it selects on a Pi under ffmpeg, because the honest
   answer today is `scale`.
3. **The direct translation does not run.** `h264_v4l2m2m` refuses `yuvj420p` and the
   pipeline fails to open. Whatever composes ffmpeg command lines must emit an explicit
   pixel format, and §10's tests should assert it — this is a regression that would
   otherwise be found on a board.

**And one recommendation about K-53.** Close it as won't-fix rather than leaving it open.
Its proposed remedy is a GStreamer pipeline host built on the live-element retune, and that
retune is a capability the composer change deletes. A live bitrate retune is not available
under ffmpeg from any channel, so **respawn-on-apply becomes the design** and
`video/renderer.ts` is the whole of it. Plan Task 31's rate controller should be told this
before it is written: on an ffmpeg composer, moving a rate means respawning a pipeline, and
the confirmation window and rollback that `renderer.ts` already provides are what make that
safe.

## What this does not settle

- **`h264_rkmpp`'s retune behaviour**, and everything else on Rockchip. The board went
  down. The scripts take `--ffmpeg` and `--encoder` and the run is about two minutes.
- **The two-second QGroundControl observation.** This note shows the composer is not the
  cause; it does not find what is. A real network, a real ground station and H.265 are all
  outside it.
- **RTSP.** Latency here was measured over RTP/UDP, which is what the original observation
  used. The preview branch publishes over RTSP to mediamtx, and `rtspclientsink`/`rtspsrc`
  have buffering of their own that nothing here exercised.
- **The leaky queue** (difference 3). An ffmpeg composer has no equivalent, and the
  property `QUEUE` exists to guarantee — one stalled consumer must not take down the branch
  the operator is watching — is untested under ffmpeg. It is a safety property, not a
  performance one, and it deserves its own measurement before this ships.
- **Sustained load and thermals.** Every run here is 10–25 seconds on a bench in open air,
  on a board already reading `throttled=0x80000` from before this session began.
- **Whether the CPU gap narrows with a hardware-decoded source.** §5 keeps frames on the
  SoC on Rockchip; on a Pi the JPEG decoder does not work (K-40), so both arms decode in
  software and neither can improve.

## Reproducing this

Everything runs from `scripts/spikes/`, on the board, with the daemon's camera stopped:

```bash
sudo curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"stop"}' --unix-socket /run/yonder/core.sock http://localhost/cameras/cam0/run
```

```bash
python3 composer-throughput.py --repeat 3 && python3 composer-latency.py --flashes 6 --repeat 2 --defaults-too
```

```bash
python3 ffmpeg-retune.py --window 8 && gcc -O2 -o ffmpeg-retune-libav ffmpeg-retune-libav.c $(pkg-config --cflags --libs libavcodec libavutil)
```

`composer-throughput.py --differences` prints the table of ffmpeg-versus-GStreamer
differences above. On a Rockchip board, the retune question is asked with:

```bash
python3 ffmpeg-retune.py --ffmpeg /usr/lib/jellyfin-ffmpeg/ffmpeg --encoder h264_rkmpp --channels none,stdin-c,zmq-filter,zmq-encoder
```

Put the camera back afterwards by starting it from the console, or with the same `POST`
carrying `{"action":"start"}`.
