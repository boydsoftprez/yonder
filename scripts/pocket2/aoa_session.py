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
        os.makedirs(args.logdir, exist_ok=True)
        self.log = Log(os.path.join(args.logdir, "session.log"))
        self.raw = open(os.path.join(args.logdir, "session.from-camera.bin"), "ab", buffering=0)
        self.seq = 1
        self.ep_in = self.ep_out = None
        self.split = duml.Splitter()
        self.env = Envelope()
        self.enabled = threading.Event()

    def send(self, cmdset, cmdid, payload=b"", ack=1, note=""):
        frame = duml.encode(cmdset, cmdid, payload, seq=self.seq, ack=ack)
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
        while True:
            time.sleep(1.0)
            self.send(0, 0x0E, ack=0, note="heartbeat")

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
    Session(p.parse_args()).run()
