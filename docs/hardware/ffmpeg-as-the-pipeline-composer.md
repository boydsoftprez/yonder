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

**The short answers.** Both gates clear. ffmpeg holds real time on a Pi, at about twice
the CPU. Latency is a real cost and a small one — roughly 120 ms on the sending side,
nowhere near seconds — so the two-second figure §2 worried about is not the composer's.

**And then the premise underneath the decision turned out not to hold.** §2 rejects a
GStreamer composer on Rockchip because the plugin's forks are abandoned and need carried
patches for GStreamer 1.26. Both claims were tested here and both are false: the trees were
last committed in **August 2026**, and the plugin builds against 1.26.2 with **no patches**.
Built and installed, `mpph264enc` and `mpph265enc` encode clean, decodable streams on the
RK3566 — **and both take a live bitrate change with no gap**, which ffmpeg does on neither
board. So the honest summary is not "ffmpeg wins"; it is that the comparison §2 never ran
goes the other way on every axis measured except delivery.

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

## The Rockchip board, and a premise that does not hold

The brief's instruction was to ask the same questions of a Rockchip board rather than infer.
A Radxa Zero 3 was on the bench. It went off the network mid-session, came back on a fresh
boot — up 24 minutes against the 19 hours before — and **everything below was read on the
current boot**, not carried over from the earlier one.

Two boards here both answer to the hostname `yonder`, which is the mDNS collision the Radxa
install note warns about. It did not affect anything, and that was checked rather than
assumed: the host key `yonder.local` presents is byte-identical to the Pi's and differs from
the Radxa's, so every Pi measurement in this note went to the Pi.

**`/dev/mpp_service` and `/dev/rga` are `crw------- root root`, and an unprivileged user gets
`EACCES` on both.** Every Rockchip measurement below runs as root. This is worth stating
plainly because the failure it causes is unrecognisable: `h264_rkmpp` reports *"Error while
opening encoder — maybe incorrect parameters such as bit_rate, rate, width or height"*, which
names four things, none of them the permission that is actually missing. Spec §11 lists
dropping the pipeline's privileges as an open question; this is the concrete dependency.

### What the board has, before anything was built

<!-- yonder:hardware-observed -->

| Field | Observed |
|---|---|
| Board | `Radxa ZERO 3`, RK3566, Armbian 26.8.1 trixie, kernel `6.1.115-vendor-rk35xx` |
| MPP devices | `/dev/mpp_service`, `/dev/rga` — present, mode `0600 root:root` |
| V4L2 nodes | `video0`, `video1` only — the camera's own, no M2M nodes |
| Camera | `Global Shutter Camera` — the ELP, on this board rather than on the Pi |
| GStreamer | 1.26.2; 268 plugins, 891 features |
| Rockchip elements, **as shipped** | none. The complete `*enc*` element list held `x264enc`, `x265enc`, `openh264enc`, `vp8enc`, `vp9enc`, `av1enc`, `svtav1enc`, `theoraenc`, `jpegenc` and no Rockchip element of any kind |
| Rockchip plugin `.so` on disk | none anywhere; `GST_PLUGIN_PATH` unset, so nothing merely hidden |
| `video4linux2` plugin | `libgstvideo4linux2.so` loaded, registering **no encoder** — there is no M2M node to bind to |
| `v4l2codecs` plugin | loads with **`0 features`** |
| `gstreamer1.0-libav` | not installed. Zero `avenc_*` elements (the one grep hit was `wavenc`) |
| Packaged Rockchip path | **none.** With freshly refreshed lists, `librockchip-mpp1`, `librockchip-mpp-dev`, `librockchip-mpp`, `librga2`, `librga-dev`, `rockchip-multimedia-config` and `gstreamer1.0-rockchip` all return *no such package*, and none of the 34 available `gstreamer1.0-*` packages is a Rockchip plugin |
| Repos configured | Armbian configng, Armbian trixie, Debian trixie, Debian security. **No Radxa repo** — which is where the vendor multimedia stack lives |
| jellyfin-ffmpeg | `h264_rkmpp`, `hevc_rkmpp`, `mjpeg_rkmpp`; `scale_rkrga`, `vpp_rkrga`, `overlay_rkrga` |

So **as installed**, §2's premise reads true: GStreamer has no route to this hardware and
ffmpeg has one. That is where this note's first two passes stopped, and stopping there was
the mistake — because "as installed" is a fact about this SD card, not about GStreamer.

### The premise, tested rather than argued

§2 rejects `gstreamer-rockchip` on the grounds that its upstream is a 404 and that *"the
surviving forks were last touched between 2019 and 2023, need carried patches to build
against GStreamer 1.26"*. Every clause of that was checked.

| Claim in §2 | Observed, 2026-09-06 |
|---|---|
| the forks were last touched 2019–2023 | **False.** `rockchip-linux/mpp` last commit `0986d01`, **2026-08-25**. `JeffyCN/mirrors` branch `gstreamer-rockchip` last commit `a0d45af`, **2026-08-26**. Both eleven or twelve days old |
| needs carried patches to build against GStreamer 1.26 | **False.** `meson setup` exit 0 and `ninja` exit 0 against GStreamer 1.26.2, **no patches applied**, warnings only, producing `libgstrockchipmpp.so` |

The plugin declares `version: '1.14.4'` and requires only `gst_req >= 1.14.0`, which 1.26.2
satisfies — and the API it calls still exists.

**What it took, and it is not nothing.** `/dev/mpp_service` needs root; the MPP library had
to be built from source (`cmake`, then `make install`, giving `librockchip_mpp.so.1` and
pkg-config `rockchip_mpp 1.3.10`) because no packaged version exists in any repo this board
has; and `g++`, `meson`, `ninja-build`, `pkg-config`, `cmake`, `git`, `libgstreamer1.0-dev`,
`libgstreamer-plugins-base1.0-dev` and `libdrm-dev` all had to be installed first. This is a
from-source path, not an `apt install`.

### It registers, and both encoders work

```
$ gst-inspect-1.0 rockchipmpp
  mpph264enc: Rockchip Mpp H264 Encoder
  mpph265enc: Rockchip Mpp H265 Encoder
  mppjpegdec: Rockchip's MPP JPEG image decoder
  mppjpegenc: Rockchip Mpp JPEG Encoder
  mppvideodec: Rockchip's MPP video decoder
  mppvpxalphadecodebin: VP8/VP9 Alpha Decoder
  6 features:
```

**The board rebooted between the build and this battery, and the plugin came back by
itself** — it is installed to `/usr/lib/aarch64-linux-gnu/gstreamer-1.0/` and registers on a
cold start with nothing re-run. Every figure below was read **after** that reboot, in one
run, so the two encoders are measured under identical conditions rather than a day apart.

Both are asked the same five questions, at 1280×720p30, 300 frames from `videotestsrc`:

| | `mpph264enc` | `mpph265enc` |
|---|---|---|
| 300 frames, wall clock | **2.970 s** | **2.984 s** |
| output size | 4,220,102 bytes | 4,224,585 bytes |
| stream | `h264`, profile **High**, level **4.0**, `yuv420p` | `hevc`, profile **Main**, level **120** (HEVC 4.0), `yuv420p` |
| frames decoded | **300 / 300** | **300 / 300** |
| decoder complaints | **0** | **0** |
| picture at frame 150 | 921,600 bytes, mean 127.4, **variance 7,368** | 921,600 bytes, mean 127.5, **variance 7,368** |
| `bps=1000000` | **0.98 Mb/s** | **0.97 Mb/s** |
| `bps=4000000` | **3.92 Mb/s** | **3.91 Mb/s** |

Ten seconds of video encoded in under three seconds of wall clock, on both — roughly 3.4×
real time, which is the shape of a hardware encoder and not of a software one.

**The reported defect did not reproduce, on either encoder.** Radxa's own guidance is that
`mpph264enc` encodes badly on the 6.1 kernel and that `mpph265enc` should be preferred, and
that is the reason the middle rows of this table exist rather than only the first. On this
board, with this build, `mpph264enc` produced a bitstream that decoded end to end with zero
complaints and carried a real picture — and so did `mpph265enc`. **That is one synthetic
source on one board and is not a survey**; it is enough to say the defect is not
unconditional, and not enough to say it is absent.

**H.265 matters beyond this table.** §6 opens `config.yaml`'s `codec` from `h264` to
`h264 | h265` and R-HW-03 wants H.265 where the board has it. The Pi 4 has HEVC *decode*
hardware and no HEVC encoder, so R-CAM-08 has always been a Rockchip capability — and here
it is, in GStreamer, working, at the same cost as H.264.

### And both retune live, which is the whole question

Script: [`retune-bitrate-mpp.py`](../../scripts/spikes/retune-bitrate-mpp.py). `bps` set on
the live element while the pipeline plays, ten seconds measured either side, three runs each.

| element | run 1 | run 2 | run 3 | gaps after the retune |
|---|---|---|---|---|
| `mpph264enc` | 0.98 → **3.92** Mb/s | 0.98 → **3.92** | 0.98 → **3.92** | 0, 0, 0 |
| `mpph265enc` | 0.97 → **3.91** Mb/s | 0.97 → **3.91** | 0.97 → **3.91** | 0, 0, 0 |

**Zero timestamp gaps in any of the six runs, before or after the change.**
`gst-inspect-1.0` describes `bps` as merely "readable, writable", with none of the
"changeable in the PLAYING state" wording GStreamer prints for a mutable property — so the
flag understates what the element does, which is exactly why this was measured rather than
read off the flag.

### ffmpeg on the same board, asked the same question

`h264_rkmpp` encodes as root — 1.09 Mb/s at a 1 Mb/s target, 3.91 at 4 Mb/s — and cannot be
retuned:

| channel | before | after | verdict | what ffmpeg said |
|---|---|---|---|---|
| `none` (control) | 1.05 Mb/s | 1.05 Mb/s | unchanged | — |
| interactive `c`, to the encoder | 1.05 Mb/s | 1.05 Mb/s | unchanged | `Command reply for stream -1: ret:-38` |
| interactive `C`, broadcast | 1.05 Mb/s | 1.05 Mb/s | unchanged | `ret:-38` |
| `zmq` | — | — | **channel does not exist** | jellyfin-ffmpeg is built without the zmq filter |

`h264_rkmpp` carries **15 options** — `rc_mode`, `qp_init`, `qp_max`, `qp_min`, `qp_max_i`,
`qp_min_i`, `intra_refresh`, `refresh_mode`, `refresh_num`, `profile`, `level`, `coder`,
`8x8dct`, `udu_sei`, `prefix_mode` — and **none carries the runtime flag**. Neither does the
generic `-b`, which reads `E..VA......`. Same answer as the Pi, by the same mechanism.

## Adaptive resolution, which is the other half of the controller

A rate controller for a flying datalink needs more than a bitrate. Below roughly 800 kb/s a
720p encode stops being worth sending and the right move is fewer pixels rather than worse
ones — which is what spec §8.1 asks for, and what K-53 lists among the things a pipeline
that cannot be spoken to makes impossible. So the retune question was put a second time,
about resolution.

**It is not the same question as bitrate, and it is harder.** A bitrate is a property on
the encoder. A resolution is *caps*: changing it renegotiates the pipeline and reconfigures
the encoder's input, which on a V4L2 M2M or MPP encoder means tearing the encode session
down and standing it back up. That is where a gap would appear, and a gap in flight is a
frozen picture.

Script: [`reconfigure-resolution.py`](../../scripts/spikes/reconfigure-resolution.py). It
drives `capsfilter name=preview-scale` — the element `compose()` already names and
`previewCaps()` already builds — from 1280×720 to 640×360 on a running pipeline, and then
**decodes the output and counts frame sizes**, because setting a property that is silently
ignored looks identical from the encoder's byte count.

| board | scaler ahead of the encoder | resolution changed in the bitstream | gap |
|---|---|---|---|
| Pi | **`v4l2convert`** — the hardware ISP scaler `compose()` uses | **NO** — the pipeline dies | — |
| Pi | `videoscale` (software) | **YES** — 300 frames at 720p, then 300 at 360p | **none** |
| Pi | `videoconvert ! videoscale` (software) | **YES** — 300 then 300 | **none** |
| Pi | `v4l2video18convert` — the *other* hardware M2M converter | cannot scale **at all**, even set at start | — |
| Pi | `glcolorscale` (V3D GPU) | **unsettled** — no headless GL context obtained | — |
| RK3566 | `videoscale` + `mpph264enc` | **YES** — 300 then 299 | **none** |
| RK3566 | `videoscale` + `mpph265enc` | **YES** — 300 then 299 | **none** |

**Zero timestamp gaps in every case that worked**, on either board, for either codec. An
adaptive controller can move bitrate *and* resolution on a live GStreamer pipeline without
the operator seeing a freeze.

### The Pi's hardware scaler cannot be reconfigured, and that is not a hardware limit

`v4l2convert` fails the same way every time, reproduced four times across three pixel
formats:

```
v4l2convert0: error: Call to S_FMT failed for YU12 @ 640x360: Invalid argument
basetransform: FAILED to configure incaps … and outcaps … width=640, height=360
videotestsrc0: error: streaming stopped, reason not-negotiated (-4)
```

It takes the whole pipeline down, not just the branch. It fails identically for `YUY2`,
`I420` and `NV12`, so it is not the pixel format — the first run of this test used `YUY2`
because `videotestsrc` negotiated it, and pinning the format to the `I420` that `jpegdec`
actually hands the daemon's scaler changed nothing.

**The silicon is not the constraint, and this was checked rather than assumed.** The same
element scales 1280×720 to 640×360 without complaint when the size is set before the
pipeline starts — the two-branch throughput runs in this note do exactly that, and produce
a preview branch of about a megabyte per 300 frames. What fails is only `S_FMT` *while the
device is streaming*, which is the V4L2 M2M contract: `STREAMOFF` must come first, and
GStreamer's `v4l2transform` does not perform that stop-reconfigure-restart dance.

**Nor is `v4l2convert` the only hardware converter on the board.** `pipeline.ts`'s own
comment names a second, and it was tested: `v4l2video18convert` on `/dev/video18`
(`bcm2835-codec-image_fx`) refuses to scale at start and refuses an `I420` → `NV12`
conversion at a fixed size too. It advertises `width: [1, 32768]` in its template and
negotiates neither, which is consistent with `usb-camera-on-a-pi-4.md` already marking that
node "Not needed". The GPU scaler `glcolorscale` exists as an element; it failed first on
`/dev/dri/renderD128: Permission denied` — the node is `root:render` and the service user is
in `video` but not `render` — and then, with that removed, on GL context creation in a
headless session. **It is not established either way and should not be written off.**

### What the trade costs — and it is not a cost

Since adaptive resolution on a Pi means giving up `v4l2convert` for a software scaler, the
two were measured against each other in the same two-branch shape. First from a 1280×720
capture, preview at 640×360:

| preview scaler | cpu (4 cores), two runs | above idle |
|---|---|---|
| `v4l2convert` (hardware) | 23.6%, 22.5% | ~+12.7 |
| `videoconvert ! videoscale` (software) | 22.4%, 21.8% | ~+11.8 |

Indistinguishable — the software figure is nominally lower, which at this size is noise.
Then from a **1920×1080** capture, which is where a software scaler has the most pixels to
move and where it should lose:

| preview scaler | cpu (4 cores), three runs | median above idle | preview bytes per 300 frames |
|---|---|---|---|
| `v4l2convert` (hardware) | 40.9%, 45.1%, **53.4%** | **~+34.7** | 836 k, 844 k, 893 k |
| `videoconvert ! videoscale` (software) | 32.0%, 31.2%, 31.8% | **~+20.4** | **1031 k, 1031 k, 1192 k** |

Baselines 10.4% and 11.4%; `throttled` read `0x80000` throughout both sets, with no
throttling bit active — the ffmpeg arms were excluded from these runs precisely because they
drive this board into `0x80008` at 1080p and every number after that measures the heatsink.

**The software scaler is cheaper, steadier and delivers more.** It costs about fourteen
points less of a four-core board; its three runs sit within 0.8 points of each other while
the hardware scaler's climb from 40.9% to 53.4% as the board warms; and it produced
**about 20% more preview bytes for the same 300 frames at the same target bitrate**, which
means the hardware path was dropping preview frames into the leaky queue while the software
path kept up.

**This is not a new discovery, and the repository already said so.**
[`usb-camera-on-a-pi-4.md`](usb-camera-on-a-pi-4.md) records *"Defect 2 — the ISP converter
is pure overhead, and looks like the opposite"*, and marks `/dev/video12` in its device
table as *"Works, and **should not be used**"*. `compose()` uses it in the preview branch
anyway. What is new here is that the same finding holds in the *preview* branch at 1080p,
and that it removes the only apparent reason to keep an element that cannot be reconfigured
live.

So the trade an adaptive controller was supposed to make — give up hardware scaling, pay CPU
for it — **does not exist on this board.** Dropping `v4l2convert` for `videoconvert !
videoscale` buys live resolution changes and costs nothing; it gives CPU back.

**On Rockchip the question does not arise, because there is nothing to trade.** No RGA or
other hardware scaler element exists in GStreamer on that board — `gst-inspect-1.0` offers
only `videoscale`, `videoconvert` and `videoconvertscale`, all software, and the two extra
plugins the Rockchip build produces are a display sink (`rkximagesink`) and a DRM source
(`kmssrc`). ffmpeg has `scale_rkrga` there and GStreamer does not, which is the mirror image
of the Pi — except that on the Pi the hardware scaler turns out to be the slower option.

## What the published guidance says, and where it disagrees

The measurements above were taken before this was researched, and the general guidance for
both SoCs says the *opposite* of one of them. That disagreement is worth resolving rather
than picking whichever answer is convenient.

### The Pi: hardware scaling is right, until the ISP runs out

Raspberry Pi's own forums are unambiguous that `v4l2convert` should be preferred to software
scaling — *"use of videoscale and videoconvert means all the processing is on the ARM"* —
and report software scaling collapsing to single-digit frame rates. That is the opposite of
what this note measured at 1080p.

**The reconciliation is one sentence in the same source**, and it is the sentence that
matters here: *"libcamera, v4l2convert and v4l2h264enc all pass the images through the ISP
hardware block, so you're likely exceeding the hardware's capabilities when using multiple
ISP-based components in series."* The block is shared, and its ceiling is quoted in
macroblocks per second — nominally 1080p30, *"generally 1080p50 for encode"*.

`compose()` puts **three** consumers on that block: the full-rate encode, the preview encode,
and `v4l2convert`. Against a 408,000 macroblock/s ceiling:

| | ISP load | verdict | what was measured |
|---|---|---|---|
| 720p capture, with `v4l2convert` | 243,600 mb/s | within budget | hardware ≈ software |
| **1080p capture, with `v4l2convert`** | **517,200 mb/s** | **over budget** | hardware slower, dropping preview frames |
| 1080p capture, software scaler | 272,400 mb/s | within budget | steady, no drops |

The arithmetic predicts the crossover this note measured, from the other side. **The guidance
is right and so is the measurement**: hardware scaling wins while the ISP has headroom, and
loses once the pipeline has spent that headroom on two encodes. Moving the scale to the CPU
is not a defeat — it buys ISP capacity back for the encodes, which are the part that cannot
move.

This also explains `usb-camera-on-a-pi-4.md`'s *"Defect 2 — the ISP converter is pure
overhead, and looks like the opposite"*, which observed the effect without naming the cause.

### The Pi: why the live change is refused, and it is the driver

The V4L2 memory-to-memory specification states that to support dynamic resolution changes,
`S_FMT` **should be allowed even when OUTPUT buffers are already allocated**. The Pi's
`bcm2835-codec` refuses it — `Call to S_FMT failed for YU12 @ 640x360: Invalid argument`.
So this is a driver gap measured against a published contract, not a GStreamer defect and
not a hardware limit; the same element scales to the same size happily when told before it
starts.

The documented remedy was tried and does not help. GStreamer's `capsfilter` carries
`caps-change-mode=delayed` for exactly this case; with it, the pipeline no longer dies —
it simply never changes size, producing 180 frames all at 1280×720. Better behaviour, same
answer.

**And the GPU is not a way round it.** `glcolorscale` exists, but headless GL on a Pi is a
known-bad path — the Raspberry Pi forums carry a thread titled precisely *"support for
glcolorscale on raspberry pi (headless)"*, and report that no basic decode-scale-stream
pipeline commonly works. Reported DRM/EGL throughput of about 20 fps at 1080p would not be
enough here even if it did. This note's own attempt failed first on a render-node permission
and then on GL context creation, which matches. **Not a promising avenue.**

### Rockchip: RGA is real, reachable, and about twice as fast

RK3566 carries **RGA2-Enhance**, whose documented scaling range is **1/16 to 16×** with
average filtering on downscale — so 1280×720 to 640×360 is comfortably inside it.

**The RGA path is reachable from GStreamer, and this note's first pass said otherwise.**
That was wrong for a mechanical reason: `gstreamer-rockchip`'s `meson_options.txt` carries
`option('rga', type: 'feature', value: 'auto')`, `librga` was not installed, and the build
silently skipped it. With `librga` 1.10.0 installed the option reports `rga: enabled`, and
`mpph264enc`/`mpph265enc` gain `width`, `height` and `rotation` properties that scale
**inside the encoder**, through RGA, with no scaler element in the pipeline at all.

It works and it is much faster. 300 frames, 1920×1080 down to 640×360, encoded:

| | wall clock, two runs |
|---|---|
| RGA, via the encoder's `width`/`height` | **6.82 s, 6.97 s** |
| `videoconvert ! videoscale`, software | 14.12 s, 14.20 s |

**Roughly twice the throughput.** (CPU read about 49% in both, because `videotestsrc`
generating 1080p dominates it; wall clock is the honest signal here and the CPU figure is
not quoted as a result.)

**But `width` and `height` cannot be changed on a running pipeline.** Setting them mid-stream
is accepted silently and ignored: 600 frames came out, all at 1280×720, with no gap and no
error. Only the bitstream check catches that — a test that asked whether the property took
would have reported success. So RGA gives a *fixed* hardware downscale, not an adaptive one.

A standalone `rgaconvert` element does exist, but not in this fork: the JeffyCN mirror has
no `-extra` branch, and `rgaconvert` lives in third-party repositories. It was not built or
tested here.

### What comparable projects do — read from their source, not their documentation

Two open-source projects solve this exact problem — adaptive video over a variable radio
link on Pi-class hardware. Their documentation is vague about restarts, so both were cloned
and read. Both are current: OpenHD's last commit is 2026-02-28, RubyFPV's 2026-02-19.

**OpenHD holds the pipeline in its own process**, which is the architecture K-53 proposes
for Yonder and which the daemon does not have today:

```c
m_gst_pipeline = gst_parse_launch(pipeline_content.str().c_str(), &error);
```
*(`ohd_video/src/gstreamerstream.cpp:312`.* `gst-launch` appears in that repository only in
debug scripts and test files.)

It then keeps a reference to the encoder, found **by name**, and changes the bitrate on it.
Its own comments state the policy plainly:

> *"Bitrate is one of the few params we want to support changing dynamically at run time
> without the need for a pipeline restart."* — `gst_bitrate_controll_wrapper.hpp`
>
> *"Bitrate is the only value we (NEED) to support changing without a restart"* —
> `gstreamerstream.cpp:518`

Everything else calls `request_restart()`.

**Two details there are worth copying, and Yonder has neither.**

- **It asks at start-up whether dynamic control actually works**, by reading the property
  back before relying on it, and degrades gracefully when it does not: a `-1` yields
  *"dynamic bitrate control element doesn't work"* and the control is reported as absent
  rather than silently doing nothing.
- **It verifies every change by reading the value back** after setting it, and warns
  *"Cannot change bitrate to {}kbit/s, got {}kBit/s"* when the encoder disagreed.

This note measured exactly why the second one matters: setting `width`/`height` on
`mpph264enc` mid-stream is **accepted without error and ignored**, and only decoding the
output revealed it. A control that reports success it did not achieve is K-48's failure
mode, one layer down.

Its structure otherwise matches `pipeline.ts` closely — a per-encoder struct carrying
`property_name` and `takes_kbit`, because *"Some elements take kbit/s, some take bit/s"* and
*"Not all encoders / elements call the bitrate property 'bitrate'"*, which is what
`bitrateOf()` switches on.

**RubyFPV reaches the same conclusion by a completely different route.** It uses no
GStreamer at all: it drives `majestic` (the OpenIPC streamer), Rockchip's MPP directly, and
`raspivid`. A bitrate change is an HTTP call to the encoder daemon —

```
curl -s localhost/api/v1/set?video0.bitrate=%u
```

*(`base/hardware_cam_maj.cpp:1113`,* with a `cli -s .video0.bitrate` fallback when the
control thread is not running.) So the encoder is a separate service with a control API
rather than an element in a pipeline. And its radio protocol carries an explicit
notification for what a resolution change costs:

> *"7 - notif: video recording restarted due to resolution change"* — `radio/radiopackets2.h:828`

**Neither project changes resolution without a restart.** Searched for, in both trees, and
absent. Two independent designs — an in-process GStreamer host and an out-of-process encoder
daemon with an HTTP API — converge on the same split: **bitrate live, resolution by
restart.**

### The best practice this converges on

1. **Adapt bitrate continuously and live.** It is the one control that works on every
   encoder measured — `v4l2h264enc`, `mpph264enc`, `mpph265enc` — with zero timestamp gaps,
   and it is what the peer projects lean on.
2. **Treat resolution as a coarse, infrequent step, and respawn for it.** `video/renderer.ts`
   already respawns on an applied change and carries the confirmation window and rollback.
   That is the honest mechanism for a rung change on either board, and it is what both peer
   projects do.
3. **Read every control back after setting it.** OpenHD does; Yonder does not. `mpph264enc`
   accepts a `width` change mid-stream, reports nothing, and ignores it — a control that
   claims a success it did not achieve is the shape of K-48.
4. **Where the resolution is fixed, take the hardware scaler** — RGA via the MPP encoder's
   `width`/`height` on Rockchip, which is free and twice as fast; `v4l2convert` on a Pi
   **only while the ISP has headroom**, which the macroblock table above decides.
5. **Where live resolution changes are genuinely wanted, use the software scaler**, accept
   that it is CPU, and know it costs nothing on a Pi at 1080p because it hands ISP capacity
   back.

## The recommendation to §2

**The evidence does not support "one composer, and it is ffmpeg". It removes the premise the
decision was built on, and the decision should be reopened.**

§2's case is that ffmpeg is the only composer that reaches hardware on both boards. On the
two boards in front of us, measured this session, that is not true — and the comparison runs
the other way on every axis that was measured:

| | GStreamer | ffmpeg |
|---|---|---|
| Hardware encode, Pi | `v4l2h264enc` ✔ | `h264_v4l2m2m` ✔ |
| Hardware encode, RK3566 | `mpph264enc` ✔ *(built from source)* | `h264_rkmpp` ✔ *(one package)* |
| **Live bitrate retune, Pi** | **✔** 0.99 → 3.02 Mb/s, no gaps | **✘** ENOSYS, at every level including a program holding `AVCodecContext` |
| **Live bitrate retune, RK3566 H.264** | **✔** 0.98 → 3.92 Mb/s, no gaps | **✘** ENOSYS on the channels that exist |
| **Live bitrate retune, RK3566 H.265** | **✔** 0.97 → 3.91 Mb/s, no gaps | **✘** same |
| H.265 encode (R-CAM-08, R-HW-03) | `mpph265enc` ✔ Main/4.0, clean | `hevc_rkmpp` ✔ |
| CPU, Pi two-branch | **+10.5 points** | +18.8 points |
| Latency, Pi, sender side | **~31 ms** | ~153 ms |
| Hardware preview scaler, Pi | `v4l2convert` — present, and **measurably worse than software** | none — software `scale` |
| Hardware preview scaler, RK3566 | none — software `videoscale` | `scale_rkrga` ✔ |
| **Live resolution change** | **✔** both boards, both codecs, no gap — via a software scaler | **✘** no channel reaches the encoder at all |
| Delivery | build MPP and the plugin from source | one pinned `.deb` |

**What §2 gets right, and it is the only column ffmpeg wins:** delivery. `jellyfin-ffmpeg7`
is one published package. The GStreamer path needs MPP and the plugin built from source, in
CI, for the offline payload — which is precisely the cost §2 refused to take on, and it
refused on the strength of two factual claims about those repositories that are **both
false**. The cost is real; the reasons given for it were not.

**Three things follow, and none of them is "carry on".**

1. **§2's evidence must be corrected before it is relied on again.** The forks are current,
   and the plugin builds clean against 1.26 with no patches. Whatever is decided, it cannot
   be decided on those two sentences.
2. **The retune result should drive the decision, because it is the one with a requirement
   behind it.** R-VID-07 wants a bitrate that moves on a running pipeline, and plan Task 31's
   rate controller has no subject without one. GStreamer delivers that on both boards;
   ffmpeg delivers it on neither. Choosing ffmpeg means choosing respawn-on-apply for ever
   and telling Task 31 so.
3. **K-53 should not close as won't-fix.** The reasoning for closing it was that a GStreamer
   pipeline host would be thrown away by the composer pivot. If the pivot is in doubt, so is
   that reasoning — and the host is now the more valuable of the two paths, since a live
   retune exists on both boards to be reached.

**Two corrections stand regardless of which composer wins**, because they are about the Pi
and were measured there:

- **The direct translation of `compose()` into ffmpeg does not run.** `h264_v4l2m2m` refuses
  the `yuvj420p` its MJPEG decoder emits, and the smallest repair adds a per-pixel range pass
  GStreamer never performs.
- **Under ffmpeg the Pi loses its hardware scaler.** §4 gives Rockchip `scale_rkrga` and the
  Pi `v4l2convert`, but `v4l2convert` is a *GStreamer* element with no ffmpeg equivalent.

## What this changes in the code, whichever composer wins

Three of these are independent of the §2 decision: they are measured properties of the
boards and of the daemon's own pipeline, and they hold under either composer.

### 1. Read every control back after setting it

`video/encoder.ts` sets a control and treats the absence of an error as success.
**On this hardware that is not safe, and there is a measured case.** Setting `width` on a
live `mpph264enc` is accepted, returns nothing, logs nothing — and is ignored. Six hundred
frames came out at the original size with no gap and no complaint. Only decoding the output
revealed it.

An `Ack` that reports a change which did not happen is K-48's failure with the layers
swapped: there, `config.yaml` disagreed with the encoder and every file that answered from
the config was wrong. Here the *encoder* would disagree with itself.

OpenHD does this and Yonder does not — it reads the property back after writing it and warns
`"Cannot change bitrate to {}kbit/s, got {}kBit/s"` when the two disagree. The same read-back
belongs in `EncoderChannel`'s apply path, and the `Ack` should carry what the encoder
actually reports rather than what it was asked for.

### 2. Probe whether live control works, rather than deriving it

`encodeControl()` returns `null` where the launch line carries no encoder element, and
`video/encoder.ts` turns that into the `notControllable` an operator sees. That is a good
answer to *"is there something to address"* and not an answer to *"will it listen"* — the
`mpph264enc` case above has an element, a name, and a property, and does not listen.

OpenHD probes at start-up by reading the property back before relying on it, and reports the
control as absent when that fails rather than offering one that quietly does nothing. That
check needs a pipeline the daemon can address at all, so it belongs with K-53's host.

### 3. Take `v4l2convert` out of the preview branch

`compose()` builds the preview branch with `v4l2convert`. Three measured reasons to replace
it with `videoconvert ! videoscale`, and none of them depend on the composer:

- **It cannot be reconfigured on a running pipeline**, so it blocks a live resolution change
  outright — `S_FMT` fails and the whole pipeline stops, not just the branch.
- **It is not buying performance.** Equal to software from a 720p capture; from 1080p it
  costs about fourteen points more of the board *and* delivers about 20% fewer preview bytes,
  because the ISP is over budget and dropping frames.
- **`usb-camera-on-a-pi-4.md` already says so** — "Defect 2 — the ISP converter is pure
  overhead" — and marks the device "should not be used".

The substitution is `videoconvert ! videoscale` and not `videoscale` alone: `v4l2convert`
converts as well as scales, and the Radxa note records the same trap from the other side.

**On Rockchip the opposite applies.** There the hardware scaler is reached through the MPP
encoder's own `width`/`height` properties, it is about twice as fast as software, and it is
configured at start — which is exactly how a respawn-on-rung-change design uses it anyway.

### 4. Make the Pi's ISP budget a refusal, not a symptom

`v4l2convert` and `v4l2h264enc` share one hardware block whose ceiling is quoted in
macroblocks per second — generally 1080p50 for encode. `compose()` puts three consumers on
it, and at a 1920×1080 capture the two-branch pipeline asks for about 517,000 mb/s against a
ceiling near 408,000. **The symptom of exceeding it is silently dropped frames**, which is
precisely the class of failure R-CAM-10 exists to refuse before Start rather than meet in
flight.

`refuse()` is the right place and it is already pure: capture size, frame rate, preview rung
and branch count are all in `ComposeOptions`, so the load is arithmetic on values it already
holds. Spec §11 lists per-board encoder limits as unsettled and asks how a limit is
*discovered* rather than tabulated; on a Pi this is one multiplication, and the probe already
knows which board it is on.

## What this does not settle

- **The picture quality question, properly.** Both MPP encoders produced clean, decodable
  streams carrying a real picture — from **one synthetic source, on one board, at one
  size**. Radxa's reported `mpph264enc` defect did not reproduce, which establishes that it
  is not unconditional and nothing more. A camera source, other resolutions and a look at
  the actual image are all owed before this is leaned on.
- **The camera path on Rockchip.** Everything measured there came from `videotestsrc`. The
  ELP camera on that board emits MJPEG, so the real chain is `mppjpegdec` → `mpph26xenc`,
  and none of it was exercised. §5's zero-copy `drm_prime` claim is likewise untested here.
- **CPU and latency on Rockchip.** Measured on the Pi only. The recommendation leans on the
  Pi's figures plus the Rockchip retune result; a two-branch and latency comparison on the
  Radxa would make the comparison symmetric, and it has not been run.
- **What shipping a from-source GStreamer path actually costs.** MPP and the plugin were
  built by hand here, as root, with nine build packages installed. Doing it in CI, pinning
  it, and staging it in the offline payload is real work that §3's single `.deb` avoids —
  and it is now the honest trade, rather than the false one §2 stated.
- **Whether the GPU can scale on a Pi.** `glcolorscale` exists; the render-node permission
  that blocked it first was removed and it then failed on GL context creation in a headless
  session. If it works it is a hardware scaler that *can* be reconfigured live, which would
  remove the Pi's trade entirely. Untested, not disproven.
- **Whether a preview at 1280×720 changes the scaler trade.** The software and hardware
  scalers were indistinguishable at 640×360. That is the rung measured, and the board's own
  configuration currently holds 1280×720, which was not.
- **Resolution changes in the other direction, and repeatedly.** Every run here steps down
  once, 1280×720 to 640×360. An adaptive controller steps up as well and does so repeatedly
  with hysteresis; whether a long sequence of changes ever produces a gap is untested.
- **The two-second QGroundControl observation.** This note shows the composer is not the
  cause; it does not find what is. A real network, a real ground station and H.265 over the
  air are all outside it.
- **RTSP.** Latency was measured over RTP/UDP, which is what the original observation used.
  The preview branch publishes over RTSP to mediamtx, and `rtspclientsink`/`rtspsrc` carry
  buffering of their own that nothing here exercised.
- **The leaky queue** (difference 3). An ffmpeg composer has no equivalent, and the property
  `QUEUE` exists to guarantee — one stalled consumer must not take down the branch the
  operator is watching — is untested under ffmpeg. It is a safety property, not a
  performance one.
- **Sustained load and thermals.** Every run here is seconds long on a bench in open air, on
  a Pi already reading `throttled=0x80000` before this session began.
- **Whether the CPU gap narrows with a hardware-decoded source.** §5 keeps frames on the SoC
  on Rockchip; on a Pi the JPEG decoder does not work (K-40), so both arms decode in software
  and neither can improve.

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
differences above.

### On a Rockchip board

Everything below needs root: `/dev/mpp_service` is mode `0600 root:root`, and an
unprivileged process fails with an error that names bit rate and frame size rather than the
permission actually missing.

Ask ffmpeg the retune question:

```bash
python3 ffmpeg-retune.py --ffmpeg /usr/lib/jellyfin-ffmpeg/ffmpeg --encoder h264_rkmpp --channels none,stdin-c,stdin-C
```

Build the GStreamer MPP path, which no repository packages — MPP first, then the plugin:

```bash
apt-get install -y g++ meson ninja-build pkg-config cmake git libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libdrm-dev
```

```bash
git clone --depth=1 https://github.com/rockchip-linux/mpp.git && cmake -S mpp -B mpp/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_TEST=OFF && make -C mpp/build -j4 install && ldconfig
```

```bash
git clone --depth=1 --branch gstreamer-rockchip https://github.com/JeffyCN/mirrors.git gstreamer-rockchip && meson setup gstreamer-rockchip/build gstreamer-rockchip --prefix=/usr --libdir=lib/aarch64-linux-gnu && ninja -C gstreamer-rockchip/build install && rm -rf ~/.cache/gstreamer-1.0
```

Then ask GStreamer the same question, of each encoder:

```bash
gst-inspect-1.0 rockchipmpp && python3 retune-bitrate-mpp.py --element mpph264enc && python3 retune-bitrate-mpp.py --element mpph265enc
```

### Adaptive resolution, on either board

```bash
python3 reconfigure-resolution.py --element v4l2h264enc --scaler "videoconvert ! videoscale" --format I420
```

```bash
python3 reconfigure-resolution.py --element mpph265enc --scaler videoscale --ffprobe /usr/lib/jellyfin-ffmpeg/ffprobe
```

Substituting `--scaler v4l2convert` on the Pi reproduces the failure recorded above. The
cost of the software scaler in the two-branch shape is measured with
`composer-throughput.py --preview-scaler "videoconvert ! videoscale"`.

Put the Pi's camera back afterwards by starting it from the console, or with the same `POST`
carrying `{"action":"start"}`.
