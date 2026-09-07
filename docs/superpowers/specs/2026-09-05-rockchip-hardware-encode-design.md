# Rockchip hardware encoding, and one pipeline composer — design

**Milestone:** M6's Rockchip line, pulled forward into M4 · **Date:** 2026-09-05 · **Status:** agreed, not yet planned

M4 shipped a video pipeline that works on a Raspberry Pi. Put it on a Radxa Zero 3W and no
camera starts at all, the console tells the operator their board has no hardware encoder
when it has two, and the fallback that does run costs half the board's CPU.

This document settles how Rockchip boards encode in hardware, and — because the answer
turns out not to be GStreamer — how many pipeline implementations this project maintains.

Every number cited was measured on hardware, and the citation is the note it came from:
[`hardware-encode-on-a-radxa-zero-3w.md`](../../hardware/hardware-encode-on-a-radxa-zero-3w.md).

> **Note on placement.** This spec describes changes to `packages/yonder-core/src/video/`,
> which exists on the M4 camera branch and is not yet merged to `main`. This document and
> its two hardware notes sit on that branch alongside the code they describe, and reach
> `main` with it.

## 1. The problem is three problems with one cause

### Evidence

`pipeline.ts` hard-codes `v4l2convert` in the preview branch — line 243 on this branch, and cited by the element rather than the number because it has already moved once. `probe/encoder.ts`
looks for an encoder by walking `/dev/video10`–`/dev/video17`. Both are V4L2 M2M
assumptions, and the comment above the first says so outright: *"this board carries both
`v4l2convert` (/dev/video12) and `v4l2video18convert` (/dev/video18)"* — a sentence about a
Raspberry Pi.

An RK3566 has no V4L2 M2M nodes. It has two hardware encoders and an RGA block, all with
drivers loaded, all reached through Rockchip's MPP rather than V4L2. So:

- **No camera starts.** A pipeline naming an unresolvable element does not parse, so the
  hard-coded `v4l2convert` kills the full-rate branch too.
- **R-CAM-10 does not fire.** `refusal` was `null` and the pipeline then died with exit
  code 1 — the opaque failure that requirement exists to prevent.
- **The console lies.** `probeEncoder` returns its software fallback and prints
  *"this board offers no hardware encoder"*. It only ever established that it found none.

### Decision

The cause is not three bugs but one assumption, so it is fixed once: **what the pipeline is
made of is probed, never assumed** — the element that converts as much as the element that
encodes. R-CAM-13 already says this for the encoder; it is extended to the converter, and
the wording that overstates the probe's knowledge is corrected.

## 2. One composer, and it is ffmpeg

### The problem

Rockchip's hardware is reachable from GStreamer only through `gstreamer-rockchip`, whose
upstream (`rockchip-linux/gstreamer-rockchip`) is a 404. The surviving forks were last
touched between 2019 and 2023, need carried patches to build against GStreamer 1.26, and
carry reliability reports against them on RK35xx.

The same hardware is reachable from ffmpeg by installing one published package.

### Decision

**Yonder composes its pipelines with ffmpeg, on every board, and the GStreamer composer is
replaced rather than joined.**

The alternative — an ffmpeg composer beside the GStreamer one, selected per board — was
rejected. It leaves the most safety-relevant code in the project with two implementations
forever, and every future video feature written and tested twice. One composer reaches
hardware on Rockchip (`h264_rkmpp`, `hevc_rkmpp`, `scale_rkrga`), hardware on a Pi
(`h264_v4l2m2m`), and software anywhere (`libx264`) — the same code path, differing only in
the encoder name the probe returns.

**What this costs, stated plainly:** it changes the Pi path that M4 proved and that
currently works. That path must be re-proven on Pi hardware before this ships — the same
300-frame two-branch measurement, on a Pi with a camera. Until that measurement exists this
decision rests on inference for one of its two boards, and the plan must not treat it
otherwise.

### The risk this decision carries, and it is not settled

Roughly **two seconds** of end-to-end latency was seen in QGroundControl watching this
board over UDP H.265, against a Raspberry Pi running the GStreamer pipeline that felt
markedly quicker.

What was established: QGC's own configuration is correct — UDP h.265 source, port 5600,
Low Latency Mode on, read directly from the running application. So `rtspsrc`'s 2000 ms
default, which matches the figure almost too well, is **not** the cause: that code path is
not in use. The stream itself is sound — pulled off the server it decodes at a true 30 fps
with every frame distinct.

What was **not** established: the pipeline's own contribution. Two attempts at a
burned-in-clock measurement failed on filter escaping and on QGC holding the receive port,
and the third was abandoned rather than put a second video copy on a bandwidth-limited
link. The evidence points at the receiver. **That is an inference, not a result.**

It bears directly on this section. "One composer, and it is ffmpeg" is a much weaker
proposition if ffmpeg costs seconds of latency that GStreamer's `latency=0` sinks do not —
and latency is not a detail on an aircraft. Measuring it is therefore a **gate on this
decision**, alongside the Pi re-proof, not a task to schedule afterwards. The measurement
wants one stream carrying a burned-in frame counter, compared against what the receiver
displays; no clock synchronisation and no additional traffic are required.

### The gates were measured, and the premise failed

**Added 2026-09-06, after the measurements this section asked for.** Evidence:
[`ffmpeg-as-the-pipeline-composer.md`](../../hardware/ffmpeg-as-the-pipeline-composer.md).
The decision above is left as written; what follows is what the gates returned.

**Both gates clear.** The Pi re-proof passes — ffmpeg holds 30 fps in the two-branch shape
on a Pi with a camera, in twelve runs of which none failed, at about twice GStreamer's CPU.
And latency is not the risk this section feared: measured by crossing sender against
receiver, the composer's own contribution is **about 120 ms**, not seconds. The two-second
QGroundControl observation is not explained by ffmpeg.

**But the premise underneath the decision does not hold.** This section rejects a GStreamer
composer on Rockchip because `gstreamer-rockchip`'s surviving forks "were last touched
between 2019 and 2023" and "need carried patches to build against GStreamer 1.26". Both
claims were tested on the board and both are false: `rockchip-linux/mpp` was last committed
**2026-08-25** and JeffyCN's `gstreamer-rockchip` mirror **2026-08-26**, and the plugin
configures and compiles against GStreamer 1.26.2 with **no patches**. Installed,
`mpph264enc` and `mpph265enc` encode clean, decodable streams on an RK3566.

**And the comparison runs the other way on every axis except delivery:**

| | GStreamer | ffmpeg |
|---|---|---|
| Live bitrate retune, Pi | ✔ 0.99 → 3.02 Mb/s, no gap | ✘ `ENOSYS` at every level |
| Live bitrate retune, RK3566, H.264 and H.265 | ✔ 0.96 → 3.93 Mb/s, no gap | ✘ same |
| CPU, Pi two-branch | +10.5 points | +18.8 points |
| Latency, Pi, sender side | ~31 ms | ~153 ms |
| Camera path, RK3566, two branches | +4 points, ~29 fps | not measured |
| **Delivery** | build MPP and the plugin from source in CI | **one pinned `.deb`** |

Delivery is the one column ffmpeg wins and the cost is real. The reasons this section gave
for refusing to pay it were not.

**R-VID-07 is the tiebreaker with a requirement behind it.** A bitrate that moves on a
running pipeline is what plan Task 31's rate controller exists to use, and what §8.1 asks
for. GStreamer delivers it on both boards; ffmpeg delivers it on neither, so choosing ffmpeg
means choosing respawn-on-apply permanently and telling Task 31 so. See K-53, whose remedy
this evidence validates rather than obsoletes.

**Three corrections stand whichever composer is chosen**, because they were measured on the
Pi and are properties of that board: the direct translation of `compose()` into ffmpeg does
not run at all (`h264_v4l2m2m` refuses the `yuvj420p` its MJPEG decoder emits); under ffmpeg
the Pi has no hardware scaler, because `v4l2convert` is a GStreamer element with no ffmpeg
equivalent; and §4's converter probe therefore owes an answer for what it selects on a Pi
under ffmpeg. See also K-62.

### Decision, revised 2026-09-07

**§2's decision is reversed. Yonder composes its pipelines with GStreamer on every board;
the GStreamer composer gains a Rockchip MPP arm, and no ffmpeg composer is built.**

What changed is the addendum above. The premise this section rested on — that GStreamer
cannot reach Rockchip hardware without carried patches — was tested and is false, and the
comparison the gates produced runs the other way on every axis that has a requirement
behind it. R-VID-07 needs a bitrate that moves on a running pipeline: GStreamer's
`mpph264enc` and `mpph265enc` take one with no gap on this SoC with the real camera in front
of them, and ffmpeg takes one nowhere. K-53's pipeline host — built, and installed by
`55-pipeline-host.sh` — is the channel that reaches it.

What this settles for the sections below:

- **§3 is superseded.** Delivery was the one column ffmpeg won, and its cost is paid: MPP,
  librga and `gstreamer-rockchip` are built from pinned commits in a `debian:trixie`
  container by `installer/make-payload.sh --only gst-rockchip` and installed by
  `installer/roles/52-gst-rockchip.sh` where `/dev/mpp_service` exists. One payload for
  every board; a Pi's role skips it by the device node, never by a name (R-HW-04).
- **§4 holds, narrowed.** The probe widens to the GStreamer registry
  (`gst-inspect-1.0 --exists`). The converter probe collapses to one fact: on MPP the
  preview is scaled *inside* the encoder through RGA (`width`/`height`) — about twice a
  software scaler's throughput, the whole preview branch at one point of four cores — and
  on every other board the line is unchanged. K-62's Pi change is separate work.
- **§5 holds and is measured:** `mppjpegdec` costs +3 against software's +8.
- **§6 holds**, with one rule added: the interface's copy is always H.264 (R-VID-20).
- **§7 is untouched and still open.**
- **§8 and §9 are done** by the change that carries this revision.

Not settled, and stated so: the plugin's H.264 picture beyond one synthetic source and one
camera at 720p (Radxa's own guidance prefers `mpph265enc` on the 6.1 kernel); latency on
Rockchip; sustained load. The hardware note the change ships with records what was seen.

## 3. Delivery: one pinned package, nothing compiled

### Evidence

`jellyfin-ffmpeg7` is built `--enable-rkmpp --enable-rkrga`, published for trixie arm64,
and bundles `librockchip_mpp`, `librga` and `librockchip_vpu` while depending on nothing
outside stock trixie.

```
jellyfin-ffmpeg7  7.1.4-3-trixie  arm64   16,039,624 bytes
sha256  a8fa3ec7cf8fbaf06bb4fdb768d4dd7798277fe4c4b66884c777dc7d575877fb
```

### Decision

It is staged by `make-payload.sh` and installed offline by a role — the road ZeroTier and
mediamtx already take. Pinned by version, fingerprint recorded, and the comment says what
the trust anchor is, as `make-payload.sh` already does for mediamtx.

**Always staged, one payload.** A Pi installs it and the probe simply never selects its
Rockchip encoders. The alternative — a `--board` flag beside `--arch` — buys a few
megabytes and introduces a way to flash a Radxa with a Pi payload and get software encoding
with nothing saying why.

Rejected on the way here, and recorded so they are not revisited: building
`gstreamer-rockchip` in CI (an abandoned upstream, carried patches, and a runner question
that only exists because of them); building `librockchip-mpp` and `librga` from source
(bundled in the package above); and Radxa's own prebuilt plugin (built for bullseye — a
1.14-era plugin against trixie's GStreamer 1.26 is not guaranteed).

## 4. The probe widens; R-CAM-13 does not change

### Decision

`probeEncoder` gains an arm that asks ffmpeg what it has, keeping the V4L2 arm for Pi-class
boards. It is still probing the machine in front of it and never a table of board names, so
R-CAM-13 holds as written and R-CAM-06 stays withdrawn — nothing is resolved at install
time or recorded in configuration.

A converter probe joins it on the same injected object, so `compose()` is handed both
answers rather than assuming either: `scale_rkrga` where RGA is present, `v4l2convert`
where an M2M node provides it, and `videoconvert ! videoscale` where neither is — the
software substitution that was measured, and which is not `videoconvert` alone, because
`v4l2convert` scales and `videoconvert` does not.

Both feed `refuse()`, so a board that can satisfy neither is refused **before** Start with a
sentence naming what is missing, which is what R-CAM-10 asks for.

The `detail` string stops asserting what the board has. "No hardware encoder found" is what
the probe knows; "this board offers no hardware encoder" is not.

## 5. Hardware decode is part of the answer

### Evidence

`scale_rkrga` takes DRM-prime frames. A software split cannot feed it —
`Impossible to convert between the formats supported by the filter 'Parsed_split_0'` — and
decoding with `-hwaccel rkmpp -hwaccel_output_format drm_prime` puts frames where RGA can
reach them.

### Decision

On a board with a hardware decoder for the source format, the composer decodes in hardware
too, so frames never leave the SoC between capture and encode. This is not an optimisation
bolted on; on Rockchip it is what makes the preview branch work at all. The camera that
made this concrete emits MJPEG, and `mjpeg_rkmpp` decodes it.

## 6. H.265

### Decision

`config.yaml`'s `codec` opens from `h264` to `h264 | h265`, satisfying R-CAM-08 and the
second half of R-HW-03. A board whose probe reports no H.265 encoder refuses it through the
same `refuse()` path as everything else in §4, naming the codec.

This is the one part of this design that ripples outside the video layer: schema validation,
the uplink budget, the console's camera page and `configuration.md` all name the codec.
Radxa's own documentation recommends `mpph265enc` over `mpph264enc` on the 6.1 kernel, so
H.265 is not a luxury on this hardware — but both were measured working here, and neither
is assumed.

## 7. Nothing streams without a consumer

### The problem

M4 encodes and publishes whatever is configured, for as long as the camera is running.
On a cellular uplink that means a browser preview leaving the aircraft with nobody looking
at it, and a ground-station feed leaving it with no ground station attached. R-VID-11
reports what that costs; nothing stops it being spent for no reason.

### The constraint that shapes every option

**The camera is exclusive.** Measured, not assumed — a second process gets
`Device or resource busy`, and `fuser` names the one holding it. So the obvious
implementation is unavailable: mediamtx's `runOnDemand` per path would have `cam0` and
`cam0-preview` each spawn their own process, and the second would fail to open the camera.

### Decision

**`yonder-core` keeps sole ownership of the process holding the camera, and drives it from
demand.** It asks mediamtx how many readers each path has — the server reports this over
its API, which `media/config.ts` currently generates as `api: false` and would need to
enable on the loopback — and:

- no readers on the preview → that branch is not encoded
- no readers anywhere → the pipeline is not running at all
- a reader arrives → the branch it wants starts

One owner of the exclusive resource, no second transcode, and R-UI-05's "report the
observed state" stays truthful because the daemon still knows what it started.

**R-VID-05 is untouched, and that is the point.** Demand-driven delivers what was asked —
traffic cannot blow out without cause, because the cause *is* a consumer — while leaving
intact the priority-1 requirement that a browser preview and a ground-station feed are not
mutually exclusive. Where both are genuinely being watched, both are wanted, and R-VID-13's
cheap second copy is what makes that affordable.

Hard mutual exclusion — never more than one egress stream — was considered and **rejected**.
It contradicts R-VID-05 directly, so adopting it would mean withdrawing that requirement
rather than quietly violating it, and it buys nothing demand-driven does not already
deliver. A configurable ceiling on simultaneous egress was also rejected: it keeps
R-VID-05 true only by default, and adds a second way for a stream to be refused for a
reason an operator has to go looking for.

Deriving the preview by re-reading `cam0` back out of mediamtx would dodge the exclusivity
clash, and is rejected too: it adds a decode and an encode to a board measured at a ceiling
of two simultaneous encodes at native resolution.

### What this leaves open

An RTP output pushes to an address; it has no reader to count. Demand cannot be observed
for it, so it stays under explicit operator control — started and stopped deliberately, and
reported as running because it is. That asymmetry between pull outputs and push outputs
should be visible on the camera page rather than surprising.

## 8. What this corrects in the repository

Three claims are wrong and are fixed as part of this work, not left for someone to trip on:

| where | claim | why it is wrong |
|---|---|---|
| `architecture.md` §3.2 | encoder selection is "resolved at install time and recorded in config" | R-CAM-06 was **withdrawn** for exactly this. R-CAM-13 replaced it with a runtime probe. The architecture contradicts the requirements |
| `architecture.md` §6, `roadmap.md` M4 | Radxa is "image-only in practice", needing the vendor BSP kernel and MPP libraries | Armbian ships the BSP kernel; `install.sh` ran on it unmodified. The MPP libraries arrive in one `.deb`. Radxa is installable |
| `probe/encoder.ts` | "this board offers no hardware encoder" | False on every Rockchip vendor-kernel board |

## 9. A requirement that does not exist yet

R-CAM-07 says to use hardware encoding where the board provides it. The principle this work
was directed by is broader — **use a hardware offload wherever the board has one for a
workflow, and keep the CPU for everything else** — and it already reaches beyond encoding
here, to decode (§5) and to scaling (§4).

A new `R-HW` requirement states it, and R-CAM-07 becomes an instance of it rather than the
whole rule. IDs are stable and never reused, so this takes the next free number.

## 10. Testing

- `encoder.test.ts` gains an MPP case: a probe on a machine with `/dev/mpp_service` and an
  ffmpeg listing `h264_rkmpp` returns hardware, and one without returns software with a
  `detail` that does not overstate what it knows.
- `pipeline.test.ts` asserts that a probe reporting no M2M converter composes `videoconvert`
  **and** `videoscale`, and never `v4l2convert`. This is the regression that would have
  caught the original bug.
- `installer.test.ts` gains the assertion its sibling already suggests: every element the
  composer can name resolves on the board, and every package the roles rely on is installed
  by a role rather than assumed. `gstreamer1.0-tools` and the software encoder package are
  both currently assumed and absent.
- The Pi measurement in §2 is a gate on shipping, not a test.

## 11. Open, and deliberately not settled here

Two of these are **gates on §2**, not follow-up work. If either goes the wrong way, the
single-ffmpeg-composer decision has to be reopened rather than patched around.

- ~~**The Pi re-proof** (§2)~~ — **measured 2026-09-06 and passed.** ffmpeg holds 30 fps
  in the two-branch shape on a Pi with a camera, at about twice GStreamer's CPU.
- ~~**End-to-end latency** (§2)~~ — **measured 2026-09-06.** The composer's own contribution
  is about 120 ms, not seconds; the receiver is the larger term, which §2's inference got
  right. Neither figure reopens the decision. **A third question does:** the premise that
  GStreamer cannot reach Rockchip hardware is false — see §2's addendum.
- **Per-board encoder limits.** This board sustains two simultaneous 1920×1200 encodes;
  three fail with `ioctl(VIDIOC_QBUF): Bad file descriptor`, and degrade silently by
  duplicating frames before they do. R-HW-05 asks for such limits to be documented and
  enforced in validation, and R-CAM-10 asks for a configuration exceeding them to be
  refused with a clear message rather than met as a V4L2 error in flight. Neither is
  designed here. How the limit is *discovered* rather than tabulated — R-CAM-13's argument
  applies equally — is the harder half.
- **`by-path` identity on Rockchip.** The camera's by-path name changed across a reboot
  (`xhci-hcd.6.auto` → `.4.auto`, same camera, same port) because the `.N.auto` platform
  instantiation counter moved. R-CAM-05 requires identity to survive reboots, and on this
  SoC the name embeds something that is not a property of the port. Whether it varies on an
  unchanged configuration is unestablished — two clean reboots would answer it. Until then
  R-CAM-05 cannot be claimed on Rockchip, and any fix belongs with the enumeration code
  rather than here.
- **Enabling mediamtx's API** (§7). Demand-driven output needs reader counts, which the
  server reports over an API `media/config.ts` currently generates as `api: false`. Turning
  it on adds a listener to a device whose surfaces are deliberately few; loopback-only is
  the obvious answer and is not yet the designed one.
- **Dropping the pipeline's privileges.** `yonder-core` runs as root and spawns the encoder
  as its child, which is why `/dev/mpp_service` at `0600` costs nothing today. mediamtx
  already runs unprivileged; the encoder does not. That is a security question worth asking
  and is not this change.
- **Whether GStreamer leaves the image entirely.** This design stops composing with it. What
  else in the console or the installer still wants it is a separate audit. — **It does not** (revision above): the composer stays GStreamer, and the audit is moot.
