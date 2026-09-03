# SPDX-License-Identifier: GPL-3.0-or-later
"""
DUML v1 — DJI's device command protocol — encode and decode.

Layout (from the publicly documented Wireshark dissector in dji-firmware-tools):

  0      SOF 0x55
  1..2   length (10 bits, low) | version (6 bits, high), little-endian
  3      CRC8 over bytes 0..2
  4      sender:   type (bits 0-4) | index (bits 5-7)      -- per comm_mkdupc.py
  5      receiver: type (bits 0-4) | index (bits 5-7)
  6..7   sequence, little-endian
  8      cmd type: bit7 = 1 for a response, bits 5-6 ack wanted, bits 0-2 encryption
  9      cmdset
  10     cmdid
  11..   payload
  last 2 CRC16 over everything before it, little-endian

Device types: 1 camera, 2 app, 4 gimbal, 6 remote, 10 PC. Command sets: 0 general,
2 camera, 4 gimbal. The CRC seeds are DJI's: CRC8 reflected poly 0x8C seed 0x77, CRC16 reflected poly
0x1021 (table 0000 1189 2312 …) seed 0x3692 — both checked against dji-firmware-tools.
"""
import struct

SOF = 0x55
DEV_CAMERA, DEV_APP, DEV_GIMBAL, DEV_RC, DEV_PC = 1, 2, 4, 6, 10
CMDSET = {0: "general", 1: "special", 2: "camera", 3: "flightctl", 4: "gimbal",
          6: "rc", 7: "wifi", 13: "battery"}

def _table8(poly=0x8C):
    # reflected form of 0x31 — the reference table starts 00 5e bc e2 61 3f dd 83
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ poly if c & 1 else c >> 1
        t.append(c)
    return t

def _table16(poly=0x1021):
    # reflected table for the KERMIT family
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ 0x8408 if c & 1 else c >> 1
        t.append(c)
    return t

_T8, _T16 = _table8(), _table16()

def crc8(data: bytes, seed=0x77) -> int:
    c = seed
    for b in data:
        c = _T8[(c ^ b) & 0xFF]
    return c

def crc16(data: bytes, seed=0x3692) -> int:
    c = seed
    for b in data:
        c = (c >> 8) ^ _T16[(c ^ b) & 0xFF]
    return c & 0xFFFF

def dev(type_, index=0) -> int:
    return (type_ & 0x1F) | ((index & 0x7) << 5)

def encode(cmdset: int, cmdid: int, payload: bytes = b"", *, seq: int = 0,
           sender=DEV_APP, receiver=DEV_CAMERA, sender_idx=1, receiver_idx=0,
           response=False, ack=1, encrypt=0, version=1) -> bytes:
    """ack=1 asks the device to acknowledge; ack=0 is fire-and-forget."""
    length = 13 + len(payload)
    head = bytes([SOF]) + struct.pack("<H", (length & 0x3FF) | ((version & 0x3F) << 10))
    head += bytes([crc8(head)])
    body = bytes([dev(sender, sender_idx), dev(receiver, receiver_idx)])
    body += struct.pack("<H", seq & 0xFFFF)
    body += bytes([((1 if response else 0) << 7) | ((ack & 3) << 5) | (encrypt & 7),
                   cmdset & 0xFF, cmdid & 0xFF]) + payload
    frame = head + body
    return frame + struct.pack("<H", crc16(frame))

class Frame:
    __slots__ = ("raw", "length", "version", "sender", "sender_idx", "receiver",
                 "receiver_idx", "seq", "response", "encrypt", "ack", "cmdset", "cmdid",
                 "payload", "crc_ok")
    def __repr__(self):
        who = lambda t, i: f"{ {1:'cam',2:'app',4:'gim',6:'rc',10:'pc'}.get(t, t)}{i}"
        kind = "RSP" if self.response else "REQ"
        cs = CMDSET.get(self.cmdset, str(self.cmdset))
        ok = "" if self.crc_ok else " CRC-BAD"
        pl = self.payload.hex(" ") if len(self.payload) <= 40 else self.payload[:40].hex(" ") + " …"
        return (f"{kind} {who(self.sender, self.sender_idx)}→{who(self.receiver, self.receiver_idx)} "
                f"seq={self.seq} ack={self.ack} {cs}/0x{self.cmdid:02x} len={len(self.payload)}{ok} [{pl}]")

def decode(buf: bytes) -> Frame:
    f = Frame(); f.raw = buf
    lv = struct.unpack_from("<H", buf, 1)[0]
    f.length, f.version = lv & 0x3FF, lv >> 10
    f.sender, f.sender_idx = buf[4] & 0x1F, buf[4] >> 5
    f.receiver, f.receiver_idx = buf[5] & 0x1F, buf[5] >> 5
    f.seq = struct.unpack_from("<H", buf, 6)[0]
    ct = buf[8]
    f.response, f.ack, f.encrypt = bool(ct & 0x80), (ct >> 5) & 3, ct & 7
    f.cmdset, f.cmdid = buf[9], buf[10]
    f.payload = bytes(buf[11:f.length - 2])
    f.crc_ok = crc8(buf[:3]) == buf[3] and crc16(buf[:f.length - 2]) == struct.unpack_from("<H", buf, f.length - 2)[0]
    return f

class Splitter:
    """Feed arbitrary byte chunks from a bulk pipe; yields complete DUML frames.
    Bytes that are not a frame (some links wrap DUML in their own envelope) are
    surfaced as ('junk', bytes) so nothing is silently dropped."""
    def __init__(self):
        self.buf = bytearray()
    def feed(self, data: bytes):
        self.buf += data
        while True:
            i = self.buf.find(SOF)
            if i < 0:
                if self.buf: junk, self.buf = bytes(self.buf), bytearray(); yield ("junk", junk)
                return
            if i:
                junk = bytes(self.buf[:i]); del self.buf[:i]; yield ("junk", junk)
            if len(self.buf) < 4:
                return
            if crc8(bytes(self.buf[:3])) != self.buf[3]:
                junk = bytes(self.buf[:1]); del self.buf[:1]; yield ("junk", junk); continue
            length = struct.unpack_from("<H", self.buf, 1)[0] & 0x3FF
            if length < 13:
                junk = bytes(self.buf[:1]); del self.buf[:1]; yield ("junk", junk); continue
            if len(self.buf) < length:
                return
            frame = bytes(self.buf[:length]); del self.buf[:length]
            yield ("frame", decode(frame))

if __name__ == "__main__":
    # self-test: a frame must decode to what was encoded, with both CRCs valid
    p = encode(0, 1, b"", seq=7)
    f = decode(p)
    assert f.crc_ok and f.cmdset == 0 and f.cmdid == 1 and f.seq == 7, f
    print("ok", p.hex(" "), f)
