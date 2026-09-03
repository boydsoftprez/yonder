#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
Accessory-stage session with the camera: decode what it says, say hello back.

Runs after the AOA handshake, on the 18d1:2d00 gadget with two bulk pipes.
Everything the camera sends is logged raw *and* decoded as DUML. Then, unless
--listen-only, it talks — the same opening moves a phone app would make, from
the publicly documented command sets:

  general/0x00  ping
  general/0x01  get version
  general/0xff  get device info
  general/0x0e  heartbeat, repeated every second
  camera /0x09  liveview subscribe  (payload from --liveview-hex; unknown yet)

Responses carry the camera's status byte first; a non-zero status with a
guessed payload is *information*, not failure — it tells us the command was
understood and the payload was not.
"""
import argparse, os, struct, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import duml

EV_BIND, EV_UNBIND, EV_ENABLE, EV_DISABLE, EV_SETUP, EV_SUSPEND, EV_RESUME = range(7)
EV_NAMES = ["BIND", "UNBIND", "ENABLE", "DISABLE", "SETUP", "SUSPEND", "RESUME"]

def iface(num_eps, cls, sub, proto):
    return struct.pack("<BBBBBBBBB", 9, 4, 0, 0, num_eps, cls, sub, proto, 1)
def ep(addr, mps):
    return struct.pack("<BBBBHB", 7, 5, addr, 2, mps, 0)
def descriptors():
    fs = iface(2, 0xFF, 0xFF, 0) + ep(0x81, 64) + ep(0x01, 64)
    hs = iface(2, 0xFF, 0xFF, 0) + ep(0x81, 512) + ep(0x01, 512)
    flags = 1 | 2 | 64 | 128
    body = struct.pack("<II", 3, 3) + fs + hs      # 3 descriptors per speed: interface + 2 endpoints
    return struct.pack("<III", 3, 12 + len(body), flags) + body
def strings():
    s = b"aoa\0"
    return struct.pack("<IIII", 2, 16 + 2 + len(s), 1, 1) + struct.pack("<H", 0x0409) + s

class Log:
    def __init__(self, path):
        self.f = open(path, "a", buffering=1); self.t0 = time.monotonic()
    def __call__(self, msg):
        line = f"[{time.monotonic()-self.t0:9.4f}] {msg}"; print(line, flush=True); self.f.write(line + "\n")

class Envelope:
    """The accessory link wraps DUML in 8-byte envelopes: 55 CC r1 r2 <len u32 LE>,
    then `len` bytes holding one or more DUML frames back to back. Observed from
    the camera with route bytes 49 57. Anything not starting 55 CC is handed to
    the DUML splitter raw, so a link without envelopes still decodes."""
    MAGIC = b"\x55\xcc"
    def __init__(self):
        self.buf = bytearray(); self.route = None; self.count = 0
    def feed(self, data):
        self.buf += data
        while self.buf:
            if self.buf[:2] == self.MAGIC:
                if len(self.buf) < 8: return
                n = struct.unpack_from("<I", self.buf, 4)[0]
                if len(self.buf) < 8 + n: return
                route = bytes(self.buf[2:4]); self.count += 1
                if self.route is None: self.route = route          # first route seen = command channel
                payload = bytes(self.buf[8:8 + n]); del self.buf[:8 + n]
                yield route, payload
            else:
                i = self.buf.find(self.MAGIC, 1)
                chunk = bytes(self.buf[:i]) if i > 0 else bytes(self.buf)
                del self.buf[:len(chunk)]
                yield None, chunk

class Session:
    # periodic status pushes seen from the camera; hidden with --quiet
    PUSHES = {(4, 0x05), (4, 0x19), (4, 0x27), (2, 0x80), (2, 0x81), (2, 0x87), (2, 0x88), (2, 0x8a), (2, 0xdc)}
    def __init__(self, args):
        self.a = args
        self.pushes = 0
        self.routes = {}
        self.last_att = 0.0
        self.last_yaw = None
        self.last_pitch = None
        self.last_roll = None
        self.last_limit = 0
        self.centre_yaw = None
        os.makedirs(args.logdir, exist_ok=True)
        self.log = Log(os.path.join(args.logdir, "session.log"))
        self.raw = open(os.path.join(args.logdir, "session.from-camera.bin"), "ab", buffering=0)
        self.seq = 1
        self.ep_in = self.ep_out = None
        self.split = duml.Splitter()
        self.env = Envelope()
        self.enabled = threading.Event()

    # Absolute-angle commands the gimbal cannot satisfy in yaw are not refused by the
    # camera: it reaches the number by whipping the head over the top through the pitch
    # axis, and on the bench that was a mechanical click and a fast spin. So every angle
    # command is checked here first, against the window the sweep found safe and a
    # per-command step. Bypass only with --unsafe-gimbal, and only deliberately.
    def gimbal_guard(self, cmdset, cmdid, payload):
        if cmdset != 4 or self.a.unsafe_gimbal:
            return None
        # 1. Never command a gimbal that is already in trouble. A recentre sent while
        #    the head was over the top folded it past the tilt stop and stalled the
        #    motor. Any limit bit, or a head far from level, means the operator puts
        #    it right by hand first.
        if self.last_limit:
            return f"gimbal reports a limit (0x{self.last_limit:02x}); clear it by hand and recentre from the camera first"
        if self.last_pitch is not None and abs(self.last_pitch) > 60:
            return f"gimbal pitch is {self.last_pitch:.1f}: not a sane pose to command from"
        if cmdid not in (0x14, 0x0A):
            return None
        # 2. Absolute angle: field 0 yaw, field 1 ROLL, field 2 PITCH — identified on
        #    the bench. Each is boxed, and each may move at most max_step per command.
        if len(payload) < 6:
            return "angle command needs yaw, roll and pitch"
        yaw, roll, pitch = (v / 10.0 for v in struct.unpack_from("<hhh", payload, 0))
        if self.a.yaw_window:
            lo, hi = self.a.yaw_window
        elif self.centre_yaw is not None:
            lo, hi = self.centre_yaw - self.a.yaw_reach, self.centre_yaw + self.a.yaw_reach
        else:
            return "centre unknown yet: recentre first (4:0x4c:0201:4) or pass --yaw-window"
        if not (lo <= yaw <= hi):
            return f"yaw {yaw:.1f} outside the safe window {lo:.1f}..{hi:.1f} (centre {self.centre_yaw})"
        if self.last_yaw is not None and abs(yaw - self.last_yaw) > self.a.max_step:
            return f"yaw {yaw:.1f} is {abs(yaw - self.last_yaw):.0f} from current {self.last_yaw:.1f}; max step {self.a.max_step}"
        rlo, rhi = self.a.roll_window
        if not (rlo <= roll <= rhi):
            return f"roll {roll:.1f} outside the roll window {rlo}..{rhi}"
        plo, phi = self.a.pitch_window
        if not (plo <= pitch <= phi):
            return f"pitch {pitch:.1f} outside the pitch window {plo}..{phi}"
        if self.last_pitch is not None and abs(pitch - self.last_pitch) > self.a.max_step:
            return f"pitch {pitch:.1f} is {abs(pitch - self.last_pitch):.0f} from current {self.last_pitch:.1f}; max step {self.a.max_step}"
        return None

    def learn_centre(self):
        if self.last_yaw is not None:
            self.centre_yaw = self.last_yaw
            self.log(f"gimbal centre learned: yaw {self.centre_yaw:.1f}; angle guard allows ±{self.a.yaw_reach:.0f} around it")

    def send(self, cmdset, cmdid, payload=b"", ack=1, note="", receiver=None, sender_idx=None):
        why = self.gimbal_guard(cmdset, cmdid, payload)
        if why:
            self.log(f"REFUSED {note or ''} {cmdset}/0x{cmdid:02x} {payload.hex(' ')}: {why}")
            return
        if receiver is None:
            receiver = duml.DEV_GIMBAL if cmdset == 4 else duml.DEV_CAMERA
        if sender_idx is None:
            sender_idx = self.a.sender_idx
        if cmdset == 4 and cmdid == 0x4C:
            threading.Timer(2.5, self.learn_centre).start()
        frame = duml.encode(cmdset, cmdid, payload, seq=self.seq, ack=ack,
                            receiver=receiver, sender_idx=sender_idx)
        self.seq = (self.seq + 1) & 0xFFFF
        os.write(self.ep_in, self.wrap(frame))
        self.log(f"us -> camera  {note or ''} {duml.decode(frame)}  (route {self.route_bytes().hex()})")

    def route_bytes(self):
        if self.a.route: return bytes.fromhex(self.a.route)
        return b"\x49\x57"                                   # the command channel, always

    def wrap(self, frame):
        if self.a.no_envelope: return frame
        return Envelope.MAGIC + self.route_bytes() + struct.pack("<I", len(frame)) + frame

    def other_route(self, route, chunk):
        """Envelopes on any route but the command one: dumped verbatim per route,
        rate reported once a second, H.264 start codes counted so a picture is
        recognised the moment it appears."""
        key = route.hex()
        st = self.routes.setdefault(key, {"f": open(os.path.join(self.a.logdir, f"route-{key}.bin"), "ab", buffering=0),
                                          "bytes": 0, "t": time.monotonic(), "sc": 0})
        st["f"].write(chunk); st["bytes"] += len(chunk); st["sc"] += chunk.count(b"\x00\x00\x01")
        now = time.monotonic()
        if now - st["t"] >= 1.0:
            self.log(f"route {key}: {st['bytes']*8/(now-st['t'])/1e6:5.2f} Mb/s  h264-start-codes={st['sc']}  head={chunk[:16].hex(' ')}")
            st["bytes"] = 0; st["sc"] = 0; st["t"] = now

    def reader(self):
        while True:
            try:
                data = os.read(self.ep_out, 16384)
            except OSError as e:
                self.log(f"bulk OUT read error: {e}"); time.sleep(0.2); continue
            if not data:
                continue
            self.raw.write(data)
            for route, chunk in self.env.feed(data):
              if route is not None and route != b"\x49\x57":
                  self.other_route(route, chunk); continue
              for kind, item in self.split.feed(chunk):
                if kind == "frame":
                    quiet = (not item.response) and (item.cmdset, item.cmdid) in self.PUSHES
                    if (item.cmdset, item.cmdid) == (4, 0x05) and len(item.payload) >= 11:
                        pv, rv, yv = struct.unpack_from("<hhh", item.payload, 0)
                        self.last_pitch, self.last_roll, self.last_yaw = pv / 10.0, rv / 10.0, yv / 10.0
                        self.last_limit = item.payload[10] & 0x07      # bits 0-2: the limit flags
                    if (item.cmdset, item.cmdid) == (4, 0x05) and self.a.track_gimbal:
                        now = time.monotonic()
                        if now - self.last_att >= 0.5:
                            self.last_att = now
                            w = struct.unpack_from("<8h", item.payload, 0) if len(item.payload) >= 16 else ()
                            self.log(f"gimbal/0x05 attitude push  int16s={list(w)}  raw={item.payload[:24].hex(' ')}")
                    if quiet and self.a.quiet:
                        self.pushes += 1
                        continue
                    tag = "camera -> us  "
                    if item.response and item.payload:
                        tag += f"status=0x{item.payload[0]:02x} "
                    self.log(tag + repr(item))
                    if not item.response and item.ack and not self.a.listen_only:
                        rsp = duml.encode(item.cmdset, item.cmdid, b"\x00", seq=item.seq,
                                          sender=duml.DEV_APP, receiver=item.sender,
                                          receiver_idx=item.sender_idx, response=True, ack=0)
                        os.write(self.ep_in, self.wrap(rsp))
                else:
                    self.log(f"camera -> us  NOT-DUML {len(item)} B  {item[:32].hex(' ')}{' …' if len(item) > 32 else ''}")

    def talker(self):
        self.enabled.wait()
        time.sleep(0.5)
        if self.a.listen_only:
            self.log("listen-only: saying nothing"); return
        self.send(0, 0x00, note="ping")
        self.send(0, 0x01, note="get version")
        self.send(0, 0xFF, note="get device info")
        if self.a.liveview_hex:
            time.sleep(1.0)
            self.send(2, 0x09, bytes.fromhex(self.a.liveview_hex), note="liveview subscribe")
        if self.a.extra:
            for spec in self.a.extra:          # cmdset:cmdid:hexpayload
                cs, ci, hx = (spec.split(":") + [""])[:3]
                self.send(int(cs, 0), int(ci, 0), bytes.fromhex(hx), note="extra")
        inject = os.path.join(self.a.logdir, "inject.txt"); seen = 0
        while True:
            time.sleep(1.0)
            self.send(0, 0x0E, ack=0, note="heartbeat")
            try:
                lines = open(inject).read().splitlines()
            except FileNotFoundError:
                continue
            for spec in lines[seen:]:
                spec = spec.strip()
                if not spec or spec.startswith("#"): continue
                # cmdset:cmdid:hex[:receiver_type[:sender_idx]]
                parts = (spec.split(":") + ["", "", ""])[:5]
                cs, ci, hx, rx, sx = parts
                try:
                    self.send(int(cs, 0), int(ci, 0), bytes.fromhex(hx), note=f"inject[{spec}]",
                              receiver=int(rx, 0) if rx else None, sender_idx=int(sx, 0) if sx else None)
                except Exception as e:
                    self.log(f"inject {spec!r}: {e}")
            seen = len(lines)

    def run(self):
        ep0 = os.open(os.path.join(self.a.ffs, "ep0"), os.O_RDWR)
        os.write(ep0, descriptors()); os.write(ep0, strings())
        self.log("accessory 18d1:2d00 presented; waiting for the camera to enable us")
        threading.Thread(target=self.talker, daemon=True).start()
        while True:
            evt = os.read(ep0, 12 * 8)
            for off in range(0, len(evt), 12):
                bRT, bReq, wVal, wIdx, wLen, typ = struct.unpack_from("<BBHHHB", evt, off)
                if typ == EV_SETUP:
                    self.log(f"SETUP bmRequestType=0x{bRT:02x} bRequest={bReq} wValue=0x{wVal:04x} wIndex=0x{wIdx:04x} wLength={wLen}")
                    try:
                        if bRT & 0x80: os.read(ep0, 0)
                        else:          os.write(ep0, b"")
                    except OSError: pass
                    continue
                self.log(f"event {EV_NAMES[typ]}")
                if typ == EV_ENABLE and self.ep_out is None:
                    self.ep_in  = os.open(os.path.join(self.a.ffs, "ep1"), os.O_RDWR)
                    self.ep_out = os.open(os.path.join(self.a.ffs, "ep2"), os.O_RDWR)
                    threading.Thread(target=self.reader, daemon=True).start()
                    self.enabled.set()

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--ffs", default="/dev/ffs-aoa")
    p.add_argument("--logdir", default="/var/tmp/aoa")
    p.add_argument("--listen-only", action="store_true", help="log only; send nothing")
    p.add_argument("--liveview-hex", default="", help="payload for camera/0x09 liveview subscribe")
    p.add_argument("--extra", action="append", help="cmdset:cmdid:hexpayload, may repeat")
    p.add_argument("--route", default="", help="envelope route bytes as hex; default mirrors the camera")
    p.add_argument("--no-envelope", action="store_true", help="send bare DUML frames")
    p.add_argument("--quiet", action="store_true", help="do not log the periodic status pushes")
    p.add_argument("--track-gimbal", action="store_true", help="log the gimbal attitude push twice a second")
    p.add_argument("--sender-idx", type=int, default=1, help="our app index in the sender byte (camera pushes to app0)")
    p.add_argument("--yaw-window", type=float, nargs=2, default=None, metavar=("MIN", "MAX"),
                   help="absolute yaw the guard allows; default is a window around the centre learned at each recentre")
    p.add_argument("--roll-window", type=float, nargs=2, default=(-15.0, 15.0), metavar=("MIN", "MAX"),
                   help="absolute roll the guard allows (field 1 of 4/0x14)")
    p.add_argument("--pitch-window", type=float, nargs=2, default=(-30.0, 20.0), metavar=("MIN", "MAX"),
                   help="absolute pitch the guard allows (field 2 of 4/0x14); widen only with the camera upright and held")
    p.add_argument("--yaw-reach", type=float, default=55.0,
                   help="half-width of the default window around centre, degrees (the stops were at about 68 and 65)")
    p.add_argument("--max-step", type=float, default=20.0, help="largest change in any axis one command may ask for, degrees")
    p.add_argument("--unsafe-gimbal", action="store_true", help="disable the angle guard (it clicked and spun without it)")
    Session(p.parse_args()).run()
