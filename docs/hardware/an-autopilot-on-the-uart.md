# An autopilot on the UART

What a Raspberry Pi 4 hears when an ArduPilot flight controller is wired to pins 6, 8 and 10,
and what that settles about `R-MAV-13`. Requirement: `R-MAV-01`, `R-MAV-02`, `R-MAV-13`.
Milestone: M5a, Task 1.

The design this tests is in
[the telemetry plumbing spec](../superpowers/specs/2026-09-03-telemetry-plumbing-design.md);
§10.1 of that document names the assumption this note exists to check.

## The board, and freeing the wire

<!-- yonder:hardware-observed -->

| Field | Observed |
|---|---|
| Board | Raspberry Pi 4 Model B Rev 1.5, Debian 13 (trixie), aarch64 |
| Before | **No serial device at all** — no `/dev/ttyAMA0`, no `/dev/ttyS0`. `enable_uart` was never set |
| Kernel command line | carried `console=serial0,115200` |
| After `enable_uart=1` + `dtoverlay=disable-bt`, and a reboot | `/dev/ttyAMA0`, with `/dev/serial0 → ttyAMA0` |
| Reboot cost | back on Wi-Fi and the mesh in about 30 seconds |
| Date | 2026-09-05 |

Two lines in `config.txt` and one deletion from `cmdline.txt`, exactly as §2 of the spec
describes. `serial-getty@ttyAMA0` and `hciuart` were disabled in the same step. The board was
reached over ZeroTier riding `wlan0` throughout; nothing needed a power cycle.

`vcgencmd get_throttled` reported `0xd0000` — under-voltage, throttling and a soft temperature
limit have all *occurred* on this board, none of them currently. That is [K-41](../known-issues.md),
already open, and it is recorded here because an autopilot is one more thing drawing from the
same supply.

## What the autopilot is

**ArduPlane, system 1, MAVLink v2, at 115200 baud.** Read out of the heartbeat itself:
`type = 1` (`MAV_TYPE_FIXED_WING`), `autopilot = 3` (`MAV_AUTOPILOT_ARDUPILOTMEGA`).

## Every rate produces bytes. Only one produces frames.

Four seconds at each rate, the order reversed and two rates repeated to rule out ordering
effects. `frame_err` is the kernel's own count from `TIOCGICOUNT`, sampled before and after.

| Baud | Bytes | Framing errors | Valid heartbeats |
|---|---|---|---|
| 230400 | 7802 | 2482 | 0 |
| 921600 | 10294 | **0** | 0 |
| **115200** | 5696 | **0** | **4** — `(1, 1, 3)` |
| 57600 | 2384 | 1071 | 0 |
| 230400 *(repeat)* | 7758 | 2397 | 0 |
| **115200** *(repeat)* | 5517 | **0** | **4** |

Three things follow, and the second is the one that changes the design.

**Byte presence proves nothing.** Bytes arrive at every rate, and the count scales with the
rate — 2384 at 57600 up to 10294 at 921600 — because a UART reading a 115200 signal at
921600 simply manufactures more garbage per second. Any detector that treats "bytes arrived"
as a signal is reading its own sampling rate.

**Framing errors are sufficient evidence of a mismatch, and not necessary.** At 57600 and
230400 they are overwhelming — a thousand to two and a half thousand in four seconds against
zero at the right rate, which is as clean a discriminator as this kind of thing ever gets. But
**921600 produced no framing errors at all**, and no valid frames either. Reading a 115200
signal at 8× its rate, each transmitted bit spans eight sampled bits, so the sampler sees long
uniform runs that happen to frame correctly as bytes. A wrong rate can look clean.

So the rule cannot be "framing errors mean the rate is wrong, their absence means it is
right". It is:

- **valid frame** → right rate, stop;
- **framing errors** → wrong rate, leave immediately;
- **bytes but neither** → still wrong, but only the deadline can say so.

`R-MAV-13`'s three outcomes stand as specified, and §10.1's fallback is not needed — the
counter is there and it works. What §10.1 did not anticipate is that one wrong rate in four
gives the fast path nothing to work with, so the worst case is bounded by the deadline rather
than by the errors.

## The right rate answers in about three quarters of a second

Time from opening the port to the first checksum-valid heartbeat, six consecutive runs at
115200: **874, 746, 746, 753, 739, 752 ms.**

`HEARTBEAT` is 1 Hz, so this is one interval with a random phase offset, as expected. The
spec's per-rate deadline of **1300 ms** clears the worst of these by a comfortable margin and
is now measured rather than reasoned. A deadline of one second would have missed the first
run.

## The stale-buffer trap, which cost the first measurement

The first attempt reported **two valid heartbeats at 230400** — impossible, since a
CRC-checked heartbeat cannot appear by chance, and not reproducible in any later run.

The cause is that rates were tried in ascending order, so 230400 came immediately after
115200, and bytes already in the kernel's buffer at the old rate survived the change. The
probe flushed, but flushed *before* the new rate had settled.

**A sweep must flush after changing the rate and after a short settle**, or the previous
rate's data is attributed to the next one — and the failure mode is the worst possible one:
detection confidently reports the wrong baud, having genuinely seen a valid frame. The
implementation takes a 50 ms settle and then flushes; that is what the later runs did, and
they are consistent across six.

## What this does not prove

- **Nothing about the transmit wire.** Everything here is receive-only. The board has not
  sent a byte to the autopilot, so a broken or missing TX line would look exactly like this.
- **Nothing about a wiring fault that corrupts rather than silences.** A poor ground or an
  intermittent joint would raise framing errors at the *right* rate, which would read as
  "wrong rate" to this logic. Not observed here — the right rate showed zero — but the
  diagnosis cannot rule it out, which is why the console's wording names both possibilities.
- **Nothing about `mavlink-router`**, which has not been built or run on this board. That is
  Task 2.

## The bench procedure

The probe is a short Python program using `termios` and the `TIOCGICOUNT` ioctl
(`0x545D`, `struct serial_icounter_struct`, `frame` at index 6). It opens the port
non-blocking at each rate in turn, settles, flushes, reads for a fixed window, and counts
checksum-valid `HEARTBEAT` frames — resyncing one byte at a time on a failure rather than
trusting an unverified length.

1. `enable_uart=1` and `dtoverlay=disable-bt` in `/boot/firmware/config.txt`, under a
   `# yonder-uart` marker of its own; `console=serial0,115200` removed from `cmdline.txt`;
   `serial-getty@ttyAMA0` and `hciuart` disabled. Reboot.
2. Wire pin 6 to the autopilot's ground, pin 8 to its **RX**, pin 10 to its **TX**.
3. Run the probe as root. Reverse the order and repeat a rate: an ascending sweep hides the
   stale-buffer trap above.
