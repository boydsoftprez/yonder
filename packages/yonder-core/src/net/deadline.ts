// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";

/**
 * Bound a promise on the injected clock, with an answer for when it is late.
 *
 * **A hang is not a throw, and a `try`/`catch` does not cover one.** Every
 * loop in this daemon that questions the outside world is already careful
 * about rejection; none of them was careful about an answer that simply never
 * arrives. A wedged ModemManager on a D-Bus call is an everyday failure mode
 * for a USB modem that enumerated badly — `mmcli -L` returns nothing, ever —
 * and an `await` on it stops whatever was waiting for good, with nothing
 * logged and no timer left to fire.
 *
 * The clock is injected for the same reason it is everywhere else: nothing
 * here may wait on the wall clock, in production or in a test.
 *
 * `late` supplies the answer rather than throwing one, so each caller states
 * its own safe direction at the point where it knows what that is. The
 * abandoned promise is left to settle on its own; its rejection is handled
 * here, so an outcome that arrives too late is discarded rather than becoming
 * an unhandled rejection.
 */
export function withDeadline<T>(
  clock: Clock,
  ms: number,
  work: Promise<T>,
  late: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = clock.setTimer(ms, () => {
      if (settled) return;
      settled = true;
      try {
        resolve(late());
      } catch (e) {
        reject(e as Error);
      }
    });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clock.clearTimer(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clock.clearTimer(timer);
        reject(error as Error);
      },
    );
  });
}
