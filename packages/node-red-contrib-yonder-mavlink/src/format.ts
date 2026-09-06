// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Presentation arithmetic for the Telemetry page (R-MAV-10).
 *
 * Small, pure, and tested directly rather than only through the messages
 * that use it — `node-red-contrib-yonder-remote`'s own `format.ts` docstring
 * says why: a unit or a rounding mistake in a display string stays quietly
 * wrong for years, because it never throws.
 *
 * None of this reuses `formatBytes`/`formatRate` from the remote package's
 * `format.ts`. That file is not exported from `yonder-core` — it belongs to
 * a sibling contrib package, not to the library both packages sit on — and
 * its units are the wrong ones here besides: MAVLink's own numbers are
 * already in the units an operator reads (a baud rate, kilobytes per second
 * off the router's own counters, a fractional second off a heartbeat
 * timestamp), and re-deriving a bits-per-second ladder for a kB/s reading
 * `mav/check.ts` already chose would be the exact drift both files' own
 * comments warn about.
 */

/**
 * A baud rate, thousands-grouped with a plain space — "57600" reads as one
 * long digit string at arm's length, and grouping it is what turns it back
 * into a number.
 *
 * A plain ASCII space, not the thin space (U+2009) the pre-built mockups
 * used: `flows/flows.json`'s own mock for `tel-speed` is `"57 600 baud"`,
 * byte-checked, and the built page wins over a mockup that predates it.
 *
 * `unknown` in, `null` out for anything that is not a finite number — the
 * same reasoning `yonder-core`'s `formatBytes`/`formatRate` give at length:
 * this value crosses a process boundary from a daemon that may be older
 * than this console, and a field that daemon has never heard of arrives as
 * `undefined` rather than a number.
 */
export function formatBaud(baud: unknown): string | null {
  if (typeof baud !== "number" || !Number.isFinite(baud)) return null;
  return Math.trunc(baud).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * How long ago, or how long since, to one decimal place — "0.4 s", never
 * "just now" or a tier of minutes.
 *
 * Deliberately not `node-red-contrib-yonder-remote`'s `formatLastHeard`,
 * whose minutes/hours/days ladder is right for a mesh link an operator
 * checks once in a while. A MAVLink heartbeat is nominally 1 Hz
 * (`HEARTBEAT_STALE_MS` in `mav/check.ts` calls three missed beats — three
 * seconds — a broken link), so the readings this page cares about are
 * sub-second, and `mav/check.ts`'s own (private) `seconds()` helper already
 * settled the convention for the same measurement: one decimal, always in
 * seconds, no tiering. This mirrors it so the page reads one way.
 */
export function formatSeconds(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * A traffic rate in the router's own unit — kilobytes per second, one
 * decimal place, never stepped up to MB/s.
 *
 * `LinkState.traffic.rx`/`.tx` are already kB/s (`mav/link.ts`'s own
 * docstring: the router's coarse integer counter, never a bytes-per-message
 * conversion). `mav/check.ts`'s `outboundLink` already chose this exact
 * rendering for the same number — `${leaving.toFixed(1)} kB/s leaving` — so
 * this mirrors it rather than reaching for `formatRate`'s bits-per-second,
 * stepped-unit ladder, which would be a second, disagreeing opinion about a
 * rate the page already has one true reading for.
 */
export function formatKbRate(kbPerSecond: unknown): string | null {
  if (typeof kbPerSecond !== "number" || !Number.isFinite(kbPerSecond)) return null;
  return `${kbPerSecond.toFixed(1)} kB/s`;
}

/**
 * How much time a sparkline's samples cover, in the words a caption uses.
 *
 * Identical in shape to the remote package's own `formatSpan` — whole units
 * only, because a sparkline's span is context rather than a measurement —
 * kept as this package's own copy rather than an import, the same way
 * `formatKbRate` is not `formatRate`: each contrib package is a thin adapter
 * over `yonder-core` on its own, not over a sibling contrib package.
 */
export function formatSpan(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `last ${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `last ${String(minutes)} min`;
  return `last ${String(Math.round(minutes / 60))} h`;
}
