#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Does `mpph264enc` change bitrate on a running pipeline, without a respawn?

The Rockchip counterpart of `retune-bitrate.py`, and the question that decides
whether the composer has to change at all. On a Pi, GStreamer's `v4l2h264enc`
takes a runtime bitrate change and ffmpeg's `h264_v4l2m2m` does not, at any
level — so if `mpph264enc` retunes here too, GStreamer offers a live retune on
both boards and ffmpeg offers it on neither.

`gst-inspect-1.0` reports `bps` as merely "readable, writable", with none of the
"changeable in the PLAYING state" wording GStreamer prints for a mutable
property. That is a hint and not an answer, which is why this measures rather
than reads the flag.

**Runs as root.** `/dev/mpp_service` is mode 0600 root:root, so an unprivileged
process gets EACCES and the encoder fails to open — a failure that looks
nothing like a permissions problem in ffmpeg's or GStreamer's output.

The source is `videotestsrc` rather than the camera: rate control has nothing to
do against a still image, and the question here is about the encoder, not about
capture. Configures nothing; leaves nothing behind.
"""
import argparse, sys, time
import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init(None)

FROM_BPS, TO_BPS = 1_000_000, 4_000_000
WINDOW = 10.0

# Radxa's own guidance is that `mpph264enc` is the weaker of the two on the 6.1
# kernel and that `mpph265enc` should be preferred, so both are asked the same
# question rather than one standing in for the other.
PARSER = {"mpph264enc": "h264parse", "mpph265enc": "h265parse"}

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--element", default="mpph264enc", choices=sorted(PARSER))
args = ap.parse_args()

p = Gst.parse_launch(
    "videotestsrc is-live=true pattern=smpte "
    "! video/x-raw,width=1280,height=720,framerate=30/1 "
    "! queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 "
    f"! {args.element} name=enc bps={FROM_BPS} "
    f"! {PARSER[args.element]} ! identity name=tap ! fakesink sync=false")
tap, enc = p.get_by_name("tap"), p.get_by_name("enc")

start = time.monotonic()
seen, last_pts, gaps = [0], [None], []


def probe(pad, info):
    buf = info.get_buffer()
    seen[0] += buf.get_size()
    # Where each gap fell, not merely how many: a gap before the retune cannot
    # have been caused by it, and a bare count cannot make that distinction.
    if last_pts[0] is not None and buf.pts - last_pts[0] > 3 * Gst.SECOND / 30:
        gaps.append(time.monotonic() - start)
    last_pts[0] = buf.pts
    return Gst.PadProbeReturn.OK


tap.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
p.set_state(Gst.State.PLAYING)


def rate(seconds: float) -> float:
    seen[0] = 0
    time.sleep(seconds)
    return seen[0] * 8 / seconds / 1e6


before = rate(WINDOW)
retune_at = time.monotonic() - start
enc.set_property("bps", TO_BPS)          # the runtime path under test
after = rate(WINDOW)
p.set_state(Gst.State.NULL)

late = [g for g in gaps if g > retune_at]
print(f"{args.element}: before {before:.2f} Mb/s  after {after:.2f} Mb/s  "
      f"retune at {retune_at:.2f}s  gaps at {['%.2fs' % g for g in gaps]}  "
      f"after the retune {len(late)}")
# A zero is a pipeline that never emitted a frame, and is not a bitrate.
if before < 0.01:
    print("** NO OUTPUT — not a measurement **")
    sys.exit(2)
sys.exit(0 if after > before * 2 and not late else 1)
