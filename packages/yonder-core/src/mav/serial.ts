// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from "node:fs";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { systemClock, type Clock } from "../apply/types.js";
import type { CommandRunner } from "../net/runner.js";
import type { OpenPort, SerialPort } from "./detect.js";

/**
 * The one implementation of `OpenPort` against real hardware (R-MAV-01).
 *
 * **`stty` sets the line; `fs` reads it.** The alternative was a serial-port
 * dependency with a compiled component, and this milestone has already been
 * taught what that costs on the target: building `mavlink-router` on the dev
 * board was killed by the OOM killer, because the board has 905 MiB and no
 * swap. Nothing here compiles, on the board or anywhere else.
 *
 * **What that costs, stated rather than hidden.** Counting framing errors
 * needs the `TIOCGICOUNT` ioctl, and Node cannot issue one, so
 * `framingErrors` is always `0`.
 *
 * **What it does not cost is R-MAV-13's distinction.** A framing-errored byte
 * still arrives as ordinary data under this module's own `stty` vector, so a
 * wire carrying nothing but unframeable bytes still reads as `noise`:
 * `raw` sets `c_iflag = 0`, which clears `INPCK`; with `INPCK` clear
 * `pl011_setup_status_masks()` leaves `UART011_DR_FE` out of
 * `read_status_mask`; `pl011_fifo_to_tty()` masks the character with
 * `read_status_mask` *before* it tests for a framing error, so the flag never
 * survives to be tested; and with `ignore_status_mask` zero,
 * `uart_insert_char()` inserts the byte unconditionally. The line discipline
 * says the same thing twice over — `n_tty_receive_parity_error()` gates on
 * `I_INPCK` and stores the original character without it, and `raw -echo`
 * puts n_tty in `real_raw` mode (the driver carries `TTY_DRIVER_REAL_RAW`
 * from `uart_register_driver()`), whose receive path `memcpy`s every byte and
 * never consults the flag array at all.
 *
 * **The cost is timing.** `detect()`'s `if (errorsHere > 0) break;` fast path
 * can never fire through this opener, so every wrong rate is paid for in
 * full: `RATE_DEADLINE_MS` rather than the few hundred milliseconds it takes
 * for the errors to show. Four rates at 1300 ms plus a settle apiece is about
 * 5.5 s per device, well inside `ApplyEngine`'s 60 s bound — which is why
 * this is a cost and not a defect. `detect()` treats framing errors as
 * **sufficient** evidence of a wrong rate and never as necessary, so nothing
 * downstream has to change.
 *
 * **And it is recoverable without a dependency.** The kernel publishes the
 * same counter per port at `/proc/tty/driver/ttyAMA`, where
 * `uart_line_info()` prints it as `fe:%u`; plain `fs` can read that file as
 * root. Restoring the fast path needs no ioctl and no compiled module — it is
 * unbuilt, not unreachable, and it buys latency rather than correctness,
 * which is why it was not built here.
 *
 * **Nothing here decides anything.** This module opens a port and reads
 * bytes; `detect()` decides what they mean and `MavlinkRenderer` decides what
 * to do about it (rule 4).
 */

/**
 * How long the line is given to settle before anything is read off it.
 *
 * Measured, not chosen. The first bench run reported **two checksum-valid
 * heartbeats at a rate that cannot produce them**: bytes still draining at
 * the previous rate survived the change and were attributed to the next one,
 * because the probe flushed before the new rate had settled. Detection
 * confidently naming the wrong speed, having genuinely seen a valid frame, is
 * the worst failure available here, and 50 ms of settling *followed by* a
 * flush is the whole fix — six consecutive runs after it, none wrong.
 */
export const SETTLE_MS = 50;

/**
 * How often a read that has nothing looks again.
 *
 * `min 0 time 0` makes a read with nothing on it answer immediately; without
 * a pause between attempts a quiet rate would spin a core for its whole
 * deadline. 10 ms is inside the tty layer's own buffer with room to spare:
 * N_TTY holds 4096 bytes, which at 921600 baud 8N1 is 4096 x 10 / 921600 =
 * **44 ms** of traffic, so a look every 10 ms has 4.4x of margin and nothing
 * is lost between two of them.
 *
 * 44 ms is the budget, and it is worth stating exactly because an earlier
 * version of this comment said 450 — a decimal place that would invite
 * raising `POLL_MS` to something that overflows the buffer and silently drops
 * the bytes the sweep exists to read.
 */
const POLL_MS = 10;

/**
 * One read's worth. Above N_TTY's own 4096-byte buffer, so a single call
 * drains everything the line discipline is holding.
 */
const READ_BYTES = 8192;

/**
 * A bound on the flush, so a port that is talking without pause cannot hold
 * the drain open. 64 x 8 KiB is 512 KiB — about 5.6 seconds of traffic at
 * 921600 baud, against a 50 ms settle, so a legitimate flush cannot reach it.
 *
 * Reaching it is therefore evidence of something else, and it is **said out
 * loud** rather than given up on quietly: past this point bytes from the
 * previous speed survive into the new speed's window, which is the one
 * failure this whole module exists to prevent (see `SETTLE_MS`). A silent
 * give-up would defeat that safety property with nothing anywhere to read.
 */
const FLUSH_MAX_READS = 64;

const NOTHING = new Uint8Array(0);

/**
 * The exact line settings a MAVLink serial link needs, in the order `stty`
 * applies them (left to right).
 *
 * `raw -echo <baud>` is the familiar form and it is not enough, and the
 * reason every other token is here is one fact: **termios survives a close.**
 * `tty_save_termios()` stores it and `tty_init_termios()` restores it, and
 * none of `serial_core.c`, `amba-pl011.c` or `cdc-acm.c` asks for
 * `TTY_DRIVER_RESET_TERMIOS` — so a setting nothing sets stays at whatever
 * the port was last left at, which may be a getty's or a previous consumer's.
 * `raw` rewrites `c_iflag`, `c_oflag` and `c_lflag`; it never touches
 * `c_cflag` at all, which is where most of the list below lives.
 *
 *   - **`-drain`** — first, because without it the rest may never be applied.
 *     GNU `stty` calls `tcsetattr` with `TCSADRAIN` (`stty.c`:
 *     `static int tcsetattr_options = TCSADRAIN;`), and `TCSADRAIN` waits for
 *     pending output **under the port's settings as they already are**. A
 *     port left in `CRTSCTS` with CTS unasserted — which is every three-wire
 *     link — therefore blocks *before* the `-crtscts` below can be applied to
 *     rescue it. Chicken and egg, and the bill is `RUN_TIMEOUT_MS`: 120 s
 *     wedged holding a descriptor, which blows `ApplyEngine`'s 60 s renderer
 *     bound long before the runner gives up. `-drain` selects `TCSANOW`.
 *     Coreutils handles it in the argument loop rather than in the mode
 *     table, so its position is free; first is simply where it reads.
 *   - **`cread`** — `raw` does not set it, and a port left `-cread` by
 *     whatever held it last stays that way. With `CREAD` clear,
 *     `pl011_setup_status_masks()` sets `ignore_status_mask |=
 *     UART_DUMMY_DR_RX` and `pl011_fifo_to_tty()` ORs that bit into every
 *     character, so every byte is dropped before it reaches the line
 *     discipline: **the port is deaf at every rate**, and the sweep reports
 *     R-MAV-13 silence on correctly wired hardware, sending an operator to
 *     check pins that are right. This is the token that prevents that
 *     failure.
 *   - **`clocal`** — hygiene, and not the rescue it was once billed as. A
 *     serial port does not start from `tty_std_termios`:
 *     `uart_register_driver()` overrides it with `B9600 | CS8 | CREAD |
 *     HUPCL | CLOCAL`, `cdc-acm.c` does the same, and `amba-pl011.c` sets no
 *     `init_termios` of its own, so `ttyAMA0` inherits CLOCAL already. Nor
 *     would its absence bite here: `tty_port_block_til_ready()` returns on
 *     its `O_NONBLOCK` branch before carrier is considered at all, and both
 *     this module's `open(2)` and `stty -F`'s are non-blocking; and no
 *     post-open hangup is reachable either, since `uart_handle_dcd_change()`
 *     fires only on a DCD *transition* and the BCM2835 does not bring DCD out
 *     at all. It stays for the same reason the rest of the `c_cflag` group
 *     does — a port left `-clocal` stays that way, and a blocking open added
 *     later would then wait for a carrier three wires never assert — but it
 *     is not what keeps this link alive.
 *   - **`-crtscts`** — those same three wires carry no CTS. Hardware flow
 *     control left on by whoever held the port last is a port that will not
 *     talk, and (see `-drain`) a port `stty` itself would hang on.
 *   - **`cs8 -parenb -cstopb`** — MAVLink is 8N1. `raw` sets neither the
 *     character size, nor the parity, nor the stop bits, so a port left at
 *     7E1 would be swept at four speeds and produce nothing at all of them —
 *     and the sweep would report a wiring fault.
 *   - **`min 0 time 0`** — **the** mechanism by which a read never blocks,
 *     not a second one. In `n_tty_wait_for_input()` the `if (!*timeout)
 *     return 0;` check runs *before* the non-blocking check, so with
 *     `VMIN=0 VTIME=0` an empty read on a real tty returns **zero bytes,
 *     never `EAGAIN`**. `O_NONBLOCK` is still passed and still earns its
 *     place — it is what keeps `open(2)` itself from waiting — but the thing
 *     it is usually credited with here is done by these four tokens. They
 *     have to come after `raw`, which sets `min 1 time 0` itself.
 *
 * **No shell anywhere.** The device path is one element of an argument
 * vector, handed to `execFile` by the runner (ADR-0006), so nothing in it is
 * ever interpreted. `-F <device>` is also why a path beginning with `-`
 * cannot be mistaken for an option.
 */
function sttyArgv(device: string, baud: number): string[] {
  return [
    "stty", "-F", device, "-drain",
    "raw", "-echo", "cread", "clocal", "-crtscts", "cs8", "-parenb", "-cstopb", "min", "0", "time", "0",
    String(baud),
  ];
}

/** `await` this many milliseconds of the injected clock. Never the wall clock. */
function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => { clock.setTimer(ms, resolve); });
}

class SttySerialPort implements SerialPort {
  private closed = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly clock: Clock,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Settle, **then** flush. The order is the whole point — see `SETTLE_MS`.
   *
   * The flush is a drain rather than a `TCIFLUSH`, for the same reason
   * `framingErrors` is zero: the ioctl is out of reach. It reaches everything
   * the ioctl would, and for a reason that has nothing to do with the
   * descriptor being non-blocking — `n_tty_read()`, finding its own buffer
   * empty, calls `tty_buffer_flush_work()` to force the pending flip-buffer
   * push and then looks again, so one userspace read empties both of the
   * layers `TCIFLUSH` empties.
   *
   * What neither reaches is the hardware RX FIFO and the bytes still on the
   * wire. **The settle above is what covers those**, which is the other half
   * of why it comes first.
   */
  async settleAndFlush(): Promise<void> {
    await sleep(this.clock, SETTLE_MS);
    for (let i = 0; i < FLUSH_MAX_READS; i++) {
      if ((await this.readOnce()).length === 0) return;
    }
    this.log(
      `the line would not go quiet after ${FLUSH_MAX_READS} reads of ${READ_BYTES} bytes, `
        + "so bytes sent at the previous speed may be counted against this one",
    );
  }

  /**
   * Whatever arrived inside `ms`, and nothing from outside it.
   *
   * Returns as soon as there is anything rather than spending the window —
   * `detect()`'s loop is a deadline on the clock and each read is a slice of
   * it, so an early return costs nothing and buys latency to the first frame.
   *
   * Rejects on a read fault (`EIO` from a port that went away, say). That is
   * deliberate and it is the same contract a missing device gets: an
   * `OpenPort` reports a fault by failing, and `MavlinkRenderer.probe()` is
   * the single place that absorbs one — "a device node that will not open is
   * R-MAV-13's silence for that device". Swallowing it here would make a
   * broken port indistinguishable from a quiet one with nothing said anywhere.
   */
  async read(ms: number): Promise<{ bytes: Uint8Array; framingErrors: number }> {
    const deadline = this.clock.now() + ms;
    for (;;) {
      const bytes = await this.readOnce();
      // Always 0: `TIOCGICOUNT` is out of reach from this runtime. Stated
      // here rather than left as a TODO because it is a settled property of
      // the approach, not an unfinished one. It costs `detect()` its early
      // exit from a wrong rate and nothing else — a framing-errored byte is
      // still delivered as data, so the wire that produces them still reads
      // as noise. See this module's header for the kernel path, and
      // `/proc/tty/driver/ttyAMA` for the way back to the fast path.
      if (bytes.length > 0) return { bytes, framingErrors: 0 };
      if (this.clock.now() >= deadline) return { bytes: NOTHING, framingErrors: 0 };
      await sleep(this.clock, POLL_MS);
    }
  }

  /**
   * Release the descriptor, whatever happened before.
   *
   * Idempotent, and it never rejects: `close(2)` releases the descriptor even
   * when it reports an error, so a failure here is nothing a caller can act
   * on — while a rejection would come out of `detect()`'s `finally` and
   * abandon the rest of the sweep over a port that is already gone.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.handle.close();
    } catch {
      // Released regardless. Nothing to do and nothing to say.
    }
  }

  /** One `read(2)`. Empty when the line has nothing waiting on it. */
  private async readOnce(): Promise<Uint8Array> {
    const buffer = new Uint8Array(READ_BYTES);
    try {
      // `position: null` reads from the descriptor's own offset, which is the
      // only thing a character device has; a positional read would `pread`
      // and fail with ESPIPE.
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, null);
      return bytesRead === 0 ? NOTHING : buffer.subarray(0, bytesRead);
    } catch (error) {
      // "Nothing has arrived yet" is not a fault. Everything else is.
      //
      // **On a board this branch is dead, and it is kept deliberately.** With
      // `min 0 time 0` the line discipline answers an empty tty with zero
      // bytes rather than an errno — `n_tty_wait_for_input()` checks
      // `if (!*timeout) return 0;` before it checks `O_NONBLOCK` — and the
      // ordinary files this module's tests use as devices answer with zero
      // bytes too, at end of file. So both live paths return above.
      //
      // What this catches is a node entitled to answer the other way: a
      // character device opened `O_NONBLOCK` whose `min`/`time` did not take,
      // or one not on n_tty at all. Letting an `EAGAIN` out of here would
      // turn "nothing yet" into a rejection that ends the whole sweep.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return NOTHING;
      throw error;
    }
  }
}

/**
 * The production `OpenPort`: configure the line with `stty`, read it with `fs`.
 *
 * **The descriptor is opened first, then configured.** Two reasons, and both
 * are failures that only appear on a board:
 *
 *   - A setting applied to a port this process already holds cannot be lost
 *     to whatever grabs the node in between, and cannot be undone by the
 *     kernel tearing the port down at a last close.
 *   - A device that is not there costs no subprocess: `open(2)` fails with
 *     `ENOENT` and no `stty` is ever run. `/dev/ttyACM0` is absent on every
 *     board with nothing plugged into it, and `device: auto` sweeps it every
 *     time.
 *
 * **Flags.** `O_NONBLOCK` so `open(2)` itself cannot wait — for a carrier
 * three wires never assert, or for a port some other consumer is holding.
 * Keeping *reads* from blocking is `min 0 time 0`'s job, not this flag's; see
 * `sttyArgv`. `O_NOCTTY` because this daemon runs as a systemd service in a
 * session of its own: without it, opening a tty makes that tty the process's
 * controlling terminal, and a hangup on it then delivers `SIGHUP` to
 * `yonder-core`.
 *
 * **`log` is injected and optional.** Nothing here decides anything, so it
 * has almost nothing to say — but a flush that hits its bound has to be said
 * somewhere (see `FLUSH_MAX_READS`), and a module that reads a serial port
 * may not reach for a journal of its own.
 *
 * **Failures are reported by rejecting**, not by returning a port that reads
 * as silence. `MavlinkRenderer.probe()` is written for exactly that and turns
 * it into R-MAV-13's silence for that device with an empty `triedBauds` — the
 * honest "there was nothing here to sweep", rather than four speeds a device
 * that does not exist was never tried at. `render()` never throws, so K-19 is
 * satisfied where it is actually at stake.
 *
 * **On ADR-0006's "shelling out stays confined to renderers".** This is
 * constructed in `main()` rather than inside a renderer, but nothing else
 * ever calls what it returns: the only caller of an `OpenPort` is
 * `MavlinkRenderer`, through `detect()`, so every `stty` runs on a renderer's
 * stack and through the injected `CommandRunner`. Constructing it inside
 * `buildRenderers` instead would give the telemetry renderer a
 * hardware-touching default, which is precisely what
 * `BuildRenderersOptions.mavlink` being given-and-never-defaulted exists to
 * prevent: one test forgetting to override it would reach a real `/dev`.
 */
export function openPortWith(
  run: CommandRunner,
  opts: { clock?: Clock; log?: (line: string) => void } = {},
): OpenPort {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  return async (device, baud) => {
    const handle = await openFile(device, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    const port = new SttySerialPort(handle, clock, (line) => { log(`mavlink: ${device}: ${line}`); });
    let result;
    try {
      result = await run(sttyArgv(device, baud));
    } catch (error) {
      // The runner does not reject — a non-zero exit is a result — but it is
      // injected, so this cannot rest on that. A descriptor left open here is
      // one per rate, per device, every 30 seconds, for the life of the
      // daemon.
      await port.close();
      throw error;
    }
    if (result.code !== 0) {
      await port.close();
      throw new Error(
        `stty could not set ${device} to ${baud} baud (exit ${result.code}): `
          + (result.stderr.trim() || result.stdout.trim() || "no output"),
      );
    }
    return port;
  };
}
