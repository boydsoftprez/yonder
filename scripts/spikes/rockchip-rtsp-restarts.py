#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Check both RTSP outputs across repeated starts of the actual pipeline host.

R-VID-13, R-VID-20, R-CTL-01. Run with exclusive access to the camera and an
already running media server. This script changes no configuration. Pass the
JSON argv emitted by compose(), replacing its gst-launch executable with the
installed yonder-pipeline host, or a JSON array captured from that host's
/proc/<pid>/cmdline. The graph is used verbatim: this bench has no second copy
of the composer and never adds the fix it is meant to verify.

Example (the camera is stopped before running this):
  python3 scripts/spikes/rockchip-rtsp-restarts.py \
    --argv-json /tmp/camera-argv.json --workdir /tmp/rtsp-restarts \
    --ffprobe /usr/lib/jellyfin-ffmpeg/ffprobe --min-fps 28 14

FFprobe reads the outputs concurrently. Packet timestamps measure delivery;
this is not a decoded-image quality or CPU benchmark. SIGTERM models the
supervisor's Stop; a process requiring SIGKILL fails the cycle. Logs and a
JSON report remain in the private workdir, without dumping the launch argv.
The default 15-second warmup outlasts MediaMTX's observed 10-second expiry
of a UDP publisher left by SIGTERM before sampling the replacement's packets.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import subprocess
import time
from urllib.parse import urlsplit


def locations(argv):
    result = []
    for at, token in enumerate(argv):
        if token != "rtspclientsink":
            continue
        for prop in argv[at + 1:]:
            if prop == "!":
                break
            if prop.startswith("location="):
                result.append(prop.removeprefix("location="))
                break
    return result


def read_stream(ffprobe, url, seconds, timeout, minimum):
    result = {"path": urlsplit(url).path}
    try:
        probe = subprocess.run([
            ffprobe, "-v", "error", "-rtsp_transport", "tcp",
            "-analyzeduration", "1000000", "-probesize", "65536",
            "-read_intervals", f"%+{seconds}",
            "-show_entries", "stream=codec_name,width,height:packet=pts_time,size",
            "-of", "json", url,
        ], capture_output=True, text=True, timeout=timeout)
        # Even exit zero can report unusable caps or no packets. Keep the
        # reader's diagnostic beside that result; publisher URLs were checked
        # for credentials before any process was started.
        result["stderr"] = probe.stderr
        if probe.returncode:
            return {**result, "ok": False, "error": "ffprobe failed", "exit": probe.returncode}
        data = json.loads(probe.stdout)
        packets = data.get("packets", [])
        pts = [float(p["pts_time"]) for p in packets if "pts_time" in p]
        span = max(pts) - min(pts) if len(pts) > 1 else 0
        fps = (len(pts) - 1) / span if span > 0 else 0
        byte_count = sum(int(p.get("size", 0)) for p in packets)
        streams = data.get("streams", [])
        shape_ok = bool(streams) and all(
            s.get("codec_name") in ("h264", "hevc")
            and s.get("width", 0) > 0 and s.get("height", 0) > 0
            for s in streams)
        ok = shape_ok and byte_count > 0 and span >= seconds * 0.8
        if minimum is not None:
            ok = ok and fps >= minimum
        return {**result, "ok": ok, "packets": len(packets), "bytes": byte_count,
                "span_seconds": round(span, 3), "observed_fps": round(fps, 3),
                "minimum_fps": minimum, "streams": streams}
    except subprocess.TimeoutExpired:
        return {**result, "ok": False, "error": "reader timed out", "timeout_seconds": timeout}
    except (OSError, ValueError, TypeError, KeyError) as error:
        return {**result, "ok": False, "error": type(error).__name__}


def run_cycle(argv, urls, args, number):
    result = {"cycle": number, "ok": False}
    process = None
    with (args.workdir / f"cycle-{number}.log").open("w") as log:
        try:
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=log, stderr=log)
            time.sleep(args.warmup)
            if process.poll() is not None:
                result["error"] = "host exited before readers started"
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=len(urls)) as pool:
                    jobs = [pool.submit(read_stream, args.ffprobe, url, args.seconds,
                                        args.timeout, args.min_fps[i] if args.min_fps else None)
                            for i, url in enumerate(urls)]
                    result["outputs"] = [job.result() for job in jobs]
                result["ok"] = process.poll() is None and all(o["ok"] for o in result["outputs"])
                if process.poll() is not None:
                    result["error"] = "host exited while readers were running"
        except OSError as error:
            result["error"] = type(error).__name__
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=args.stop_timeout)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                        result["ok"] = False
                        result["error"] = "host required SIGKILL after Stop"
                result["exit"] = process.returncode
                process.stdin.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--argv-json", type=pathlib.Path, required=True)
    parser.add_argument("--workdir", type=pathlib.Path, required=True)
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--warmup", type=float, default=15)
    parser.add_argument("--settle", type=float, default=3)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--stop-timeout", type=float, default=5)
    parser.add_argument("--min-fps", type=float, nargs="+", help="minimum measured fps, in RTSP output order")
    args = parser.parse_args()
    if args.cycles < 1 or args.seconds <= 0 or args.timeout <= args.seconds or args.stop_timeout <= 0:
        parser.error("cycles and durations must be positive; reader timeout must exceed its sample duration")
    if args.warmup < 0 or args.settle < 0 or (args.min_fps and any(fps <= 0 for fps in args.min_fps)):
        parser.error("warmup/settle must be nonnegative and minimum frame rates positive")
    try:
        argv = json.loads(args.argv_json.read_text())
    except (OSError, ValueError):
        parser.error("argv-json must be a readable JSON array")
    if not isinstance(argv, list) or not argv or not all(isinstance(t, str) and t for t in argv):
        parser.error("argv-json must be a nonempty array of argument strings")
    urls = locations(argv)
    if len(urls) != 2:
        parser.error("the actual pipeline must carry both main and preview RTSP outputs")
    if any(urlsplit(url).scheme not in ("rtsp", "rtsps") or urlsplit(url).username is not None
           or urlsplit(url).query or urlsplit(url).fragment for url in urls):
        parser.error("use the host's local publisher URLs without credentials, queries or fragments")
    if args.min_fps and len(args.min_fps) != len(urls):
        parser.error("provide one minimum frame rate per RTSP output")
    os.umask(0o077)
    args.workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
    results = []
    for number in range(1, args.cycles + 1):
        result = run_cycle(argv, urls, args, number)
        results.append(result)
        (args.workdir / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(result), flush=True)
        if number < args.cycles:
            time.sleep(args.settle)
    return 0 if all(result["ok"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
