#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Can a running pipeline change *resolution*, the way it changes bitrate?

An adaptive controller for a flying datalink needs both. Bitrate alone runs out
of room: below roughly 800 kb/s a 720p encode stops being worth sending, and the
right move is fewer pixels rather than worse ones. Spec §8.1 asks for exactly
this — a preview branch reconfigured for size and frame rate — and K-53 lists it
among the things a pipeline that cannot be spoken to makes impossible.

**Resolution is a harder question than bitrate and not the same question.** A
bitrate is a property on the encoder; `retune-bitrate.py` and
`retune-bitrate-mpp.py` show it moving with no gap on both boards. A resolution
is *caps*: changing it renegotiates the pipeline and reconfigures the encoder's
input, which on a V4L2 M2M or an MPP encoder means tearing the encode session
down and standing it back up. That is precisely where a gap would appear, and a
gap in flight is a frozen picture on the operator's screen.

So this measures two things a bitrate test does not have to:

  1. **Did the output actually change resolution?** Setting a property proves
     nothing. The encoded file is decoded afterwards and its frame sizes are
     counted, so a reconfigure that was accepted and ignored is caught.
  2. **How long was the gap?** Not merely whether one exists — the number is
     the input to whether an adaptive algorithm can use this at all.

`compose()` already names the element this addresses: the preview branch carries
`capsfilter name=preview-scale`, and `previewCaps()` in
`packages/yonder-core/src/video/pipeline.ts` builds its value. This drives that
same element.

    reconfigure-resolution.py --element v4l2h264enc --scaler v4l2convert   # Pi
    reconfigure-resolution.py --element mpph264enc  --scaler videoscale    # RK3566
    reconfigure-resolution.py --element mpph265enc  --scaler videoscale

On Rockchip this needs root: /dev/mpp_service is 0600 root:root. Configures
nothing and leaves nothing behind but a file under --workdir.
"""
import argparse, os, subprocess, sys, time
import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init(None)

PARSER = {"v4l2h264enc": "h264parse", "mpph264enc": "h264parse",
          "mpph265enc": "h265parse", "x264enc": "h264parse"}
FROM_W, FROM_H = 1280, 720
TO_W, TO_H = 640, 360
FPS = 30
WINDOW = 10.0
KBPS = 2000


def encoder_tokens(element: str) -> str:
    """The encoder as `compose()`/`encode()` writes it, per board.

    `v4l2h264enc` carries the `video/x-h264,level=(string)4` capsfilter welded
    on by `encode()`: without it the element fixates level 1 and dies on its
    first frame. The MPP encoders need nothing of the kind, and adding one
    would be the ritual `pipeline.ts`'s own comment warns against.
    """
    if element == "v4l2h264enc":
        return (f"v4l2h264enc name=enc extra-controls=controls,video_bitrate={KBPS * 1000} "
                "! video/x-h264,level=(string)4")
    if element == "x264enc":
        return f"x264enc name=enc bitrate={KBPS} speed-preset=veryfast tune=zerolatency"
    return f"{element} name=enc bps={KBPS * 1000}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--element", default="v4l2h264enc", choices=sorted(PARSER))
    ap.add_argument("--scaler", default="v4l2convert",
                    help="v4l2convert on a Pi (hardware), videoscale elsewhere (software)")
    ap.add_argument("--workdir", default="/tmp/yonder-spike")
    ap.add_argument("--ffprobe", default="ffprobe",
                    help="/usr/lib/jellyfin-ffmpeg/ffprobe on a Rockchip board")
    # **Pin the pixel format, and pin it to what the daemon actually produces.**
    # `compose()` feeds the scaler from `jpegdec`, which emits I420. Left free,
    # `videotestsrc` negotiates YUY2 with `v4l2convert` instead, and the Pi's
    # ISP rejects `S_FMT` for YUYV at the new size — a failure that belongs to
    # the format, not to the reconfigure, and that would be reported as the
    # latter by a test which did not pin this.
    ap.add_argument("--format", default="I420",
                    help="the raw format entering the scaler; I420 is what jpegdec emits")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    out = os.path.join(args.workdir, f"reconf-{args.element}.bin")

    # The preview branch of `compose()`: the scaler, then the capsfilter named
    # `preview-scale` whose value `previewCaps()` builds, then the encode.
    desc = (
        f"videotestsrc is-live=true pattern=smpte "
        f"! video/x-raw,format={args.format},width={FROM_W},height={FROM_H},"
        f"framerate={FPS}/1 "
        f"! queue leaky=downstream max-size-time=200000000 "
        f"max-size-buffers=0 max-size-bytes=0 "
        f"! {args.scaler} "
        f"! capsfilter name=preview-scale caps=video/x-raw,width={FROM_W},height={FROM_H} "
        f"! {encoder_tokens(args.element)} "
        f"! {PARSER[args.element]} ! identity name=tap ! filesink location={out}")
    p = Gst.parse_launch(desc)
    tap = p.get_by_name("tap")
    scale = p.get_by_name("preview-scale")

    start = time.monotonic()
    seen, last_pts, gaps = [0], [None], []

    def probe(pad, info):
        buf = info.get_buffer()
        seen[0] += buf.get_size()
        # Gaps are recorded with their wall-clock position and their width. A
        # bitrate retune only has to answer "was there one"; a reconfigure has
        # to answer "how long", because that is the freeze an operator sees.
        if last_pts[0] is not None:
            d = buf.pts - last_pts[0]
            if d > 3 * Gst.SECOND / FPS:
                gaps.append((time.monotonic() - start, d / Gst.SECOND))
        last_pts[0] = buf.pts
        return Gst.PadProbeReturn.OK

    tap.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
    p.set_state(Gst.State.PLAYING)

    def rate(seconds: float) -> float:
        seen[0] = 0
        time.sleep(seconds)
        return seen[0] * 8 / seconds / 1e6

    before = rate(WINDOW)
    at = time.monotonic() - start
    # ---- the reconfigure under test ----
    scale.set_property(
        "caps", Gst.Caps.from_string(f"video/x-raw,width={TO_W},height={TO_H}"))
    after = rate(WINDOW)
    p.set_state(Gst.State.NULL)
    time.sleep(1)

    late = [g for g in gaps if g[0] > at]
    print(f"{args.element} via {args.scaler} ({args.format}): "
          f"{FROM_W}x{FROM_H} -> {TO_W}x{TO_H} at {at:.2f}s   "
          f"before {before:.2f} Mb/s  after {after:.2f} Mb/s")
    print(f"  gaps: {[f'{t:.2f}s/{d*1000:.0f}ms' for t, d in gaps] or 'none'}"
          f"   after the change: {len(late)}")

    if before < 0.01:
        print("  ** NO OUTPUT — not a measurement **")
        return 2

    # **Did the bitstream actually change size?** Setting a property and having
    # it ignored looks identical from the encoder's byte count, so the file is
    # decoded and its frame sizes counted. This is the check that makes the
    # rest of the line mean anything.
    try:
        r = subprocess.run(
            [args.ffprobe, "-hide_banner", "-v", "error", "-select_streams", "v",
             "-show_entries", "frame=width,height", "-of", "csv=p=0", out],
            capture_output=True, text=True, timeout=180)
        sizes: dict[str, int] = {}
        for line in r.stdout.splitlines():
            if line.strip():
                sizes[line.strip()] = sizes.get(line.strip(), 0) + 1
        print(f"  frame sizes in the output: "
              f"{', '.join(f'{k} x{v}' for k, v in sizes.items()) or 'none decoded'}")
        changed = len(sizes) > 1
        print(f"  resolution actually changed in the bitstream: "
              f"{'YES' if changed else 'NO'}")
    except Exception as e:                                        # noqa: BLE001
        print(f"  could not verify frame sizes: {e}")
        return 3
    return 0 if changed else 1


if __name__ == "__main__":
    sys.exit(main())
