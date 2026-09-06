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

**Wiring — header pin, Pi signal, to the autopilot:**

| Header pin | Pi signal | To the autopilot |
|---|---|---|
| 6 | GND | GND |
| 8 | GPIO 14 — UART0 TXD | **RX** |
| 10 | GPIO 15 — UART0 RXD | **TX** |

No power wire: the autopilot has its own supply and both ends are 3.3 V logic.

The probe is a short Python program using `termios` and the `TIOCGICOUNT` ioctl
(`0x545D`, `struct serial_icounter_struct`, `frame` at index 6). It opens the port
non-blocking at each rate in turn, settles, flushes, reads for a fixed window, and counts
checksum-valid `HEARTBEAT` frames — resyncing one byte at a time on a failure rather than
trusting an unverified length.

1. `enable_uart=1` and `dtoverlay=disable-bt` in `/boot/firmware/config.txt`, under a
   `# yonder-uart` marker of its own; `console=serial0,115200` removed from `cmdline.txt`;
   `serial-getty@ttyAMA0` and `hciuart` disabled. Reboot. Done by hand for this note;
   `installer/roles/40-uart.sh` is the same four changes as an idempotent installer role,
   with a post-condition that checks the configuration it wrote rather than the hardware a
   chroot build cannot see (R-MAV-02, R-HW-04).
2. Wire pin 6 to the autopilot's ground, pin 8 to its **RX**, pin 10 to its **TX**.
3. Run the probe as root. Reverse the order and repeat a rate: an ascending sweep hides the
   stale-buffer trap above.

---

# Building mavlink-router on the same board

Task 2 of the M5a plan, answering §10.2 and §10.3 of the spec. Same board, same day.

## What it costs to build

<!-- yonder:hardware-observed -->

| | |
|---|---|
| Source | `mavlink-router` at `2362c62`, 2026-02-19, with submodules |
| Missing on a stock board | `meson`, `ninja-build`, `libsystemd-dev`, **and `systemd-dev`** |
| Binary | 5.0 MB unstripped, **325 KB stripped** |
| Version string | `mavlink-router version 2362c62` |

**Two dependency traps, and the second cost a build.** `meson` and `ninja-build` are the
obvious ones. Less obvious: the build looks for the **`systemd`** pkg-config module, not
`libsystemd` — installing `libsystemd-dev` gets you `libsystemd.pc` and the configure step
still fails with `Dependency "systemd" not found`. The package that carries `systemd.pc` on
Debian 13 is `systemd-dev`.

**And a parallel build runs this board out of memory.** `ninja -C build` with its default
four jobs died compiling `endpoint.cpp`:

```
c++: fatal error: Killed signal terminated program cc1plus
```

That is the OOM killer. This Pi 4 has **905 MiB of RAM and no swap**, and was also running
the daemon, the console and ZeroTier. `ninja -j1` completed without trouble.

**This is the argument for the offline payload, made concretely.** A 325 KB stripped binary
is cheap to carry; a build that needs three extra packages, a non-obvious one of them, and
more memory than the smallest board in the matrix has, is not something to do on a device.
`R-VPN-08`'s shape — build in CI, pin the version, record the fingerprint, install from the
payload — is the right one here for reasons beyond `R-CFG-07`.

## §10.3 is answered: it does attribute traffic per endpoint

With `ReportStats = true`, the router prints a block per endpoint to **stdout, once a
second**, naming each one:

```
UDP Endpoint [7]gcs0 {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 1 0KB
		Total: 1
	}
	Transmitted messages {
		Total: 45 1KB
	}
}
```

Two ground stations were configured. Only one answered — a fake GCS that listened on its port
and replied to whatever address the stream arrived from, which is how a real one behaves,
because the router sends from an ephemeral source port.

| Endpoint | Received (`Handled`) | Transmitted |
|---|---|---|
| `gcs0` — replied 21 heartbeats | **21** | 954 |
| `gcs1` — configured, silent | **0** | 954 |
| `autopilot` — the UART | 955 | 0 |

The received count tracks the answering endpoint exactly, and the silent one stays at zero.

**So §6's limitation is lifted.** The spec reasoned that the console could report *that* a
ground station was answering but not *which*, because the control plane sees one merged
loopback copy in which every ground station identifies itself the same way. That reasoning is
correct about the merged copy and irrelevant, because the attribution does not have to come
from the traffic — the router already keeps it, per endpoint, by name.

The first attempt at this measurement got `Handled: 0` on both endpoints and would have
confirmed the limitation wrongly. The fake ground station was sending its heartbeats to its
own port rather than back to the router's source port, so nothing ever reached the router at
all. **A test that proves a limitation by failing to exercise the thing is worth more
suspicion than one that fails outright.**

## What this does not settle

- **The format is text on stdout, and nothing promises it is stable.** Parsing it couples
  Yonder to an upstream print statement. Worth weighing against the alternative, which is
  reporting less than the router knows.
- **`SIGUSR1` is not a statistics trigger.** There is no handler for it in `src/`, so the
  default action applies and the signal terminates the process. Statistics are a
  configuration setting, not a signal.
- Nothing about the router under `systemd` sandboxing, or surviving a `yonder-core` restart.
  That is Task 16.

---

# Yonder's own code, on the wire

Task 10b's serial opener and Task 6's sweep, run against a live ArduPlane. Same board, same
wiring as above; 2026-09-06. This is the first time any of this milestone's code has touched
a real serial port — every test before it used a regular file, which answers a read and has
no line settings at all.

## The line settings hold up, and `-drain` matters

<!-- yonder:hardware-observed -->

| | |
|---|---|
| Vector | `stty -F /dev/ttyAMA0 -drain raw -echo cread clocal -crtscts cs8 -parenb -cstopb min 0 time 0 <baud>` |
| Time to apply | **28 ms** |
| coreutils | 9.7, so `-drain` is available (it needs ≥ 8.29) |

Without `-drain`, `stty` uses `TCSADRAIN` and waits for pending output *under the port's
current settings* — so a port left in `CRTSCTS` with CTS unasserted blocks before `-crtscts`
can be applied. 28 ms says the token does its job.

## The kernel's framing-error count is readable after all

`/proc/tty/driver/ttyAMA` prints it, and root can read it with nothing but `fs`:

```
0: uart:PL011 rev3 mmio:0xFE201000 irq:41 tx:441 rx:128891 fe:8197 brk:18103 oe:1
```

`fe:8197` is the count `TIOCGICOUNT` would have given. **This is the route back to the
fast path** `R-MAV-13` gave up when the opener chose `stty` over an ioctl: a wrong rate
could again be abandoned the moment errors appear, instead of waiting out its deadline.
Not taken here — recorded because it is cheap and nobody knew it existed.

## A loopback proves the board before the autopilot is blamed

With a jumper across pins 8 and 10 and nothing else attached, twenty bytes written came back
byte-identical. That settles TX, RX, the pin mux and the line settings in one move, and it is
worth doing *first* the next time a wire looks dead — it took the board out of the argument in
ten seconds.

**A trap it exposed:** `cat /dev/ttyAMA0` reads **zero bytes and exits immediately** under
this vector, because `min 0 time 0` makes an empty read return 0, which `cat` treats as
end-of-file. The kernel counters showed the bytes arriving while `cat` showed nothing. Any
hand-check of a port set up this way has to poll, exactly as `serial.ts` does.

## Detection, end to end

<!-- yonder:hardware-observed -->

| Run | Time | Outcome |
|---|---|---|
| Cold, no hint | **1664 ms** | `found /dev/ttyAMA0 @ 115200, ArduPlane, system 1` |
| Warm, hint 115200 | **1001 ms** | the same |

The cold run pays 57600's full deadline before reaching 115200. The warm run goes straight
there and still waits on the heartbeat's 1 Hz phase — consistent with the 739–874 ms spread
measured by hand the day before.

## Every wrong rate reports noise, and the plan said otherwise

<!-- yonder:hardware-observed -->

| Pinned rate | Time | Outcome | Bytes seen |
|---|---|---|---|
| 57 600 | 1393 ms | `noise` | 637 |
| 230 400 | 1382 ms | `noise` | 2887 |
| **921 600** | 1362 ms | **`noise`** | 3676 |

**This is the part worth keeping.** An amendment to `R-MAV-13`, written into the plan and
into the requirement, claimed that without the framing-error counter a wrong rate would now
read as *silence* rather than noise — and the bench checklist told the operator to expect
that. A reviewer disputed it from the kernel sources: `stty raw` clears `INPCK`, so the pl011
driver never sets the framing-error flag on the character, and the byte is delivered as
ordinary data. The requirement was reverted before this run.

The run agrees with the reviewer. Had it not been reverted, **a correct result would have
been read as a defect** — the failure mode where a wrong prediction costs more than a wrong
implementation, because it teaches you to distrust the right answer.

What losing the counter actually costs is **time**: every wrong rate now pays its full
1300 ms deadline instead of leaving early, which is the ~1.38 s in the table.

## What an absent device does, and why that is not a bug

`detect()` against `/dev/ttyDOESNOTEXIST` **rejects** with `ENOENT`. That is deliberate:
`MavlinkRenderer.probe()` catches it and reports `R-MAV-13` silence *for that device*,
without inventing four speeds it was never tried at. A caller below that layer sees the
rejection, which is what happened here.

## Still not proven

- **Nothing has been routed to a real ground station.** `mavlink-router` has not run against
  this link, and no Mission Planner or QGroundControl has ever connected. That is the last
  unknown in the path.
- The port-state handover from the sweep to the router.
- Anything on `/dev/ttyACM0` — a USB-attached autopilot is a different driver.

---

# A real ground station, at last

2026-09-06, same board and autopilot. `mavlink-router` was run from a configuration this
repository's own `routerConfig()` generated, and **QGroundControl** connected to it over the
local network. This is the last link in the path that had never been exercised: every earlier
measurement answered a ground station this project wrote itself.

<!-- yonder:hardware-observed -->

| Endpoint | Received | Transmitted |
|---|---|---|
| `autopilot` — the UART | 54 317 (1661 KB) | 7 146 |
| `gcs0` — **QGroundControl** | **7 146 (162 KB)** | 54 317 (1661 KB) |
| `yonder` — the control plane's copy | 0 | 54 432 |

**The number that matters is 7 146 received on `gcs0`.** Telemetry reaching a ground station
only proves the outbound half; that count is QGroundControl heartbeating *back*, attributed to
that endpoint by name, and forwarded on to the aircraft — which is the whole basis of §6's
claim that the console can say **which** ground station is answering rather than only that one
is. It had been measured against a purpose-built fake. It now holds against the real thing.

Note the control plane's own copy shows `Received: 0`. That is correct and worth stating,
because it looks like a fault: `yonder` is a listen-only mirror. Yonder relays commands, it
never originates them (`R-CMD-04`), so nothing should ever arrive back on that endpoint.

## One thing not understood

`gcs0` reports **`Sequence lost: 130710, 94%`** on the receive side while telemetry is plainly
healthy in both directions. The likeliest reading is that the counter is kept per endpoint
while QGroundControl transmits as several components with independent sequence numbers, so
interleaved streams read as gaps.

It is recorded rather than explained because nothing here has established it, and because the
console does not read that field today. If a future surface does, this is the first thing to
settle — a figure that says 94% loss on a link that is working would be the wrong thing to
put in front of an operator.

## And a second ground station, over the mesh

Repointed the same generated configuration at **Mission Planner** on a ZeroTier peer —
`10.113.83.38`, 24 ms away, sharing no local network with the board. This is the path that
matters, because it is the shape of the cellular case: the aircraft's board and the operator's
laptop reaching each other over an overlay rather than a LAN.

<!-- yonder:hardware-observed -->

| Endpoint | Received | Transmitted | Sequence lost |
|---|---|---|---|
| `gcs0` — **Mission Planner**, over ZeroTier | **70** | 3 988 (136 KB) | **0 — 0%** |
| `gcs0` — QGroundControl, over the LAN (earlier) | 7 146 | 54 317 | 130 710 — 94% |

Both answer. Two different ground-station programs, two different paths, and in each case the
router attributes the replies to the endpoint by name — which is what `§6` needs and what the
console's per-station marks read.

**The mesh run also settles the sequence-loss figure left open above.** Same board, same
router, same autopilot, and the *harder* path reports **zero** loss where QGroundControl
reported 94%. So the figure is an artifact of QGroundControl transmitting as several
components with independent sequence numbers against a counter kept per endpoint — not a
link measurement, and not something to put in front of an operator as one.

Before Mission Planner connected, the same endpoint read `Transmitted: 1889, Received: 0` —
telemetry going out, nothing answering. That is precisely the distinction `§6` exists to
draw, observed live: **configured and being sent to is not the same as answering.**
