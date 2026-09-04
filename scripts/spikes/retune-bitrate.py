#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Does the running encoder change bitrate when told to, without a restart?
# Run on the board with the camera idle. Configures nothing; leaves nothing.
import gi, sys, time
gi.require_version("Gst", "1.0")
from gi.repository import Gst
Gst.init(None)
# The full-rate branch of compose()/encode() in video/pipeline.ts. The level
# capsfilter is not decoration: without it the encoder fixates level 1, which
# cannot carry 720p, and the driver refuses to start on the first frame.
p = Gst.parse_launch(
    "v4l2src device=/dev/video0 io-mode=4 "
    "! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec "
    "! queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 "
    "! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000 "
    "! video/x-h264,level=(string)4 "
    "! h264parse ! identity name=tap ! fakesink sync=false")
tap, enc = p.get_by_name("tap"), p.get_by_name("enc")
start = time.monotonic()
bytes_seen, last_pts, gaps = [0], [None], []
def probe(pad, info):
    buf = info.get_buffer(); bytes_seen[0] += buf.get_size()
    # When each gap happened, not merely how many. A gap that precedes the
    # retune call cannot have been caused by it, and a bare count cannot say
    # so — which is the whole question this spike turns on.
    if last_pts[0] is not None and buf.pts - last_pts[0] > 3 * Gst.SECOND / 30:
        gaps.append(time.monotonic() - start)
    last_pts[0] = buf.pts; return Gst.PadProbeReturn.OK
tap.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
p.set_state(Gst.State.PLAYING)
def rate(seconds):
    bytes_seen[0] = 0; time.sleep(seconds); return bytes_seen[0] * 8 / seconds / 1e6
before = rate(10)
s = Gst.Structure.new_empty("controls"); s.set_value("video_bitrate", 3000000)
retune_at = time.monotonic() - start
enc.set_property("extra-controls", s)             # the runtime path under test
after = rate(10)
p.set_state(Gst.State.NULL)
late = [g for g in gaps if g > retune_at]
print(f"before {before:.2f} Mb/s  after {after:.2f} Mb/s  "
      f"retune at {retune_at:.2f}s  gaps at {['%.2fs' % g for g in gaps]}  "
      f"after the retune {len(late)}")
sys.exit(0 if after > before * 2 and not late else 1)
