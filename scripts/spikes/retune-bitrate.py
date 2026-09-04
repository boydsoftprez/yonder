#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Does the running encoder change bitrate when told to, without a restart?
# Run on the board with the camera idle. Configures nothing; leaves nothing.
import gi, sys, time
gi.require_version("Gst", "1.0")
from gi.repository import Gst
Gst.init(None)
p = Gst.parse_launch(
    # The camera offers MJPG at 1280x720/30 and YUYV only at 10 fps, so the
    # spike decodes, exactly as the daemon does (video/pipeline.ts).
    "v4l2src device=/dev/video0 ! image/jpeg,width=1280,height=720,framerate=30/1 "
    "! jpegdec ! videoconvert "
    "! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000,h264_level=11 "
    "! h264parse ! identity name=tap ! fakesink sync=false")
tap, enc = p.get_by_name("tap"), p.get_by_name("enc")
bytes_seen, last_pts, gaps = [0], [None], [0]
def probe(pad, info):
    buf = info.get_buffer(); bytes_seen[0] += buf.get_size()
    if last_pts[0] is not None and buf.pts - last_pts[0] > 3 * Gst.SECOND / 30: gaps[0] += 1
    last_pts[0] = buf.pts; return Gst.PadProbeReturn.OK
tap.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
p.set_state(Gst.State.PLAYING)
def rate(seconds):
    bytes_seen[0] = 0; time.sleep(seconds); return bytes_seen[0] * 8 / seconds / 1e6
before = rate(10)
s = Gst.Structure.new_empty("controls"); s.set_value("video_bitrate", 3000000)
enc.set_property("extra-controls", s)             # the runtime path under test
after = rate(10)
p.set_state(Gst.State.NULL)
print(f"before {before:.2f} Mb/s  after {after:.2f} Mb/s  timestamp gaps {gaps[0]}")
sys.exit(0 if after > before * 2 and gaps[0] == 0 else 1)
