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
    body = struct.pack("<II", 1, 1) + fs + hs
    return struct.pack("<III", 3, 12 + len(body), flags) + body
def strings():
    s = b"aoa\0"
    return struct.pack("<IIII", 2, 16 + 2 + len(s), 1, 1) + struct.pack("<H", 0x0409) + s

class Log:
    def __init__(self, path):
        self.f = open(path, "a", buffering=1); self.t0 = time.monotonic()
    def __call__(self, msg):
        line = f"[{time.monotonic()-self.t0:9.4f}] {msg}"; print(line, flush=True); self.f.write(line + "\n")

class Session:
    def __init__(self, args):
        self.a = args
        os.makedirs(args.logdir, exist_ok=True)
        self.log = Log(os.path.join(args.logdir, "session.log"))
        self.raw = open(os.path.join(args.logdir, "session.from-camera.bin"), "ab", buffering=0)
        self.seq = 1
        self.ep_in = self.ep_out = None
        self.split = duml.Splitter()
        self.enabled = threading.Event()

    def send(self, cmdset, cmdid, payload=b"", ack=1, note=""):
        frame = duml.encode(cmdset, cmdid, payload, seq=self.seq, ack=ack)
        self.seq = (self.seq + 1) & 0xFFFF
        os.write(self.ep_in, frame)
        self.log(f"us -> camera  {note or ''} {duml.decode(frame)}")

    def reader(self):
        while True:
            try:
                data = os.read(self.ep_out, 16384)
            except OSError as e:
                self.log(f"bulk OUT read error: {e}"); time.sleep(0.2); continue
            if not data:
                continue
            self.raw.write(data)
            for kind, item in self.split.feed(data):
                if kind == "frame":
                    tag = "camera -> us  "
                    if item.response and item.payload:
                        tag += f"status=0x{item.payload[0]:02x} "
                    self.log(tag + repr(item))
                    # A request that asks for an ack gets a bare OK back, so the
                    # camera does not stall waiting on a phone that never answers.
                    if not item.response and item.ack and not self.a.listen_only:
                        rsp = duml.encode(item.cmdset, item.cmdid, b"\x00", seq=item.seq,
                                          sender=duml.DEV_APP, receiver=item.sender,
                                          receiver_idx=item.sender_idx, response=True, ack=0)
                        os.write(self.ep_in, rsp)
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
    Session(p.parse_args()).run()
