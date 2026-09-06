#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Can the `ffmpeg` CLI change a bitrate on a running `h264_v4l2m2m` encode?

K-53 records what the project got wrong the first time, and the shape of the
error matters more than the answer. Task 1 proved `v4l2h264enc` takes a runtime
bitrate change — by holding the pipeline object and setting a property on the
live element. The daemon does not do that: it runs `gst-launch-1.0`, which
answers nothing once playing. **The spike proved the encoder and not the
runner**, and the half-answer rode through five tasks.

So this asks the runner's half for ffmpeg, and asks it of every channel the CLI
actually offers rather than of the one that seemed most likely:

  none            no change at all — what measurement noise looks like, so that
                  "nothing moved" can be told from "nothing was measured"
  stdin-c         ffmpeg's interactive `c` command, addressed to the encoder
  stdin-C         the same, broadcast to every target that will take it
  zmq-encoder     the `zmq` filter, addressed to the encoder
  zmq-filter      the `zmq` filter, addressed to a *filter* — the positive
                  control, which proves the socket and the command syntax are
                  right before the encoder's silence is read as an answer
  v4l2-external   `v4l2-ctl --set-ctrl video_bitrate` on the encoder's own V4L2
                  node from a second process, which is how an outside program
                  would have to reach it

Rate control on this board's encoder tracks its target regardless of picture
content — a black frame at 2 Mb/s still costs 2 Mb/s — so output bitrate is a
direct readout of the encoder's *target*, and any change in it means the target
moved. That is what makes this measurable at all.

Run on the board with the daemon's camera stopped. Configures nothing and
leaves nothing behind.
"""
import argparse, functools, os, subprocess, sys, threading, time

print = functools.partial(print, flush=True)  # noqa: A001

WIDTH, HEIGHT, FPS = 1280, 720, 30
FROM_KBPS, TO_KBPS = 1000, 4000
ENC_NAME = "enc-stream"          # the name `compose()` gives the full-rate encode
ZMQ_ADDR = "tcp://127.0.0.1:5555"
# Overridden by --ffmpeg / --encoder so the same question can be put to a
# Rockchip board's `h264_rkmpp` under jellyfin-ffmpeg, which is where the
# Rockchip design proposes the hardware encoder comes from.
FFMPEG = "ffmpeg"
ENCODER = "h264_v4l2m2m"


def build(channel: str, kbps: int) -> list[str]:
    """One ffmpeg, encoding a moving synthetic source through the hardware encoder.

    The source is `testsrc2` rather than the camera deliberately: the camera on
    this board emits black frames, and a source with no detail cannot show a
    rate controller doing anything. The question here is about the *runner*,
    not about capture, and capture is identical whichever answer comes back.
    """
    src = f"testsrc2=size={WIDTH}x{HEIGHT}:rate={FPS}"
    # `zmq` and `eq` are only inserted for the channels that need them: an
    # unused filter in the graph is CPU spent for nothing, and `eq` exists here
    # solely as something a filter command can legitimately land on.
    # `zmq` is used with no argument on purpose. Its `bind_address` value
    # contains colons, which separate options inside a filter description, and
    # getting them through ffmpeg's two levels of unescaping is the trap that
    # cost the spec's own clock measurement two attempts. The filter's default
    # is tcp://*:5555, which is what ZMQ_ADDR connects to, so there is nothing
    # to escape and nothing to get wrong.
    vf = "zmq,eq" if channel.startswith("zmq") else None
    # `-re` is load-bearing. Without it lavfi feeds the hardware encoder as
    # fast as it will go, video time runs ahead of wall time, and bytes counted
    # per wall-clock second read several times the configured rate — a number
    # that looks like a broken rate controller and is really a broken
    # measurement. Read at native frame rate and the two clocks agree.
    p = [FFMPEG, "-hide_banner", "-loglevel", "info", "-nostats", "-y",
         "-re", "-f", "lavfi", "-i", src]
    if vf:
        p += ["-vf", vf]
    p += ["-c:v", ENCODER, "-b:v", f"{kbps}k", "-g", "15",
          "-f", "h264", "pipe:1"]
    return p


def send_zmq(target: str, command: str, arg: str) -> str:
    import zmq                                    # noqa: PLC0415
    ctx = zmq.Context()
    s = ctx.socket(zmq.REQ)
    s.setsockopt(zmq.RCVTIMEO, 4000)
    s.setsockopt(zmq.SNDTIMEO, 4000)
    # Without LINGER=0 the close below waits for ever for a reply that a
    # wrong target never sends — the failing case this script exists to
    # measure would hang the measurement instead of reporting itself.
    s.setsockopt(zmq.LINGER, 0)
    s.connect(ZMQ_ADDR)
    s.send_string(f"{target} {command} {arg}")
    try:
        reply = s.recv_string()
    except Exception as e:                                        # noqa: BLE001
        reply = f"<no reply: {e}>"
    s.close(); ctx.term()
    return reply


def run(channel: str, window: float, workdir: str) -> dict:
    proc = subprocess.Popen(build(channel, FROM_KBPS),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    counter = [0]
    stop = threading.Event()

    def drain() -> None:
        while not stop.is_set():
            chunk = proc.stdout.read(65536)
            if not chunk:
                return
            counter[0] += len(chunk)

    err_lines: list[str] = []

    def drain_err() -> None:
        for line in proc.stderr:
            err_lines.append(line.decode(errors="replace").rstrip())

    threading.Thread(target=drain, daemon=True).start()
    threading.Thread(target=drain_err, daemon=True).start()

    time.sleep(4)                                     # let rate control settle
    counter[0] = 0
    time.sleep(window)
    before = counter[0] * 8 / window / 1e6

    note = ""
    try:
        if channel == "none":
            note = "no command sent"
        elif channel == "stdin-c":
            # ffmpeg prints the syntax it wants when it cannot parse one:
            #   Enter command: <target>|all <time>|-1 <command>[ <argument>]
            # -1 is "apply now". The time field is easy to leave out, and
            # leaving it out yields a parse error that reads like a refusal
            # from the encoder rather than a mistake in the request.
            proc.stdin.write(f"c{ENC_NAME} -1 b {TO_KBPS * 1000}\n".encode())
            proc.stdin.flush()
            note = f"c {ENC_NAME} -1 b {TO_KBPS * 1000}"
        elif channel == "stdin-C":
            proc.stdin.write(f"Call -1 b {TO_KBPS * 1000}\n".encode())
            proc.stdin.flush()
            note = f"C all -1 b {TO_KBPS * 1000}"
        elif channel == "zmq-encoder":
            note = "zmq -> " + ENC_NAME + " : " + send_zmq(ENC_NAME, "b", str(TO_KBPS * 1000))
        elif channel == "zmq-filter":
            # The positive control. `eq` is a filter, it is in the graph, and it
            # takes a `contrast` command. If this does not answer OK, the socket
            # is wrong and nothing else in this table means anything.
            note = "zmq -> eq : " + send_zmq("Parsed_eq_1", "contrast", "1.5")
        elif channel == "v4l2-external" and ENCODER != "h264_v4l2m2m":
            note = "skipped: not a V4L2 M2M encoder, so it has no V4L2 node to set"
        elif channel == "v4l2-external":
            r = subprocess.run(
                ["v4l2-ctl", "-d", "/dev/video11",
                 f"--set-ctrl=video_bitrate={TO_KBPS * 1000}"],
                capture_output=True, text=True, timeout=15)
            note = (f"v4l2-ctl rc={r.returncode} "
                    f"{(r.stdout + r.stderr).strip() or 'no output'}")
    except Exception as e:                                        # noqa: BLE001
        note = f"send failed: {e}"

    time.sleep(1)
    counter[0] = 0
    time.sleep(window)
    after = counter[0] * 8 / window / 1e6

    stop.set()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    interesting = [l for l in err_lines
                   if any(k in l.lower() for k in
                          ("command", "not found", "error", "invalid", "unknown"))]
    return {"channel": channel, "before": before, "after": after, "note": note,
            "err": (interesting or [l for l in err_lines if l.strip()][-3:])[-6:]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window", type=float, default=8.0)
    ap.add_argument("--workdir", default="/tmp/yonder-spike")
    ap.add_argument("--channels", default="none,stdin-c,stdin-C,zmq-filter,"
                                          "zmq-encoder,v4l2-external")
    ap.add_argument("--ffmpeg", default="ffmpeg",
                    help="the ffmpeg binary, e.g. /usr/lib/jellyfin-ffmpeg/ffmpeg")
    ap.add_argument("--encoder", default="h264_v4l2m2m",
                    help="the encoder under test, e.g. h264_rkmpp")
    args = ap.parse_args()
    global FFMPEG, ENCODER                                        # noqa: PLW0603
    FFMPEG, ENCODER = args.ffmpeg, args.encoder
    os.makedirs(args.workdir, exist_ok=True)

    print(f"# {ENCODER} via {FFMPEG}, {WIDTH}x{HEIGHT}@{FPS}, opened at {FROM_KBPS} kb/s, "
          f"every channel asking for {TO_KBPS} kb/s")
    print(f"# {args.window:.0f} s measured before the request and {args.window:.0f} s "
          f"after it\n")
    rows = []
    for ch in args.channels.split(","):
        r = run(ch.strip(), args.window, args.workdir)
        if r["before"] <= 0.01:
            # The trap this directory exists to avoid: a zero is a pipeline that
            # never produced a frame, and it is not a bitrate.
            print(f"{r['channel']:<14} ** NO OUTPUT — not a measurement **")
            for l in r["err"]:
                print(f"    {l}")
            continue
        moved = "MOVED" if abs(r["after"] - r["before"]) > 0.25 * r["before"] else "unchanged"
        print(f"{r['channel']:<14} before {r['before']:5.2f} Mb/s   "
              f"after {r['after']:5.2f} Mb/s   {moved:9}   {r['note']}")
        for l in r["err"]:
            print(f"    ffmpeg: {l}")
        rows.append(r)
    print("\n| channel | before | after | verdict |")
    print("|---|---|---|---|")
    for r in rows:
        moved = "**moved**" if abs(r["after"] - r["before"]) > 0.25 * r["before"] else "unchanged"
        print(f"| `{r['channel']}` | {r['before']:.2f} Mb/s | {r['after']:.2f} Mb/s | {moved} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
