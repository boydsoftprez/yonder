// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { detect, type OpenPort } from "./detect.js";
import { heartbeatV2, validSysStatusBytes, fakeClock } from "./testing.js";

/** A port that answers with whatever the table says for the baud it was opened at. */
function portsAnswering(table: Record<number, { bytes: Uint8Array; framingErrors: number }>): { open: OpenPort; opened: number[] } {
  const opened: number[] = [];
  const open: OpenPort = async (_device, baud) => {
    opened.push(baud);
    return {
      settleAndFlush: async () => {},
      read: async () => table[baud] ?? { bytes: new Uint8Array(0), framingErrors: 0 },
      close: async () => {},
    };
  };
  return { open, opened };
}

describe("detect", () => {
  it("finds the autopilot and names the vehicle and speed", async () => {
    const { open } = portsAnswering({ 57600: { bytes: heartbeatV2(1, 1, 3), framingErrors: 0 } });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() })).resolves.toMatchObject({
      kind: "found", baud: 57600, vehicle: "ArduPlane", system: 1,
    });
  });

  it("stops at the first good frame and never opens the rates behind it", async () => {
    const { open, opened } = portsAnswering({ 115200: { bytes: heartbeatV2(1, 2, 3), framingErrors: 0 } });
    await detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() });
    expect(opened).toEqual([57600, 115200]);
  });

  // The bench note this design follows found the failure this guards against:
  // skipping — or reordering — settle-and-flush after a rate change let bytes
  // buffered at the old rate be attributed to the new one, and the first
  // attempt reported two CRC-valid heartbeats at a rate that cannot produce
  // them. A test that only counted the call would still pass if the flush
  // moved to after the first read, which is the same bug — so this checks
  // order, per port, not just presence.
  it("settles and flushes every port before that port's first read", async () => {
    const events: Array<["settle" | "read", number]> = [];
    const settles: ReturnType<typeof vi.fn>[] = [];
    let index = -1;
    const open: OpenPort = async () => {
      const port = ++index;
      const settle = vi.fn(async () => {
        events.push(["settle", port]);
      });
      settles.push(settle);
      return {
        settleAndFlush: settle,
        read: async () => {
          events.push(["read", port]);
          return { bytes: new Uint8Array(0), framingErrors: 0 };
        },
        close: async () => {},
      };
    };

    await detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() });

    expect(settles).toHaveLength(4); // one port per default baud, all silent
    for (const settle of settles) expect(settle).toHaveBeenCalledTimes(1);

    for (let port = 0; port < settles.length; port++) {
      const settleAt = events.findIndex(([kind, p]) => kind === "settle" && p === port);
      const firstReadAt = events.findIndex(([kind, p]) => kind === "read" && p === port);
      expect(settleAt).toBeGreaterThan(-1);
      expect(firstReadAt).toBeGreaterThan(-1);
      expect(settleAt).toBeLessThan(firstReadAt);
    }
  });

  it("tries a remembered speed first, then the rest in order", async () => {
    const { open, opened } = portsAnswering({});
    await detect({ device: "/dev/ttyAMA0", open, first: 921600, clock: fakeClock() });
    expect(opened).toEqual([921600, 57600, 115200, 230400, 921600]);
  });

  it("orders triedBauds with the remembered speed first when nothing is found at all", async () => {
    const { open } = portsAnswering({});
    await expect(detect({ device: "/dev/ttyAMA0", open, first: 921600, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "silent", triedBauds: [921600, 57600, 115200, 230400] });
  });

  it("reports silence when no bytes arrive anywhere — the wiring case", async () => {
    const { open } = portsAnswering({});
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() })).resolves.toMatchObject({
      kind: "silent", triedBauds: [57600, 115200, 230400, 921600],
    });
  });

  it("reports noise when bytes arrive everywhere and nothing ever parses (R-MAV-13)", async () => {
    const junk = { bytes: Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff), framingErrors: 40 };
    const { open } = portsAnswering({ 57600: junk, 115200: junk, 230400: junk, 921600: junk });
    // The byte count is whatever the deadline read, which depends on the slice
    // size — so assert the *kind* and that something arrived, never a total the
    // fake would have to be counted by hand to predict.
    const outcome = await detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() });
    expect(outcome.kind).toBe("noise");
    expect((outcome as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  // A port that delivers nothing but counts framing errors is not silent —
  // and calling it silent sends an operator to check a wire that is
  // connected. Measured on a board: the wrong rates threw 1071 and 2482
  // framing errors in four seconds.
  //
  // **This exact shape is unreachable through `mav/serial.ts`, and the
  // outcome it stands for is not.** That opener reports `framingErrors: 0`
  // always — Node cannot issue `TIOCGICOUNT` — but a framing-errored byte is
  // still *delivered*: `stty raw` clears `INPCK`, so the pl011 driver leaves
  // `UART011_DR_FE` out of `read_status_mask`, the flag is masked off the
  // character before anything tests it, and `uart_insert_char()` inserts the
  // byte regardless. So the same wire arrives here as bytes with zero errors
  // — which is the *noise* case above, reached by the other route. What is
  // actually lost is the early exit: with no error count, `detect()` cannot
  // leave a wrong rate the moment its errors appear and pays the full
  // per-rate deadline instead.
  //
  // The test stays, and it is not a museum piece: it is `detect()` under test
  // here, and an opener that can count framing errors — see `serial.ts` on
  // `/proc/tty/driver/ttyAMA` — must get exactly this behaviour.
  it("calls framing errors with no delivered bytes noise, not silence", async () => {
    const errs = { bytes: new Uint8Array(0), framingErrors: 120 };
    const { open } = portsAnswering({ 57600: errs, 115200: errs, 230400: errs, 921600: errs });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "noise" });
  });

  it("ignores a ground station's heartbeat when looking for an autopilot", async () => {
    const { open } = portsAnswering({ 57600: { bytes: heartbeatV2(255, 6, 8), framingErrors: 0 } });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "noise" });
  });

  // The right rate leads with attitude and status far more often than with a
  // heartbeat. A rule that gave up after two unproductive reads abandoned it.
  it("keeps reading a rate that is producing valid non-heartbeat traffic", async () => {
    const sysStatus = validSysStatusBytes();
    let call = 0;
    const open: OpenPort = async () => ({
      settleAndFlush: async () => {},
      read: async () => (call++ < 4
        ? { bytes: sysStatus, framingErrors: 0 }
        : { bytes: heartbeatV2(1, 1, 3), framingErrors: 0 }),
      close: async () => {},
    });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "found", baud: 57600 });
  });

  /**
   * **A fault partway through must not erase what came before it.**
   *
   * A `read` rejection used to escape the rate loop entirely, so every byte
   * the rates already swept had heard was thrown away with it — and
   * `MavlinkRenderer.probe()` turns an escaping fault into R-MAV-13 silence.
   * An operator whose wire was demonstrably noisy at the first rate would be
   * told "nothing transmitting, check the pins", which is the precise
   * misdiagnosis R-MAV-13 exists to prevent. Plausible on a USB autopilot
   * being unplugged, which is exactly when the pins are not the problem.
   */
  it("reports what earlier rates heard when the port goes away mid-sweep (R-MAV-13)", async () => {
    const junk = { bytes: Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff), framingErrors: 0 };
    const opened: number[] = [];
    const closed: number[] = [];
    const open: OpenPort = async (_device, baud) => {
      opened.push(baud);
      return {
        settleAndFlush: async () => {},
        read: async () => {
          if (baud !== 57600) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
          return junk;
        },
        close: async () => { closed.push(baud); },
      };
    };

    const outcome = await detect({ device: "/dev/ttyACM0", open, clock: fakeClock() });

    expect(outcome.kind).toBe("noise");
    expect((outcome as { bytes: number }).bytes).toBeGreaterThan(0);
    // The rate that faulted was tried; the two behind it were not, and saying
    // they were would be the other half of the same lie.
    expect((outcome as { triedBauds: number[] }).triedBauds).toEqual([57600, 115200]);
    expect(opened).toEqual([57600, 115200]);
    // Still released, both of them — the fault is held past the `finally`,
    // not thrown through it.
    expect(closed).toEqual([57600, 115200]);
  });

  // The same shape one step earlier: the node itself disappears, so the next
  // `open` is what fails rather than the next `read`.
  it("reports what earlier rates heard when the next open fails outright", async () => {
    const junk = { bytes: Uint8Array.from({ length: 200 }, (_, i) => (i * 11) & 0xff), framingErrors: 0 };
    const open: OpenPort = async (_device, baud) => {
      if (baud !== 57600) throw new Error("ENOENT: no such file or directory, open '/dev/ttyACM0'");
      return {
        settleAndFlush: async () => {},
        read: async () => junk,
        close: async () => {},
      };
    };

    const outcome = await detect({ device: "/dev/ttyACM0", open, clock: fakeClock() });
    expect(outcome.kind).toBe("noise");
    expect((outcome as { triedBauds: number[] }).triedBauds).toEqual([57600, 115200]);
  });

  /**
   * And the fault is still a fault when nothing has been heard yet.
   *
   * That is the contract every `OpenPort` in this repository is written to:
   * `MavlinkRenderer.probe()` catches it and reports R-MAV-13 silence with an
   * **empty** `triedBauds` — the honest "there was nothing here to sweep",
   * rather than four speeds a device that is not there was never tried at.
   * Swallowing it here would take the reason out of the journal as well.
   */
  it("still fails outright when the port goes away before anything was heard", async () => {
    const open: OpenPort = async () => ({
      settleAndFlush: async () => {},
      read: async () => { throw new Error("EIO: i/o error, read"); },
      close: async () => {},
    });
    await expect(detect({ device: "/dev/ttyACM0", open, clock: fakeClock() })).rejects.toThrow(/EIO/);
  });

  // A sweep that stopped early and a sweep that finished produce the same
  // shape of answer, so the difference has to be said somewhere or it is lost.
  it("says when a sweep was cut short, and on which device", async () => {
    const junk = { bytes: Uint8Array.from({ length: 64 }, (_, i) => i), framingErrors: 0 };
    const open: OpenPort = async (_device, baud) => ({
      settleAndFlush: async () => {},
      read: async () => {
        if (baud !== 57600) throw new Error("EIO: i/o error, read");
        return junk;
      },
      close: async () => {},
    });
    const said: string[] = [];

    await detect({ device: "/dev/ttyACM0", open, clock: fakeClock(), log: (line) => { said.push(line); } });

    expect(said.join("\n")).toMatch(/stopped answering partway through the sweep/);
    expect(said.join("\n")).toContain("/dev/ttyACM0");
    expect(said.join("\n")).toContain("EIO");
  });

  // opts.bauds is part of the public interface but no scenario above ever
  // sets it, so nothing else here would catch triedBauds silently reporting
  // the module's default sweep instead of the sweep this call actually used.
  it("reports the bauds actually swept, not the module default, when given a custom list", async () => {
    const { open } = portsAnswering({});
    await expect(detect({ device: "/dev/ttyAMA0", open, bauds: [9600, 4800], clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "silent", triedBauds: [9600, 4800] });
  });
});
