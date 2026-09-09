// SPDX-License-Identifier: GPL-3.0-or-later
/** Bound drawing to 60 Hz without drifting to 20/30 Hz at frame boundaries. */
export function frameCadence(hz = 60) {
  const period = 1000 / hz;
  let last = null;
  return time => {
    if (last === null || time < last) { last = time; return true; }
    const elapsed = time - last;
    if (elapsed < period - 0.5) return false;
    last += Math.max(1, Math.floor((elapsed + 0.5) / period)) * period;
    return true;
  };
}
