#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Pi re-proof: 300 frames through both composers, on a Pi with a camera.

The Rockchip design (§2) proposes replacing the GStreamer composer with ffmpeg
on every board, and names the cost plainly: it changes the Pi path that M4
proved and that currently works. That path "must be re-proven on Pi hardware
before this ships — the same 300-frame two-branch measurement". This is that
measurement.

**Both command lines are derived from `compose()` in
`packages/yonder-core/src/video/pipeline.ts`, not written from a description of
it.** The GStreamer arms reproduce `compose()` element for element through
`h264parse`; the ffmpeg arms are the nearest faithful translation, and every
place they cannot be faithful is named in `DIFFERENCES` below and reproduced in
the hardware note. An ffmpeg line that is not doing what the GStreamer one does
is not a comparison, it is two unrelated numbers.

The sinks are the one deliberate departure in *both* arms: `compose()` ends each
branch in `rtspclientsink`/`udpsink`, and these end in a discard. Publishing
would put mediamtx, the network stack and a media server's own buffering inside
a number that is supposed to be the composer's. Latency through the real
transport is the other script's subject.

Run on the board with the daemon's camera stopped:

    POST /cameras/cam0/run {"action":"stop"}  over /run/yonder/core.sock

Configures nothing and leaves nothing behind but files under --workdir.
"""
import argparse, os, pathlib, re, shutil, subprocess, sys, time

# ---------------------------------------------------------------- the source

DEV_DEFAULT = "/dev/video0"
WIDTH, HEIGHT, FPS = 1280, 720, 30
FRAMES = 300
# The full-rate and preview bitrates, in kb/s. Any pair would do; these are the
# order of magnitude `config.yaml` holds on this board.
STREAM_KBPS, PREVIEW_KBPS = 2000, 800
# `compose()` reads the preview rung from configuration. The board's own config
# currently holds 1280x720 — the same size as the full rate — which would put a
# converter in the graph that scales nothing and measure a downscale that never
# happens. 640x360 is the rung the Radxa measurement used, so the two-branch
# shape here is the two-branch shape there.
PREVIEW_W, PREVIEW_H = 640, 360

# `QUEUE` in pipeline.ts, verbatim.
QUEUE = "queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0"
# `H264_LEVEL` in pipeline.ts, verbatim.
H264_LEVEL = "video/x-h264,level=(string)4"


# The preview scaler the GStreamer arms use. `compose()` names `v4l2convert`,
# the board's ISP hardware. It cannot be reconfigured on a running pipeline —
# `reconfigure-resolution.py` shows it failing `S_FMT` and taking the pipeline
# down — so an adaptive controller that moves resolution has to use software
# `videoscale` instead. This option exists to price that trade.
PREVIEW_SCALER = "v4l2convert"


def gst(dev: str, two_branch: bool, out1: str, out2: str) -> list[str]:
    """`compose()`'s graph, with the sinks replaced by a discard-to-file.

    Element for element against `compose()`:
      v4l2src device=… io-mode=4 ! image/jpeg,W,H,F ! jpegdec ! tee name=raw
      raw. ! QUEUE ! v4l2h264enc name=enc-stream extra-controls=… ! LEVEL
           ! h264parse ! (sink)
      raw. ! QUEUE ! v4l2convert ! capsfilter name=preview-scale
           ! videorate ! capsfilter name=preview-rate
           ! v4l2h264enc name=enc-preview extra-controls=…,h264_i_frame_period=15
           ! LEVEL ! h264parse ! (sink)
    """
    p = [
        "gst-launch-1.0", "-q",
        "v4l2src", f"device={dev}", "io-mode=4", f"num-buffers={FRAMES}", "!",
        f"image/jpeg,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
        "jpegdec", "!", "tee", "name=raw",
        "raw.", "!", *QUEUE.split(), "!",
        "v4l2h264enc", "name=enc-stream",
        f"extra-controls=controls,video_bitrate={STREAM_KBPS * 1000}", "!", H264_LEVEL, "!",
        "h264parse", "!", "filesink", f"location={out1}",
    ]
    if two_branch:
        p += [
            "raw.", "!", *QUEUE.split(), "!",
            *PREVIEW_SCALER.split(), "!",
            "capsfilter", "name=preview-scale",
            f"caps=video/x-raw,width={PREVIEW_W},height={PREVIEW_H}", "!",
            "videorate", "!",
            "capsfilter", "name=preview-rate", f"caps=video/x-raw,framerate={FPS}/1", "!",
            "v4l2h264enc", "name=enc-preview",
            f"extra-controls=controls,video_bitrate={PREVIEW_KBPS * 1000},h264_i_frame_period=15",
            "!", H264_LEVEL, "!",
            "h264parse", "!", "filesink", f"location={out2}",
        ]
    return p


def ff(dev: str, two_branch: bool, out1: str, out2: str) -> list[str]:
    """The same graph as `gst()` above, composed with ffmpeg.

    `-pix_fmt yuv420p` is not decoration and not a style choice: see
    DIFFERENCES[1]. Without it this command does not run at all.
    """
    p = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "v4l2", "-input_format", "mjpeg",
        "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate", str(FPS), "-i", dev,
    ]
    if two_branch:
        p += [
            "-filter_complex",
            f"[0:v]format=yuv420p,split=2[full][pv];"
            f"[pv]scale={PREVIEW_W}:{PREVIEW_H},fps={FPS}[pvs]",
            "-map", "[full]", "-c:v", "h264_v4l2m2m", "-b:v", f"{STREAM_KBPS}k",
            "-frames:v", str(FRAMES), "-f", "h264", out1,
            # h264_i_frame_period=15 on the GStreamer side; -g 15 here.
            "-map", "[pvs]", "-c:v", "h264_v4l2m2m", "-b:v", f"{PREVIEW_KBPS}k", "-g", "15",
            "-frames:v", str(FRAMES), "-f", "h264", out2,
        ]
    else:
        p += [
            "-pix_fmt", "yuv420p", "-c:v", "h264_v4l2m2m", "-b:v", f"{STREAM_KBPS}k",
            "-frames:v", str(FRAMES), "-f", "h264", out1,
        ]
    return p


# Every place the ffmpeg line cannot do what the GStreamer one does. Printed by
# --differences and quoted in the hardware note, so a reader comparing the two
# numbers is told what is not being held constant before they read them.
DIFFERENCES = [
    ("io-mode=4",
     "`compose()` asks v4l2src for DMABUF import. ffmpeg's v4l2 demuxer has no "
     "equivalent switch and uses mmap. Both are zero-copy from the kernel's "
     "capture buffers on this board; neither reaches the encoder as a dmabuf."),
    ("pixel format",
     "ffmpeg's mjpeg decoder emits yuvj420p and h264_v4l2m2m accepts only "
     "yuv420p — 'Encoder requires yuv420p pixel format', and the command does "
     "not start. `-pix_fmt yuv420p` inserts a swscale full-to-limited range "
     "pass over every frame. GStreamer's jpegdec hands I420 to v4l2h264enc with "
     "no conversion at all, so this pass exists only in the ffmpeg arm and its "
     "cost is inside the ffmpeg numbers."),
    ("the leaky queue",
     "`QUEUE` bounds every branch at 200 ms and drops downstream when it fills, "
     "so a stalled consumer cannot back-pressure the shared encoder. ffmpeg's "
     "filter graph has no per-branch leaky queue; it blocks. Nothing here "
     "measures that difference — both arms discard as fast as they are fed — "
     "but it is the property `QUEUE`'s comment says the pipeline depends on, "
     "and an ffmpeg composer owes it an answer."),
    ("the level capsfilter",
     "`v4l2h264enc` fixates level 1 without `video/x-h264,level=(string)4` and "
     "dies on the first frame. h264_v4l2m2m sets the level itself and needs no "
     "such filter; it is absent from the ffmpeg line because adding it would be "
     "the ritual pipeline.ts's own comment warns against."),
    ("the preview scaler",
     "`compose()` scales the preview with `v4l2convert`, the board's ISP "
     "hardware M2M converter at /dev/video12. ffmpeg has no element for it: "
     "`scale` is software. This is the one difference that is not incidental — "
     "on Rockchip the design's answer is `scale_rkrga`, and on a Pi the ffmpeg "
     "composer has no hardware scaler to name."),
    ("the sink",
     "Both arms end in a file rather than `rtspclientsink`/`udpsink`, in both "
     "composers equally, so that a media server's buffering is not inside a "
     "number about the composer."),
]


# ------------------------------------------------------------- measurement

def cpu_snapshot() -> tuple[int, int]:
    """(busy, total) jiffies across all cores, from /proc/stat.

    Load average is not used here and the Radxa note says why: MPP's encoder
    threads wait on hardware in a state Linux counts toward load without
    consuming CPU, so a load figure can read sevenfold oversubscription while
    five sixths of the board is idle. Busy jiffies cannot do that.
    """
    fields = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    idle = fields[3] + fields[4]  # idle + iowait
    return sum(fields) - idle, sum(fields)


def temps() -> str:
    def vc(arg: str) -> str:
        try:
            return subprocess.run(["vcgencmd", arg], capture_output=True, text=True,
                                  timeout=10).stdout.strip()
        except Exception:
            return "?"
    return f"{vc('measure_temp')} {vc('get_throttled')}"


def camguard(script: str) -> str:
    r = subprocess.run([script, "ensure"], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"camera will not stream: {r.stderr.strip()}")
    return (r.stdout + r.stderr).strip().splitlines()[-1]


def run_arm(name: str, argv: list[str], outs: list[str], guard: str) -> dict:
    for f in outs:
        pathlib.Path(f).unlink(missing_ok=True)
    guard_line = camguard(guard)
    before_t = temps()
    b_busy, b_total = cpu_snapshot()
    t0 = time.monotonic()
    r = subprocess.run(argv, capture_output=True, text=True, timeout=300)
    elapsed = time.monotonic() - t0
    a_busy, a_total = cpu_snapshot()
    after_t = temps()
    sizes = [pathlib.Path(f).stat().st_size if pathlib.Path(f).exists() else 0 for f in outs]
    cpu = 100.0 * (a_busy - b_busy) / (a_total - b_total) if a_total > b_total else float("nan")
    return {
        "arm": name, "elapsed": elapsed, "fps": FRAMES / elapsed if elapsed else 0.0,
        "cpu": cpu, "sizes": sizes, "rc": r.returncode,
        "stderr": (r.stderr or "").strip()[-400:],
        "guard": guard_line, "before": before_t, "after": after_t,
    }


def main() -> int:
    global PREVIEW_SCALER, WIDTH, HEIGHT                          # noqa: PLW0603
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default=DEV_DEFAULT)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--workdir", default="/tmp/yonder-spike")
    ap.add_argument("--camguard", default=str(pathlib.Path(__file__).with_name("camguard.sh")))
    # Running only the arms a question needs keeps the board out of thermal
    # throttling, which at 1920x1080 it enters under the ffmpeg arms and which
    # makes every number after it a measurement of the heatsink.
    ap.add_argument("--arms", default="all",
                    help="comma-separated substrings of arm names to run, e.g. 'gst  2'")
    ap.add_argument("--capture", default=f"{WIDTH}x{HEIGHT}",
                    help="capture size, e.g. 1920x1080 — the case where a software "
                         "scaler has the most pixels to move")
    ap.add_argument("--preview-scaler", default="v4l2convert",
                    help="v4l2convert (hardware, cannot be reconfigured live) or "
                         "videoscale (software, can)")
    ap.add_argument("--differences", action="store_true",
                    help="print how the ffmpeg line differs from the GStreamer one, and exit")
    args = ap.parse_args()
    PREVIEW_SCALER = args.preview_scaler
    WIDTH, HEIGHT = (int(x) for x in args.capture.split("x"))

    if args.differences:
        for title, body in DIFFERENCES:
            print(f"* {title}\n    {body}\n")
        return 0

    if not os.path.exists(args.camguard):
        print(f"camguard not found at {args.camguard}", file=sys.stderr)
        return 2
    os.makedirs(args.workdir, exist_ok=True)
    o1 = os.path.join(args.workdir, "full.h264")
    o2 = os.path.join(args.workdir, "preview.h264")

    arms = [
        ("gst  1-branch", lambda: gst(args.device, False, o1, o2), [o1]),
        ("gst  2-branch", lambda: gst(args.device, True, o1, o2), [o1, o2]),
        ("ff   1-branch", lambda: ff(args.device, False, o1, o2), [o1]),
        ("ff   2-branch", lambda: ff(args.device, True, o1, o2), [o1, o2]),
    ]

    if args.arms != "all":
        wanted = [a.strip() for a in args.arms.split(",")]
        arms = [a for a in arms if any(w in a[0] for w in wanted)]
        if not arms:
            print("no arm matched --arms", file=sys.stderr)
            return 2

    b_busy, b_total = cpu_snapshot()
    time.sleep(5)
    a_busy, a_total = cpu_snapshot()
    idle_cpu = 100.0 * (a_busy - b_busy) / (a_total - b_total)
    print(f"# board baseline over 5 s with no pipeline: {idle_cpu:.1f}% busy   {temps()}")
    print(f"# {FRAMES} frames, {WIDTH}x{HEIGHT}@{FPS}, preview {PREVIEW_W}x{PREVIEW_H}, "
          f"{STREAM_KBPS}/{PREVIEW_KBPS} kb/s\n")

    results, failures = [], 0
    for name, build, outs in arms:
        for i in range(args.repeat):
            try:
                r = run_arm(name, build(), outs, args.camguard)
            except Exception as e:                       # noqa: BLE001
                print(f"{name} run {i + 1}: FAILED — {e}")
                failures += 1
                continue
            # **A zero is never a measurement here.** The previous video spike
            # spent two of its three rounds explaining 0.00 Mb/s readings that
            # were a pipeline never emitting a frame. A run that produced no
            # bytes is reported as a failure, not as a number.
            ok = r["rc"] == 0 and all(s > 0 for s in r["sizes"])
            mark = "" if ok else "   ** NO OUTPUT — not a measurement **"
            if not ok:
                failures += 1
            print(f"{name} run {i + 1}: {r['elapsed']:6.2f} s  "
                  f"{r['fps']:5.1f} fps  cpu {r['cpu']:5.1f}%  "
                  f"bytes {'+'.join(str(s) for s in r['sizes'])}  "
                  f"rc={r['rc']}  [{r['before']} -> {r['after']}]{mark}")
            if not ok and r["stderr"]:
                print(f"    stderr: {r['stderr']}")
            if ok:
                results.append(r)
            time.sleep(4)

    print("\n| pipeline | 300 frames | effective | cpu (4 cores) |")
    print("|---|---|---|---|")
    for name, _, _ in arms:
        rs = [r for r in results if r["arm"] == name]
        if not rs:
            print(f"| `{name.strip()}` | — | — | no successful run |")
            continue
        el = sum(r["elapsed"] for r in rs) / len(rs)
        print(f"| `{name.strip()}` | {el:.2f} s | ~{FRAMES / el:.0f} fps | "
              f"{sum(r['cpu'] for r in rs) / len(rs):.0f}% |")
    print(f"\n# baseline {idle_cpu:.1f}% · {len(results)} good runs, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
