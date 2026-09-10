// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../apply/types.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ConfigSchema } from "../schema/config.js";
import { detect } from "./detect.js";
import { MavlinkRenderer } from "./renderer.js";
import { SETTLE_MS, openPortWith } from "./serial.js";
import { fakeClock, heartbeatV2 } from "./testing.js";

/**
 * **No test here runs a real command or opens a real serial port.** The
 * runner is a fake that records argv, and the "device" is an ordinary file in
 * a temporary directory: a file answers `read(2)` the same way a quiet port
 * does — some bytes, then nothing — which is exactly the surface this module
 * is built on.
 */

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

function runnerRecording(reply: (argv: string[]) => CommandResult = () => OK) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };
  return { run, calls };
}

/**
 * A clock that moves only when the code under test asks to wait, and never
 * touches the wall clock.
 *
 * `setTimer` advances the clock by exactly the wait it was handed and then
 * resolves on a microtask, so an `await sleep(50)` costs 50 ms of *this*
 * clock and no real time at all. `onWait` runs before the sleeper wakes,
 * which is a test's chance to make the world change during the wait — bytes
 * arriving while the line settles, say.
 */
function handWound(onWait: (ms: number) => void = () => {}): Clock & { waits: number[]; at(): number } {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    setTimer: (ms, fn) => {
      waits.push(ms);
      t += ms;
      onWait(ms);
      queueMicrotask(fn);
      return waits.length;
    },
    clearTimer: () => {},
    waits,
    at: () => t,
  };
}

/**
 * How many descriptors this process is holding. Both supported bases expose
 * them as a directory; macOS, where this suite is also run, exposes `/dev/fd`
 * alone. Used only for *bounded growth over many attempts*, never for an
 * exact delta: a test worker opens and closes files of its own while this
 * runs, so an exact count would be flaky while fifty leaked descriptors are
 * unmistakable.
 */
function descriptorCount(): number {
  return readdirSync(existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd").length;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yonder-serial-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A "device" with these bytes already waiting on it. */
function device(contents = ""): string {
  const path = join(tempDir(), "ttyFAKE0");
  writeFileSync(path, contents);
  return path;
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("openPortWith", () => {
  it("configures the line with one stty argument vector: raw 8N1, no flow control, no carrier", async () => {
    const { run, calls } = runnerRecording();
    const path = device();
    const port = await openPortWith(run, { clock: handWound() })(path, 115200);
    await port.close();

    // Every token earns its place; `serial.ts`'s own `sttyArgv` comment is
    // where each one's kernel path is written out. The short of it: termios
    // survives a close and `raw` never touches `c_cflag`, so everything in
    // the `c_cflag` group here is defence against the state some previous
    // consumer left the port in — and `-drain` is defence against `stty`
    // itself never getting far enough to apply them.
    //
    // `raw` comes before `min 0 time 0` because it sets `min 1 time 0`
    // itself and stty applies its arguments left to right.
    expect(calls).toEqual([[
      "stty", "-F", path, "-drain",
      "raw", "-echo", "cread", "clocal", "-crtscts", "cs8", "-parenb", "-cstopb", "min", "0", "time", "0",
      "115200",
    ]]);
  });

  /**
   * **Without `-drain` this call can block for two minutes.**
   *
   * GNU `stty` applies its settings with `TCSADRAIN` (`stty.c`:
   * `static int tcsetattr_options = TCSADRAIN;`), and `TCSADRAIN` waits for
   * pending output *under the settings the port already has*. A port left in
   * `CRTSCTS` with CTS unasserted — every three-wire link — therefore blocks
   * before the `-crtscts` in the same vector can rescue it. Chicken and egg,
   * and the bill is `RUN_TIMEOUT_MS`: 120 s holding a descriptor, which blows
   * the apply engine's 60 s renderer bound first.
   *
   * Its position is free — coreutils handles it in the argument loop, not in
   * the mode table — so this asserts only that it is there and that it is not
   * the negation of some mode word that happens to share the name.
   */
  it("passes -drain, so stty cannot block on a port left in flow control", async () => {
    const { run, calls } = runnerRecording();
    const port = await openPortWith(run, { clock: handWound() })(device(), 115200);
    await port.close();

    expect(calls[0]).toContain("-drain");
    expect(calls[0]).not.toContain("drain");
  });

  /**
   * **Without `cread` the port is deaf and the sweep blames the wiring.**
   *
   * `raw` does not set `CREAD`, and termios survives a close, so a port a
   * previous consumer left `-cread` stays that way. With `CREAD` clear
   * `pl011_setup_status_masks()` sets `ignore_status_mask |=
   * UART_DUMMY_DR_RX` and `pl011_fifo_to_tty()` ORs that bit into every
   * character, so every byte is discarded before the line discipline sees it:
   * silence at all four rates, on correct wiring, with the operator sent to
   * check pins that are right.
   *
   * It must come after `raw`, which rewrites the other three flag words but
   * never `c_cflag`.
   */
  it("passes cread, so a port left deaf by a previous consumer can hear again", async () => {
    const { run, calls } = runnerRecording();
    const port = await openPortWith(run, { clock: handWound() })(device(), 115200);
    await port.close();

    const argv = calls[0] ?? [];
    expect(argv).toContain("cread");
    expect(argv).not.toContain("-cread");
    expect(argv.indexOf("cread")).toBeGreaterThan(argv.indexOf("raw"));
  });

  // R-SEC: the device path is configuration, and configuration is not
  // trusted input. `-F <device>` puts it in its own argument vector slot,
  // which is also why it cannot be mistaken for an option however it begins.
  it("passes the device as one argument, so no part of it can reach a shell", async () => {
    const { run, calls } = runnerRecording();
    const dir = tempDir();
    const path = join(dir, "tty0; echo pwned $(id) && rm -rf * | cat > x");
    writeFileSync(path, "");
    const port = await openPortWith(run, { clock: handWound() })(path, 57600);
    await port.close();

    expect(calls[0]?.filter((arg) => arg === path)).toEqual([path]);
    expect(calls[0]?.[0]).toBe("stty");
    expect(calls[0]).not.toContain("-c");
  });

  it("opens the device before it configures it, so a node that is not there costs no subprocess", async () => {
    const { run, calls } = runnerRecording();
    const path = join(tempDir(), "ttyMISSING");
    await expect(openPortWith(run, { clock: handWound() })(path, 115200)).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([]);
  });

  it("releases the descriptor when stty fails, and names the device, the speed and the reason", async () => {
    const { run } = runnerRecording(() => ({ code: 1, stdout: "", stderr: "stty: 'standard input': Inappropriate ioctl for device\n" }));
    const path = device();
    const open = openPortWith(run, { clock: handWound() });

    await expect(open(path, 230400)).rejects.toThrow(/Inappropriate ioctl/);
    await expect(open(path, 230400)).rejects.toThrow(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*230400`));

    // Fifty failures, not one: a leaked descriptor per failure is
    // unmistakable, and a test worker's own file handles make an exact delta
    // meaningless. Without the close on this path the growth is fifty.
    const before = descriptorCount();
    for (let i = 0; i < 50; i++) await open(path, 230400).catch(() => {});
    expect(descriptorCount() - before).toBeLessThan(10);
  });
});

describe("settleAndFlush", () => {
  it("discards what was already buffered before the rate changed", async () => {
    const { run } = runnerRecording();
    const port = await openPortWith(run, { clock: handWound() })(device("bytes from the rate before this one"), 115200);

    await port.settleAndFlush();

    expect((await port.read(100)).bytes).toHaveLength(0);
    await port.close();
  });

  /**
   * The bench's own failure, made into a test.
   *
   * The first measurement on a board reported **two checksum-valid heartbeats
   * at a rate that cannot produce them**: the probe flushed, and only then let
   * the new rate settle, so bytes still draining from the old rate were
   * attributed to the new one. Detection confidently naming the wrong speed,
   * having genuinely seen a valid frame, is the worst failure available here.
   *
   * `onWait` appends during the settle. A flush that ran *before* the settle
   * — or no flush at all — leaves those bytes readable and this test fails.
   */
  it("settles first, so bytes arriving during the settle are discarded too", async () => {
    const { run } = runnerRecording();
    const path = device();
    let armed = true;
    const clock = handWound(() => {
      if (!armed) return;
      armed = false;
      appendFileSync(path, "the old rate, still draining");
    });
    const port = await openPortWith(run, { clock })(path, 115200);

    await port.settleAndFlush();

    expect(clock.waits[0]).toBe(SETTLE_MS);
    expect((await port.read(0)).bytes).toHaveLength(0);
    await port.close();
  });

  /**
   * **The one failure this module exists to prevent, and the one place it can
   * happen anyway.**
   *
   * The flush is bounded at `FLUSH_MAX_READS` x `READ_BYTES` — 512 KiB, about
   * 5.6 s of traffic at 921600 baud against a 50 ms settle — so a legitimate
   * flush never reaches it. A flush that *does* reach it has stopped
   * guaranteeing the thing the settle-then-flush order buys: bytes sent at
   * the previous speed survive into this speed's window, and detection can
   * name a baud on evidence that belongs to another one.
   *
   * Giving up on that silently leaves nothing anywhere to read afterwards, so
   * it is said. Deleting the log line makes this test fail.
   */
  it("says so when the line will not go quiet, rather than giving up in silence", async () => {
    const { run } = runnerRecording();
    // More than 64 reads of 8 KiB, so every read in the bound comes back
    // full and the drain runs out of attempts rather than out of bytes.
    const path = device("x".repeat(600 * 1024));
    const said: string[] = [];
    const port = await openPortWith(run, { clock: handWound(), log: (line) => { said.push(line); } })(path, 115200);

    await port.settleAndFlush();

    expect(said.join("\n")).toMatch(/would not go quiet/);
    // Named, because a board sweeps two devices and a line that does not say
    // which one is a line an operator cannot act on.
    expect(said.join("\n")).toContain(path);
    await port.close();
  });

  it("says nothing at all about a flush that finished", async () => {
    const { run } = runnerRecording();
    const said: string[] = [];
    const port = await openPortWith(run, { clock: handWound(), log: (line) => { said.push(line); } })(
      device("a little stale traffic"), 115200,
    );

    await port.settleAndFlush();

    expect(said).toEqual([]);
    await port.close();
  });

  it("keeps every byte that arrives after the flush", async () => {
    const { run } = runnerRecording();
    const path = device("stale");
    const port = await openPortWith(run, { clock: handWound() })(path, 115200);

    await port.settleAndFlush();
    appendFileSync(path, "fresh");

    expect(text((await port.read(100)).bytes)).toBe("fresh");
    await port.close();
  });
});

describe("read", () => {
  it("returns what has arrived and then nothing more", async () => {
    const { run } = runnerRecording();
    const path = device("AB");
    const clock = handWound();
    const port = await openPortWith(run, { clock })(path, 115200);

    expect(text((await port.read(100)).bytes)).toBe("AB");
    // Bytes already waiting are returned without spending the window on them.
    expect(clock.waits).toEqual([]);
    expect((await port.read(0)).bytes).toHaveLength(0);
    await port.close();
  });

  it("returns only what arrived inside its window", async () => {
    const { run } = runnerRecording();
    const path = device();
    let armed = false;
    const clock = handWound(() => {
      if (!armed) return;
      armed = false;
      appendFileSync(path, "inside");
    });
    const port = await openPortWith(run, { clock })(path, 115200);

    // Nothing on the wire: the window is spent and no bytes are reported.
    const first = await port.read(100);
    expect(first.bytes).toHaveLength(0);
    expect(clock.at()).toBeGreaterThanOrEqual(100);

    // Something arrives partway through the next window, and only that.
    armed = true;
    appendFileSync(path, "");
    expect(text((await port.read(100)).bytes)).toBe("inside");

    // What arrives after the window closed belongs to the window after it.
    appendFileSync(path, "after");
    expect(text((await port.read(100)).bytes)).toBe("after");
    await port.close();
  });

  /**
   * `framingErrors` is always `0`, and that is a property of the runtime
   * rather than an omission: counting them needs the `TIOCGICOUNT` ioctl,
   * which Node cannot issue, and this milestone chose `stty` and `fs` over a
   * compiled dependency (the board has 905 MiB and no swap).
   *
   * It is safe because `detect()` treats framing errors as **sufficient**
   * evidence of a wrong rate and never as necessary — the bench measured
   * 921600 producing zero framing errors and zero frames — so the sweep falls
   * back to its measured per-rate deadline.
   *
   * And it costs **time, not R-MAV-13's distinction**: a framing-errored byte
   * is still delivered as ordinary data under this module's `stty` vector
   * (`raw` clears `INPCK`, so the flag is masked off the character before
   * anything tests it), so the wire that produces them still reports as
   * `noise`. What is lost is `detect()`'s early exit from a wrong rate. The
   * counter is not out of reach for ever either — `/proc/tty/driver/ttyAMA`
   * prints it as `fe:%u` and plain `fs` can read it.
   */
  it("reports no framing errors, because this runtime cannot count them", async () => {
    const { run } = runnerRecording();
    const port = await openPortWith(run, { clock: handWound() })(device("anything at all"), 115200);

    expect(await port.read(100)).toEqual({ bytes: expect.any(Uint8Array), framingErrors: 0 });
    expect((await port.read(100)).framingErrors).toBe(0);
    await port.close();
  });
});

describe("close", () => {
  /**
   * A directory stands in for a node that opens and then refuses to be read:
   * `open(2)` succeeds on one and `read(2)` answers `EISDIR`, which is the
   * portable way to force a read error with no serial port anywhere near the
   * test. On a board the same shape is `EIO` from a port that went away.
   */
  it("releases the descriptor even when the read threw", async () => {
    const { run } = runnerRecording();
    const path = join(tempDir(), "not-a-port");
    mkdirSync(path);
    const open = openPortWith(run, { clock: handWound() });

    const port = await open(path, 115200);
    await expect(port.read(100)).rejects.toThrow(/EISDIR/);
    await expect(port.close()).resolves.toBeUndefined();

    const before = descriptorCount();
    for (let i = 0; i < 50; i++) {
      const p = await open(path, 115200);
      await p.read(100).catch(() => {});
      await p.close();
    }
    expect(descriptorCount() - before).toBeLessThan(10);
  });

  it("closes twice without complaint", async () => {
    const { run } = runnerRecording();
    const port = await openPortWith(run, { clock: handWound() })(device(), 115200);

    await port.close();
    await expect(port.close()).resolves.toBeUndefined();
  });
});

describe("the opener under detect()", () => {
  it("finds an autopilot that starts talking once the line has settled", async () => {
    const { run } = runnerRecording();
    const path = device("bytes from the rate before this one");
    let waited = 0;
    // Wait 1 is the settle. Wait 2 is the first read's poll, and that is when
    // the autopilot's heartbeat lands — after the flush, so it is the sweep's
    // own evidence and not the previous rate's.
    const clock = handWound(() => {
      if (++waited === 2) appendFileSync(path, Buffer.from(heartbeatV2(1, 1, 3)));
    });

    await expect(detect({ device: path, open: openPortWith(run, { clock }), clock })).resolves.toMatchObject({
      kind: "found", baud: 57600, vehicle: "ArduPlane", system: 1,
    });
  });

  /**
   * K-19, proven with the real opener rather than a fake: a renderer that
   * throws stops every renderer behind it, and a board with nothing on
   * `/dev/ttyAMA0` is the ordinary case, not an exceptional one.
   *
   * `openPortWith` *rejects* for a device that is not there — deliberately,
   * because that is the contract `MavlinkRenderer.probe()` is written to
   * ("a device node that will not open is R-MAV-13's silence for that
   * device"), and it is what keeps `triedBauds` empty: an honest "there was
   * nothing here to sweep" rather than four speeds this device never had.
   * The renderer is where it stops, and this asserts that it does.
   */
  it("leaves a board with no autopilot searching, never failing", async () => {
    const { run } = runnerRecording((argv) => (argv[1] === "is-active"
      ? { code: 3, stdout: "inactive\n", stderr: "" }
      : OK));
    const dir = tempDir();
    const said: string[] = [];
    // The renderer gets `fakeClock`, not `handWound`: this one arms a
    // 30-second retry, and a clock that fires every timer the instant it is
    // set would re-probe for ever inside the test.
    const renderer = new MavlinkRenderer({
      run,
      open: openPortWith(run, { clock: handWound() }),
      confPath: join(dir, "main.conf"),
      hintPath: join(dir, "mavlink-link.json"),
      clock: fakeClock(),
      log: (line) => { said.push(line); },
    });

    // A node that is not there — under the temp directory, so nothing in
    // this test can reach a real /dev.
    const missing = join(dir, "ttyMISSING");
    await expect(renderer.render(ConfigSchema.parse({
      version: 1,
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
      mavlink: { serial: { device: missing } },
    }))).resolves.toBeUndefined();
    renderer.close();

    // Silence with **nothing tried**: the honest difference between "swept
    // four speeds and heard nothing" and "there was nothing here to sweep".
    // The device is still named — an operator needs to know which node was
    // looked at — and no speed is, because none was ever reached.
    expect(renderer.state()).toMatchObject({ phase: "silent", device: missing, baud: null, triedBauds: [] });
    expect(said.join("\n")).toMatch(/could not be opened/);
  });
});
