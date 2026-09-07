#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Does ffmpeg cost latency that GStreamer's `latency=0` path does not?

The Rockchip design (§2) carries this as an unsettled risk and calls measuring
it "a gate on this decision": roughly two seconds of end-to-end latency was seen
in QGroundControl watching an ffmpeg-composed stream, against a Raspberry Pi
running the GStreamer pipeline that felt markedly quicker. What was never
established is **the pipeline's own contribution** — the evidence pointed at the
receiver, and the spec says plainly that this is an inference, not a result.

So this measures sender and receiver separately, by crossing them: every
composer sends to every composer. If ffmpeg-the-sender is slow, its row is slow
against both receivers. If ffmpeg-the-receiver is slow, its column is slow
against both senders. One number could not have told those apart, which is why
the original observation could not settle it.

## What is measured, and what is not

The spec asks for "one stream carrying a burned-in frame counter, compared
against what the receiver displays". This does that, without OCR: the source is
black, and every FLASH_PERIOD frames it emits one white frame. The writer
records `time.monotonic()` as that frame goes in; the reader records
`time.monotonic()` when mean luminance rises at the far end. Sender and receiver
are the same process on the same board, so there is one clock and nothing to
synchronise — which is what the spec said the measurement would need.

**The camera is not in this path, and the reason is not convenience.** The
camera on this board emits black frames; there is nothing behind it to flash. A
source that cannot carry an event cannot carry a timestamp. So frames are fed in
as raw video, and what is measured is *encode -> RTP -> depacketise -> decode* —
which is precisely the part that differs between the two composers, and
precisely the part the spec says is unmeasured. Camera capture and MJPEG decode
sit ahead of this, are identical in both arms, and add the same amount to both.

The transport is the daemon's own: H.264 in RTP over UDP, `pt=96`, the
`rtph264pay config-interval=-1` that `sink()` composes in
`packages/yonder-core/src/video/pipeline.ts`.

Run on the board with the daemon's camera stopped. Configures nothing, leaves
nothing behind but a file under --workdir.
"""
import argparse, os, pathlib, signal, statistics, subprocess, sys, threading, time

WIDTH, HEIGHT, FPS = 1280, 720, 30
FRAME = WIDTH * HEIGHT * 3 // 2          # yuv420p
Y_SIZE = WIDTH * HEIGHT
KBPS = 4000
GOP = 15
PORT = 5600
# Three seconds between flashes. It must exceed the latency being measured, or
# the k-th flash out cannot be matched to the k-th flash in; two seconds was
# the figure that prompted this measurement, so three leaves room and the
# script checks the assumption rather than trusting it.
FLASH_PERIOD = FPS * 3
BLACK, WHITE = 16, 235
# Mean luminance rises past this on a flash frame and sits far below it
# otherwise, so detection needs no tuning between arms.
THRESHOLD = 110
RTP_CAPS = ("application/x-rtp,media=(string)video,clock-rate=(int)90000,"
            "encoding-name=(string)H264,payload=(int)96")

SDP = f"""v=0
o=- 0 0 IN IP4 127.0.0.1
s=yonder-composer-latency
c=IN IP4 127.0.0.1
t=0 0
m=video {PORT} RTP/AVP 96
a=rtpmap:96 H264/90000
"""


def sender(kind: str) -> list[str]:
    """Raw frames on stdin -> H.264 -> RTP/UDP, composed each way.

    The GStreamer arm is `compose()`'s encode and RTP sink verbatim —
    `v4l2h264enc` with `extra-controls`, the `video/x-h264,level=(string)4`
    capsfilter welded on by `encode()`, `h264parse`, then the `rtph264pay
    config-interval=-1 pt=96 ! udpsink sync=false` that `sink()` builds for an
    `rtp` output. Only the source differs, and it differs identically in both
    arms.
    """
    if kind == "gst":
        return [
            "gst-launch-1.0", "-q",
            "fdsrc", "fd=0", "!",
            f"rawvideoparse", f"width={WIDTH}", f"height={HEIGHT}",
            "format=i420", f"framerate={FPS}/1", "!",
            "v4l2h264enc", "name=enc-stream",
            f"extra-controls=controls,video_bitrate={KBPS * 1000},h264_i_frame_period={GOP}",
            "!", "video/x-h264,level=(string)4", "!",
            "h264parse", "!",
            "rtph264pay", "config-interval=-1", "pt=96", "!",
            "udpsink", "host=127.0.0.1", f"port={PORT}", "sync=false",
        ]
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{WIDTH}x{HEIGHT}",
        "-r", str(FPS), "-i", "-",
        "-c:v", "h264_v4l2m2m", "-b:v", f"{KBPS}k", "-g", str(GOP),
        # config-interval=-1's counterpart: repeat SPS/PPS in band with every
        # keyframe, rather than only in the SDP a receiver may never read.
        "-bsf:v", "dump_extra",
        "-f", "rtp", f"rtp://127.0.0.1:{PORT}",
    ]


def receiver(kind: str, sdp: str, low_latency: bool) -> list[str]:
    """RTP/UDP -> H.264 -> raw frames on stdout.

    Both decode in software, so the comparison is between the two frameworks'
    receive paths rather than between a hardware and a software decoder.
    """
    if kind == "gst":
        return [
            "gst-launch-1.0", "-q",
            "udpsrc", f"port={PORT}", f"caps={RTP_CAPS}", "!",
            # The `latency=0` the spec names. GStreamer will not de-jitter at
            # all at this setting, which is the point of quoting it.
            "rtpjitterbuffer", "latency=0" if low_latency else "latency=200", "!",
            "rtph264depay", "!", "h264parse", "!", "avdec_h264", "!",
            "videoconvert", "!", "video/x-raw,format=I420", "!",
            "fdsink", "fd=1", "sync=false",
        ]
    p = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
         "-protocol_whitelist", "file,udp,rtp"]
    if low_latency:
        # ffmpeg's own low-latency switches, so that "ffmpeg is slower" cannot
        # be an artifact of leaving its defaults on when GStreamer's were tuned.
        p += ["-fflags", "nobuffer", "-flags", "low_delay",
              "-probesize", "32", "-analyzeduration", "0",
              "-reorder_queue_size", "0", "-max_delay", "0"]
    p += ["-i", sdp, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]
    return p


def read_exactly(fd: int, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = os.read(fd, n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def measure(send_kind: str, recv_kind: str, flashes: int, workdir: str,
            low_latency: bool, verbose: bool) -> dict:
    sdp_path = os.path.join(workdir, "spike.sdp")
    pathlib.Path(sdp_path).write_text(SDP)

    rx = subprocess.Popen(receiver(recv_kind, sdp_path, low_latency),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(1.5)                       # the receiver must own the port first
    tx = subprocess.Popen(sender(send_kind), stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    black = bytes([BLACK]) * Y_SIZE + bytes([128]) * (FRAME - Y_SIZE)
    white = bytes([WHITE]) * Y_SIZE + bytes([128]) * (FRAME - Y_SIZE)
    sent: list[float] = []
    stop = threading.Event()

    def write_frames() -> None:
        # Two seconds of black before the first flash: the encoder's own
        # start-up transient is not what this is measuring.
        n = 0
        try:
            while not stop.is_set() and len(sent) < flashes + 2:
                is_flash = n >= FPS * 2 and (n - FPS * 2) % FLASH_PERIOD == 0
                if is_flash:
                    sent.append(time.monotonic())
                tx.stdin.write(white if is_flash else black)
                tx.stdin.flush()
                n += 1
                # Pace to the frame clock rather than free-running, so the
                # encoder sees a 30 fps stream and not a burst.
                target = n / FPS
                slip = target - (time.monotonic() - t_zero)
                if slip > 0:
                    time.sleep(slip)
        except (BrokenPipeError, ValueError):
            pass

    t_zero = time.monotonic()
    writer = threading.Thread(target=write_frames, daemon=True)
    writer.start()

    got: list[float] = []
    high = False
    deadline = time.monotonic() + 20 + flashes * (FLASH_PERIOD / FPS)
    try:
        while len(got) < flashes and time.monotonic() < deadline:
            frame = read_exactly(rx.stdout.fileno(), FRAME)
            if frame is None:
                break
            # Subsampled mean of the luma plane. A stride coprime with the row
            # length so the sample is not one column of the picture.
            sample = frame[0:Y_SIZE:997]
            mean = sum(sample) / len(sample)
            if mean > THRESHOLD and not high:
                got.append(time.monotonic())
                high = True
            elif mean <= THRESHOLD:
                high = False
    finally:
        stop.set()
        for p in (tx, rx):
            try:
                p.send_signal(signal.SIGINT)
                p.wait(timeout=5)
            except Exception:                                     # noqa: BLE001
                p.kill()
    tx_err = (tx.stderr.read() or b"").decode()[-300:]
    rx_err = (rx.stderr.read() or b"").decode()[-300:]

    # Drop the first flash: it carries the RTP stream's own start-up, including
    # the receiver's first keyframe wait, which is a joining cost and not a
    # steady-state latency.
    pairs = list(zip(sent, got))[1:]
    lat = [(r - s) * 1000 for s, r in pairs]
    return {
        "sender": send_kind, "receiver": recv_kind, "n": len(lat),
        "sent": len(sent), "got": len(got),
        "median": statistics.median(lat) if lat else float("nan"),
        "min": min(lat) if lat else float("nan"),
        "max": max(lat) if lat else float("nan"),
        "all": lat, "tx_err": tx_err, "rx_err": rx_err,
        "verbose": verbose,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--flashes", type=int, default=6)
    ap.add_argument("--workdir", default="/tmp/yonder-spike")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--defaults-too", action="store_true",
                    help="also measure each receiver with its own defaults, "
                         "which is the case the QGroundControl observation resembles")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)

    arms = [(s, r, True) for s in ("gst", "ff") for r in ("gst", "ff")]
    if args.defaults_too:
        arms += [(s, r, False) for s in ("gst", "ff") for r in ("gst", "ff")]

    print(f"# {WIDTH}x{HEIGHT}@{FPS}, {KBPS} kb/s, GOP {GOP}, RTP/UDP pt=96 on "
          f"127.0.0.1:{PORT}")
    print(f"# flash every {FLASH_PERIOD / FPS:.0f} s; first flash discarded as a "
          f"joining cost\n")
    rows = []
    for s, r, low in arms:
        for i in range(args.repeat):
            res = measure(s, r, args.flashes, args.workdir, low, args.verbose)
            tag = "low-latency" if low else "defaults"
            if res["n"] == 0:
                # A run that detected no flash is not a latency of zero and is
                # not reported as one.
                print(f"{s:>3} -> {r:<3} ({tag:11}) run {i+1}: "
                      f"** NO FLASH DETECTED — not a measurement ** "
                      f"(sent {res['sent']}, got {res['got']})")
                if res["tx_err"]:
                    print(f"    tx: {res['tx_err'].strip()}")
                if res["rx_err"]:
                    print(f"    rx: {res['rx_err'].strip()}")
                continue
            print(f"{s:>3} -> {r:<3} ({tag:11}) run {i+1}: "
                  f"median {res['median']:7.1f} ms   "
                  f"min {res['min']:7.1f}   max {res['max']:7.1f}   "
                  f"n={res['n']}")
            if args.verbose:
                print("    " + "  ".join(f"{x:.0f}" for x in res["all"]))
            rows.append((s, r, tag, res))
            time.sleep(2)

    if rows:
        print("\n| sender | receiver | receiver config | median | min | max | n |")
        print("|---|---|---|---|---|---|---|")
        for s, r, tag, res in rows:
            print(f"| {s} | {r} | {tag} | {res['median']:.0f} ms | "
                  f"{res['min']:.0f} ms | {res['max']:.0f} ms | {res['n']} |")
    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
