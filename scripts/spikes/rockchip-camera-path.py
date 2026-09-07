#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Rockchip camera path, end to end, with a real camera.

Everything this project has measured on Rockchip so far came from
`videotestsrc`. That settled what the encoders can do and left the actual chain
untested: MJPEG off a USB camera, decoded, encoded, in the two-branch shape
`compose()` builds. Spec §5 rests on that chain — *"on a board with a hardware
decoder for the source format, the composer decodes in hardware too, so frames
never leave the SoC between capture and encode"* — and §5 is the reason the
preview branch is claimed to work at all on this SoC.

So this asks four questions of the real camera:

  1. Does hardware MJPEG decode (`mppjpegdec`) beat software (`jpegdec`) here,
     and by how much? §5 asserts it must; nothing had measured it.
  2. Does the two-branch shape hold 30 fps, and what does it cost?
  3. **Can the preview branch be scaled with no scaler element at all**, by
     giving the second encoder `width`/`height` and letting RGA do it inside?
     That is the Rockchip answer to a Pi's `v4l2convert`, and it removes the
     software scaler the earlier runs had to use.
  4. Does a live bitrate retune still work with a camera in front of it, rather
     than a test pattern?

**Runs as root.** `/dev/mpp_service` is 0600 root:root; an unprivileged process
fails with an error naming bit rate and frame size rather than the permission
actually missing.

Stop the daemon's camera first if it holds the device. Configures nothing and
leaves nothing behind but files under --workdir.
"""
import argparse, os, pathlib, subprocess, sys, time

WIDTH, HEIGHT, FPS = 1280, 720, 30
FRAMES = 300
STREAM_KBPS, PREVIEW_KBPS = 2000, 800
PREVIEW_W, PREVIEW_H = 640, 360
QUEUE = ("queue leaky=downstream max-size-time=200000000 "
         "max-size-buffers=0 max-size-bytes=0")


def source(dev: str) -> str:
    # `compose()`'s capture, verbatim apart from the device path: v4l2src with
    # io-mode=4, the jpeg capsfilter, then the decode.
    return (f"v4l2src device={dev} io-mode=4 num-buffers={FRAMES} "
            f"! image/jpeg,width={WIDTH},height={HEIGHT},framerate={FPS}/1 ")


def arms(dev: str, out1: str, out2: str) -> list[tuple[str, str, list[str]]]:
    enc = f"mpph264enc name=enc-stream bps={STREAM_KBPS * 1000}"
    prev_rga = (f"mpph264enc name=enc-preview bps={PREVIEW_KBPS * 1000} "
                f"width={PREVIEW_W} height={PREVIEW_H}")
    prev_sw = (f"videoconvert ! videoscale "
               f"! video/x-raw,width={PREVIEW_W},height={PREVIEW_H} "
               f"! mpph264enc name=enc-preview bps={PREVIEW_KBPS * 1000}")
    return [
        ("hw decode, 1 branch",
         source(dev) + f"! mppjpegdec ! {enc} ! h264parse ! filesink location={out1}",
         [out1]),
        ("sw decode, 1 branch",
         source(dev) + f"! jpegdec ! {enc} ! h264parse ! filesink location={out1}",
         [out1]),
        ("hw decode, 2 branch, RGA preview",
         source(dev) + f"! mppjpegdec ! tee name=raw "
         f"raw. ! {QUEUE} ! {enc} ! h264parse ! filesink location={out1} "
         f"raw. ! {QUEUE} ! {prev_rga} ! h264parse ! filesink location={out2}",
         [out1, out2]),
        ("hw decode, 2 branch, software preview",
         source(dev) + f"! mppjpegdec ! tee name=raw "
         f"raw. ! {QUEUE} ! {enc} ! h264parse ! filesink location={out1} "
         f"raw. ! {QUEUE} ! {prev_sw} ! h264parse ! filesink location={out2}",
         [out1, out2]),
        ("sw decode, 2 branch, RGA preview",
         source(dev) + f"! jpegdec ! tee name=raw "
         f"raw. ! {QUEUE} ! {enc} ! h264parse ! filesink location={out1} "
         f"raw. ! {QUEUE} ! {prev_rga} ! h264parse ! filesink location={out2}",
         [out1, out2]),
    ]


def cpu_snapshot() -> tuple[int, int]:
    f = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    return sum(f) - (f[3] + f[4]), sum(f)


def sizes_of(ffprobe: str, path: str) -> str:
    try:
        r = subprocess.run(
            [ffprobe, "-hide_banner", "-v", "error", "-select_streams", "v",
             "-count_frames", "-show_entries", "stream=width,height,nb_read_frames",
             "-of", "csv=p=0", path], capture_output=True, text=True, timeout=180)
        return r.stdout.strip().replace("\n", " ") or "unreadable"
    except Exception as e:                                        # noqa: BLE001
        return f"probe failed: {e}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default="/dev/video0")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--workdir", default="/tmp/yonder-spike")
    ap.add_argument("--ffprobe", default="/usr/lib/jellyfin-ffmpeg/ffprobe")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    o1 = os.path.join(args.workdir, "cam-full.h264")
    o2 = os.path.join(args.workdir, "cam-preview.h264")

    b, t = cpu_snapshot()
    time.sleep(5)
    a, t2 = cpu_snapshot()
    idle = 100.0 * (a - b) / (t2 - t)
    print(f"# {FRAMES} frames, {WIDTH}x{HEIGHT} MJPEG @{FPS}, preview "
          f"{PREVIEW_W}x{PREVIEW_H}, {STREAM_KBPS}/{PREVIEW_KBPS} kb/s")
    print(f"# board idle over 5 s: {idle:.1f}% busy\n")

    results: dict[str, list[dict]] = {}
    failures = 0
    for name, desc, outs in arms(args.device, o1, o2):
        for i in range(args.repeat):
            for f in outs:
                pathlib.Path(f).unlink(missing_ok=True)
            b, t = cpu_snapshot()
            t0 = time.monotonic()
            r = subprocess.run(["gst-launch-1.0", "-q"] + desc.split(),
                               capture_output=True, text=True, timeout=300)
            el = time.monotonic() - t0
            a, t2 = cpu_snapshot()
            cpu = 100.0 * (a - b) / (t2 - t) if t2 > t else float("nan")
            sz = [pathlib.Path(f).stat().st_size if pathlib.Path(f).exists() else 0
                  for f in outs]
            # A zero is a pipeline that never emitted a frame, and is not a
            # measurement. The camera is real here and can drop out.
            ok = r.returncode == 0 and all(x > 0 for x in sz)
            mark = "" if ok else "   ** NO OUTPUT — not a measurement **"
            print(f"{name:38} run {i + 1}: {el:6.2f} s  {FRAMES / el:5.1f} fps  "
                  f"cpu {cpu:5.1f}%  bytes {'+'.join(str(x) for x in sz)}{mark}")
            if not ok:
                failures += 1
                err = (r.stderr or "").strip().splitlines()
                for line in [l for l in err if not l.startswith("mpp[")][-3:]:
                    print(f"    {line}")
            else:
                results.setdefault(name, []).append({"el": el, "cpu": cpu, "sz": sz})
            time.sleep(3)
        # Verify the last good output of each arm really is video.
        if name in results:
            print(f"    full:    {sizes_of(args.ffprobe, o1)}")
            if len(outs) > 1:
                print(f"    preview: {sizes_of(args.ffprobe, o2)}")

    print(f"\n| pipeline | {FRAMES} frames | effective | cpu (4 cores) | above idle |")
    print("|---|---|---|---|---|")
    for name, _, _ in arms(args.device, o1, o2):
        rs = results.get(name, [])
        if not rs:
            print(f"| {name} | — | — | — | no successful run |")
            continue
        el = sorted(r["el"] for r in rs)[len(rs) // 2]
        cpu = sum(r["cpu"] for r in rs) / len(rs)
        print(f"| {name} | {el:.2f} s | ~{FRAMES / el:.0f} fps | {cpu:.0f}% | "
              f"+{cpu - idle:.0f} |")
    print(f"\n# idle {idle:.1f}% · {sum(len(v) for v in results.values())} good runs, "
          f"{failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
