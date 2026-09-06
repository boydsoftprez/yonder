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

  // A byte the UART could not frame never reaches the reader, so a port that
  // delivers nothing but counts framing errors is not silent — and calling it
  // silent sends an operator to check a wire that is connected. Measured on a
  // board: the wrong rates threw 1071 and 2482 framing errors in four seconds.
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

  // opts.bauds is part of the public interface but no scenario above ever
  // sets it, so nothing else here would catch triedBauds silently reporting
  // the module's default sweep instead of the sweep this call actually used.
  it("reports the bauds actually swept, not the module default, when given a custom list", async () => {
    const { open } = portsAnswering({});
    await expect(detect({ device: "/dev/ttyAMA0", open, bauds: [9600, 4800], clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "silent", triedBauds: [9600, 4800] });
  });
});
