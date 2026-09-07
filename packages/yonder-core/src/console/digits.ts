// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One digit-grouping decision, kept in one place so it cannot be made twice
 * (R-MAV-10, R-DIA-04).
 *
 * **Why this file exists at all.** The Telemetry page shows the same
 * measurement — `LinkState.baud` — in two places: the Autopilot panel's
 * Speed reading, built by `node-red-contrib-yonder-mavlink/src/format.ts`
 * (`formatBaud`), and the path check's own "Autopilot to Yonder" sentence,
 * built by this package's `mav/check.ts`. Each grew its own way of turning
 * `57600` into something a person can read at a glance: `format.ts` grouped
 * the thousands with a space, and `check.ts` reached for plain
 * `String(state.baud)`. The result was one board reading "57 600 baud" in
 * the Autopilot panel and "57600 baud" a few pixels away in the rail's path
 * check, for the exact same link.
 *
 * `mav/check.ts` cannot import `format.ts` to fix it — a contrib package
 * sits on `yonder-core`, never the other way around, so the dependency
 * needed runs backwards. `yonder-core/presentation` (re-exported from
 * `console/presentation.ts`) is where a decision like this already lives:
 * `command.ts` and `reading.ts` are the precedent, each written once because
 * a node and a Vue component both had to reach the same answer about a
 * command's state or a gauge's band. This is the same shape of problem, one
 * level down — two *nodes*, on either side of the same package boundary,
 * needing to reach the same answer about a number — so it belongs in the
 * same place for the same reason.
 */

/**
 * Thousands-grouped with a plain ASCII space — "57600" reads as one long
 * digit string at arm's length, and grouping it is what turns it back into
 * a number.
 *
 * A plain space, not the thin space (U+2009) an early mockup used: the
 * built page's own wiring settled on an ordinary one
 * (`node-red-contrib-yonder-mavlink/src/format.test.ts` byte-checked it
 * against `flows/flows.json` before the mocks in that file were retired),
 * and every caller of this function follows the built page.
 *
 * Takes a `number`, not `unknown`. The arithmetic alone is what both
 * callers had duplicated; each keeps its own guard for whatever shape its
 * own boundary can hand it — `format.ts`'s `formatBaud` still turns an
 * unknown or non-finite value into `null` before anything reaches here,
 * because that daemon-boundary judgement is `format.ts`'s to make, and
 * `check.ts` already has a measured `LinkState.baud` in hand. Neither
 * caller's guard belongs here, or it would be a second copy of one of them.
 */
export function groupThousands(value: number): string {
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
