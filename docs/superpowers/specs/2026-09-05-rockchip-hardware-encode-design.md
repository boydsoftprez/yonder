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

- **The Pi re-proof** (§2). Named as the risk it is.
- **End-to-end latency** (§2). Roughly two seconds observed; the receiver is the likely
  cause and the pipeline's own share is unmeasured. A gate, for the reason §2 gives.
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
  else in the console or the installer still wants it is a separate audit.
