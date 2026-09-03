#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
Phone emulator for a camera that expects an Android phone on its USB port.

Two stages, because Android Open Accessory (AOA) re-enumerates the phone:

  phone      -- look like an ordinary Android phone. Log every control
                request the camera sends. Answer AOA:
                  51 GET_PROTOCOL  -> we support protocol 2
                  52 SEND_STRING   -> record the accessory strings (these
                                      name the app the camera expects)
                  53 START         -> write the strings to disk and exit 0,
                                      so the driver can re-present us as an
                                      accessory within the ~1 s the spec allows
  accessory  -- present VID 18d1 PID 2d00 with one bulk IN and one bulk OUT.
                Log every byte the camera sends, forever. Optionally send a
                hex payload once the interface is enabled.

Everything is FunctionFS, entirely in userspace; no kernel module beyond
what Raspberry Pi OS already ships (libcomposite, usb_f_fs, dwc2 built in).
"""
import argparse, os, struct, sys, threading, time

# --- FunctionFS constants (linux/usb/functionfs.h) ---------------------------
DESCRIPTORS_MAGIC_V2 = 3
STRINGS_MAGIC        = 2
HAS_FS_DESC     = 1
HAS_HS_DESC     = 2
ALL_CTRL_RECIP  = 64     # deliver control requests for any recipient
CONFIG0_SETUP   = 128    # deliver setup packets even before SET_CONFIGURATION
EV_BIND, EV_UNBIND, EV_ENABLE, EV_DISABLE, EV_SETUP, EV_SUSPEND, EV_RESUME = range(7)
EV_NAMES = ["BIND", "UNBIND", "ENABLE", "DISABLE", "SETUP", "SUSPEND", "RESUME"]

# --- AOA (source.android.com/docs/core/interaction/accessories/aoa) ----------
AOA_GET_PROTOCOL = 51
AOA_SEND_STRING  = 52
AOA_START        = 53
AOA_STRING_NAMES = {0: "manufacturer", 1: "model", 2: "description",
                    3: "version", 4: "uri", 5: "serial"}

def iface(num_eps, cls, sub, proto):
    return struct.pack("<BBBBBBBBB", 9, 4, 0, 0, num_eps, cls, sub, proto, 1)

def ep(addr, mps):
    return struct.pack("<BBBBHB", 7, 5, addr, 2, mps, 0)

def descriptors(stage):
    if stage == "phone":
        fs = iface(0, 0xFF, 0x42, 0x00)   # vendor interface, no endpoints
        hs = fs
    else:
        fs = iface(2, 0xFF, 0xFF, 0x00) + ep(0x81, 64)  + ep(0x01, 64)
        hs = iface(2, 0xFF, 0xFF, 0x00) + ep(0x81, 512) + ep(0x01, 512)
    flags = HAS_FS_DESC | HAS_HS_DESC | ALL_CTRL_RECIP | CONFIG0_SETUP
    body = struct.pack("<II", 1, 1) + fs + hs      # fs_count, hs_count
    head = struct.pack("<III", DESCRIPTORS_MAGIC_V2, 12 + len(body), flags)
    return head + body

def strings():
    s = b"aoa\0"
    return struct.pack("<IIII", STRINGS_MAGIC, 16 + 2 + len(s), 1, 1) + struct.pack("<H", 0x0409) + s

class Log:
    def __init__(self, path):
        self.f = open(path, "a", buffering=1)
        self.t0 = time.monotonic()
    def __call__(self, msg):
        line = f"[{time.monotonic()-self.t0:9.4f}] {msg}"
        print(line, flush=True); self.f.write(line + "\n")

def hexdump(b, width=32):
    return " ".join(f"{x:02x}" for x in b[:width]) + (" …" if len(b) > width else "")

def run(args):
    log = Log(os.path.join(args.logdir, f"{args.stage}.log"))
    raw = open(os.path.join(args.logdir, f"{args.stage}.from-camera.bin"), "ab", buffering=0)
    ep0 = os.open(os.path.join(args.ffs, "ep0"), os.O_RDWR)
    os.write(ep0, descriptors(args.stage))
    os.write(ep0, strings())
    log(f"stage={args.stage} descriptors written; waiting for the camera")

    acc = {}
    ep_in = ep_out = None
    stop = threading.Event()

    def reader():
        n = 0
        while not stop.is_set():
            try:
                data = os.read(ep_out, 16384)
            except OSError as e:
                log(f"bulk OUT read error: {e}"); time.sleep(0.2); continue
            if not data:
                continue
            n += len(data); raw.write(data)
            log(f"camera -> us  {len(data):5d} B  {hexdump(data)}")

    while True:
        evt = os.read(ep0, 12 * 8)
        for off in range(0, len(evt), 12):
            bRT, bReq, wVal, wIdx, wLen, typ = struct.unpack_from("<BBHHHB", evt, off)
            if typ != EV_SETUP:
                log(f"event {EV_NAMES[typ]}")
                if typ == EV_ENABLE and args.stage == "accessory":
                    ep_in  = os.open(os.path.join(args.ffs, "ep1"), os.O_RDWR)
                    ep_out = os.open(os.path.join(args.ffs, "ep2"), os.O_RDWR)
                    threading.Thread(target=reader, daemon=True).start()
                    if args.send_hex:
                        payload = bytes.fromhex(args.send_hex)
                        os.write(ep_in, payload); log(f"us -> camera  {len(payload)} B  {hexdump(payload)}")
                continue
            direction_in = bool(bRT & 0x80)
            log(f"SETUP bmRequestType=0x{bRT:02x} bRequest={bReq} wValue=0x{wVal:04x} wIndex=0x{wIdx:04x} wLength={wLen}")
            vendor = (bRT & 0x60) == 0x40
            if vendor and bReq == AOA_GET_PROTOCOL and direction_in:
                os.write(ep0, struct.pack("<H", 2)); log("  -> AOA GET_PROTOCOL: answered 2")
            elif vendor and bReq == AOA_SEND_STRING and not direction_in:
                data = os.read(ep0, wLen) if wLen else b""
                name = AOA_STRING_NAMES.get(wIdx, f"string{wIdx}")
                acc[name] = data.rstrip(b"\0").decode("utf-8", "replace")
                log(f"  -> AOA SEND_STRING {name} = {acc[name]!r}")
            elif vendor and bReq == AOA_START and not direction_in:
                os.read(ep0, 0); log("  -> AOA START: camera wants us to become an accessory")
                with open(os.path.join(args.logdir, "accessory-strings.txt"), "w") as f:
                    for k, v in acc.items(): f.write(f"{k}={v}\n")
                if args.stage == "phone":
                    stop.set(); os.close(ep0); return 0
            else:
                # Not ours: stall by driving the wrong direction.
                try:
                    if direction_in: os.read(ep0, 0)
                    else:            os.write(ep0, b"")
                except OSError: pass
                log("  -> stalled (not an AOA request)")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--stage", choices=["phone", "accessory"], required=True)
    p.add_argument("--ffs", default="/dev/ffs-aoa")
    p.add_argument("--logdir", default="/var/tmp/aoa")
    p.add_argument("--send-hex", default="", help="accessory stage: bytes to send once enabled")
    a = p.parse_args(); os.makedirs(a.logdir, exist_ok=True)
    sys.exit(run(a))
