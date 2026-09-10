// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { MAVLINK_BAUDS } from "../schema/config.js";
import { HeartbeatScanner, describeVehicle } from "./frame.js";

/**
 * The sweep is the only mechanism (§3). A UART has to be told a speed before
 * it can turn a wire into bytes, so there is nothing to sense. Everything
 * worth doing is around it:
 *
 *   - **Leave a wrong speed as soon as it proves wrong.** At a wrong rate
 *     bytes still arrive, and bytes that never parse are proof of a mismatch
 *     in a few hundred milliseconds. The full wait is owed only to a rate at
 *     which nothing at all arrives.
 *   - **Stop on the first good frame.** A checksum that passes is certainty.
 *   - **Say which kind of nothing it was** (R-MAV-13), which is the part an
 *     operator with a wire in the wrong hole actually needs.
 *   - **Keep what was already heard when the port goes away.** A USB
 *     autopilot unplugged mid-sweep ends it, and the rates already swept
 *     still report what they heard: throwing that away turns a demonstrably
 *     noisy wire into "nothing transmitting — check the pins".
 */

/**
 * Each rate gets at least one heartbeat interval before it is given up on.
 *
 * HEARTBEAT is 1 Hz, so a shorter window can miss the right rate entirely —
 * and at the right rate an autopilot sends far more than heartbeats, so
 * "bytes arrived and none of them was a heartbeat" is the ordinary state of
 * affairs for the first second, not evidence of anything. Measured on a
 * board: six consecutive runs at the right rate answered in 874, 746, 746,
 * 753, 739 and 752 ms. A one-second deadline would have missed the first.
 */
const RATE_DEADLINE_MS = 1_300;
/**
 * A rate at which nothing whatever has arrived is abandoned early: silence is
 * the one signal that does not need a heartbeat interval to interpret.
 */
const SILENT_GIVE_UP_MS = 400;
/** Each read returns what is available; it does not block for its window. */
const READ_SLICE_MS = 100;

export interface SerialPort {
  /**
   * Settle, then discard anything buffered from the previous rate.
   *
   * On a board, an ascending sweep reported two checksum-valid heartbeats at a
   * rate that cannot produce them: bytes buffered at the old rate survived the
   * change and were attributed to the new one. That is the worst failure
   * available here — detection confidently naming the wrong baud, having
   * genuinely seen a valid frame — and 50 ms of settling is the whole fix.
   */
  settleAndFlush(): Promise<void>;
  read(ms: number): Promise<{ bytes: Uint8Array; framingErrors: number }>;
  close(): Promise<void>;
}

export type OpenPort = (device: string, baud: number) => Promise<SerialPort>;

/**
 * A second sweep was asked for while one already had the port.
 *
 * Its own type so a route can answer 409 rather than 500 without reaching for
 * the renderer: "already looking" is a state, not a fault, and an operator
 * pressing *Detect again* twice deserves to be told which.
 *
 * Lives here rather than in `renderer.ts` because it belongs to the sweep's
 * vocabulary, and because `daemon/routes.ts` deliberately knows the telemetry
 * layer as an interface rather than as a `MavlinkRenderer`.
 */
export class SweepInProgressError extends Error {
  constructor(message = "a sweep for the flight controller is already running on this device") {
    super(message);
    this.name = "SweepInProgressError";
  }
}

export type DetectOutcome =
  | { kind: "found"; device: string; baud: number; vehicle: string; system: number }
  | { kind: "silent"; device: string; triedBauds: number[] }
  | { kind: "noise"; device: string; triedBauds: number[]; bytes: number };

export async function detect(opts: {
  device: string;
  open: OpenPort;
  bauds?: readonly number[];
  /** A remembered speed, tried before the sweep. Not removed from the sweep:
      if it fails it is retried in its turn, which costs one read and keeps the
      "tried these four" message true. */
  first?: number;
  /** Injected, so no test waits on the wall clock. */
  clock?: Clock;
  /**
   * Said when a sweep is cut short. Injected, because this function has no
   * journal of its own and the caller's prefix is the caller's business.
   */
  log?: (line: string) => void;
}): Promise<DetectOutcome> {
  const sweep = opts.bauds ?? MAVLINK_BAUDS;
  const order = opts.first === undefined ? [...sweep] : [opts.first, ...sweep];
  const clock = opts.clock ?? systemClock;
  const tried: number[] = [];
  let bytesSeen = 0;
  let errorsSeen = 0;

  for (const baud of order) {
    if (!tried.includes(baud)) tried.push(baud);

    let port: SerialPort;
    try {
      port = await opts.open(opts.device, baud);
    } catch (error) {
      // Nothing heard yet, so the fault is the whole story: it goes up, and
      // `MavlinkRenderer.probe()` turns it into R-MAV-13's silence with an
      // empty triedBauds — the honest "there was nothing here to sweep", and
      // the contract every `OpenPort` in this repository is written to.
      if (bytesSeen === 0 && errorsSeen === 0) throw error;
      // But once a rate has heard something, that evidence outranks the
      // fault. Losing it would tell an operator "nothing transmitting —
      // check the pins" about a wire that was demonstrably noisy a second
      // ago, which is the exact misdiagnosis R-MAV-13 exists to prevent.
      opts.log?.(
        `${opts.device} stopped answering partway through the sweep (${(error as Error).message}); `
          + "reporting what was heard before it did",
      );
      break;
    }

    let bytesHere = 0;
    let errorsHere = 0;
    // A fault from settleAndFlush() or read() — an autopilot unplugged from
    // USB is the ordinary way — is held rather than thrown, so the bytes this
    // rate had already gathered can be added below before it is acted on.
    let faulted: unknown = null;
    try {
      // Settling and flushing lives inside the guard it pays for: if a real
      // port's settleAndFlush() throws, close() must still run rather than
      // leaking the port and aborting the whole sweep on the way out.
      await port.settleAndFlush();
      const started = clock.now();
      const scanner = new HeartbeatScanner();

      // A deadline on the clock, not a count of reads. An earlier version gave
      // up after the second read that produced no heartbeat, which abandons
      // the *correct* rate whenever telemetry happens to lead with attitude or
      // status messages — which it usually does.
      while (clock.now() - started < RATE_DEADLINE_MS) {
        const chunk = await port.read(READ_SLICE_MS);
        bytesHere += chunk.bytes.length;
        errorsHere += chunk.framingErrors;
        const vehicle = scanner.push(chunk.bytes).find((h) => h.fromVehicle);
        if (vehicle !== undefined) {
          return { kind: "found", device: opts.device, baud, vehicle: describeVehicle(vehicle), system: vehicle.system };
        }
        // Two signals can be read before the deadline. Silence is one.
        //
        // Framing errors are the other, and they are *sufficient* evidence of a
        // mismatch without being necessary: on a board, 57600 and 230400 threw
        // a thousand and two and a half thousand of them against zero at the
        // rate that worked — but 921600 threw none and carried no frames
        // either, because reading a 115200 signal at eight times its rate
        // samples each bit eight times and the runs frame cleanly as bytes. So
        // errors mean leave now; their absence means wait for the deadline.
        if (errorsHere > 0) break;
        if (bytesHere === 0 && clock.now() - started >= SILENT_GIVE_UP_MS) break;
      }
    } catch (error) {
      faulted = error;
    } finally {
      await port.close();
    }

    // Outside the guard, so it runs on the faulted path too: bytes that
    // arrived before the port went away are still bytes that arrived.
    bytesSeen += bytesHere;
    errorsSeen += errorsHere;

    if (faulted !== null) {
      if (bytesSeen === 0 && errorsSeen === 0) throw faulted;
      opts.log?.(
        `${opts.device} stopped answering partway through the sweep (${(faulted as Error).message}); `
          + "reporting what was heard before it did",
      );
      break;
    }
  }

  // Framing errors count as arrival even when the driver delivered no bytes:
  // a byte the UART could not frame is still something reaching the pin, and
  // reporting that as silence would send an operator to check a wire that is
  // connected.
  //
  // triedBauds is the tracked, deduplicated `tried` list, not the module's
  // MAVLINK_BAUDS constant restated: a caller providing its own `bauds` gets
  // told what was actually swept, not what the default sweep would have
  // been. The two only look interchangeable because no test above ever
  // overrides `bauds`.
  return bytesSeen === 0 && errorsSeen === 0
    ? { kind: "silent", device: opts.device, triedBauds: [...tried] }
    : { kind: "noise", device: opts.device, triedBauds: [...tried], bytes: bytesSeen };
}
