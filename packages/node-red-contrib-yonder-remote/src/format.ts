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
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
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
export function formatLastHeard(lastHeardMs: number | null, now: number = Date.now()): string | null {
  if (lastHeardMs === null) return null;
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
