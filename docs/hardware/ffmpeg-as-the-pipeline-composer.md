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
| Hardware preview scaler, Pi | `v4l2convert` ✔ | none — software `scale` |
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

Put the Pi's camera back afterwards by starting it from the console, or with the same `POST`
carrying `{"action":"start"}`.
