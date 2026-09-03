// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Presentation arithmetic for the mesh tab (R-VPN-10).
 *
 * Small, pure, and tested directly rather than only through `messageFor` —
 * this is exactly the kind of thing that stays quietly wrong for years,
 * because a unit or a rounding mistake in a display string never throws.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * Bytes, at 1024 steps, the way an operator reads them rather than the way a
 * kernel counter reports them.
 *
 * No decimal below MB — a whole number of kilobytes reads at a glance — and
 * exactly one from MB up, always, so `1048576` prints `1.0 MB` rather than
 * `1 MB`: the tier is not allowed to look more precise than it is.
 */
export function formatBytes(bytes: unknown): string | null {
  // Anything that is not a finite number is *unknown*, not zero. This takes
  // `unknown` on purpose: the value crosses a process boundary from a daemon
  // that may be older than this console, and a field that daemon has never
  // heard of arrives as `undefined`. Reading `.toFixed` off that threw, and
  // Node-RED does not contain the throw — it exits, systemd restarts it, and
  // the console crash-loops. A board did exactly that, four restarts deep,
  // during an upgrade window where the console was newer than the daemon.
  // Nothing on this device may cost the operator the interface (CLAUDE.md
  // rule 6, and the spirit of R-CFG-09).
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

const BIT_UNITS = ["bps", "kbps", "Mbps", "Gbps"] as const;

/**
 * A rate, at 1000 steps - **not 1024**.
 *
 * `formatBytes` above steps at 1024 because a byte count is a memory
 * quantity. This is a network quantity, and every network standard has
 * always quoted its speed in decimal: a "1 Gbps" link moves 1,000,000,000
 * bits per second, not 2^30. Reusing the byte divisor here is the classic
 * mistake in this exact spot, and it is a quiet one - every reading still
 * prints a plausible number, just one that drifts further from the truth as
 * the rate climbs into Mbps and Gbps.
 *
 * Otherwise the same shape as `formatBytes`, for the same reason: no decimal
 * below the first step so a whole rate reads at a glance, and exactly one
 * from Mbps up so the tier never looks more precise than it is.
 *
 * `unknown` on purpose, and `null` for anything not a finite number - see
 * `formatBytes`'s own comment for why: this value crosses a process boundary
 * from a daemon that may be older than this console, and a field that daemon
 * has never heard of must read as unknown rather than throw.
 */
export function formatRate(bitsPerSecond: unknown): string | null {
  if (typeof bitsPerSecond !== "number" || !Number.isFinite(bitsPerSecond)) return null;
  let value = bitsPerSecond;
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < BIT_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BIT_UNITS[unit]}`;
}

/**
 * How long ago, in the words an operator reads rather than a millisecond
 * count (R-VPN-10: "when the device was last heard from").
 *
 * `now` is a parameter rather than a call to `Date.now()` in here, so a test
 * holds time still instead of racing the wall clock. `null` in is `null` out
 * — "never heard from" and "just now" are opposite facts, and guessing
 * between them is exactly the kind of lie R-VPN-10 exists to stop (a `0 ms`
 * latency would be the same mistake).
 */
export function formatLastHeard(lastHeardMs: unknown, now: number = Date.now()): string | null {
  if (typeof lastHeardMs !== "number" || !Number.isFinite(lastHeardMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - lastHeardMs) / 1000));
  if (elapsedSeconds < 10) return "just now";
  if (elapsedSeconds < 60) return `${String(elapsedSeconds)} s ago`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} d ago`;
}

/**
 * How long a stretch of samples covers, in the words a caption uses.
 *
 * Whole units only: a sparkline's span is context, not a measurement, and
 * "last 2 min" is read at a glance where "last 1.97 min" is read twice.
 */
export function formatSpan(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `last ${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `last ${String(minutes)} min`;
  return `last ${String(Math.round(minutes / 60))} h`;
}
