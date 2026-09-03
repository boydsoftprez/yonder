// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReadingBounds, ReachState, PathReport } from "yonder-core";

/**
 * Where an operator is told to start worrying about signal strength.
 *
 * The standard cellular thresholds, deliberately: a number that looks
 * alarming here has to look alarming in every other tool an operator might
 * check, including a carrier's support desk. A scale tuned to this project
 * would disagree with all of them.
 *
 * The floor and ceiling are the ends of the useful range rather than the ends
 * of what a modem can report — a reading is clamped, so nothing is lost, and
 * a scale running to -140 would spend most of its width on values that mean
 * "no service" either way.
 */
export const SIGNAL_BOUNDS: ReadingBounds = {
  min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better",
};

/** SINR, in dB. Above 13 is good; below 0 the link is not usable. */
export const QUALITY_BOUNDS: ReadingBounds = {
  min: -5, max: 25, caution: 13, limit: 0, sense: "higher-is-better",
};

/**
 * A measurement, or a mark saying it was not taken.
 *
 * Never a zero: 0 dBm is a real and extraordinary reading, and printing it
 * for "unknown" would show a perfect signal on a device that has none.
 */
export function formatDbm(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} dBm`;
}

export function formatDb(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} dB`;
}

/**
 * The one line at the top of the Cellular tab.
 *
 * Three answers and not two. A path nobody has tested is not claimed to be
 * working — the same distinction the fallback watchdog had to learn, at the
 * display layer (R-CEL-09).
 *
 * The untested case is read off `detail` rather than off `standing`, because
 * `standing-by` covers three different situations (a path that is reaching
 * something, one whose probes are failing but has not yet been condemned,
 * and one nothing has ever probed) and `PathReport` carries that distinction
 * nowhere else. `monitor.ts`'s `standingByDetail` writes "not yet tested"
 * for the untested case; both substrings are checked so a short fixture
 * ("untested") and the daemon's own sentence both land here.
 */
export function verdict(reach: ReachState): { text: string; tone: "good" | "bad" | "neutral" } {
  const modem = reach.paths.find((p) => p.path === "modem");
  if (modem === undefined) return { text: "NO MODEM", tone: "neutral" };
  if (modem.standing === "no-route-out") return { text: "NO DATA GETTING THROUGH", tone: "bad" };
  if (modem.standing === "in-use") return { text: "CARRYING TRAFFIC", tone: "good" };
  if (modem.detail.includes("not yet tested") || modem.detail.includes("untested")) {
    return { text: "NOT YET TESTED", tone: "neutral" };
  }
  return { text: "READY", tone: "good" };
}

/** The sentence under a path's name on the Way out panel. Already in Yonder's words. */
export function pathDetail(p: PathReport): string {
  return p.detail;
}
