// SPDX-License-Identifier: GPL-3.0-or-later
import { confirmed, idle, rejected } from "yonder-core";
import type { CommandStatus, ReadingBounds, ReachState, PathReport } from "yonder-core";

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

/** The one line at the top of the Cellular tab, already judged. */
export interface Verdict {
  text: string;
  tone: "good" | "bad" | "neutral";
}

/**
 * The one line at the top of the Cellular tab.
 *
 * Three answers and not two. A path nobody has tested is not claimed to be
 * working — the same distinction the fallback watchdog had to learn, at the
 * display layer (R-CEL-09).
 *
 * The untested case is read off `PathReport.evidence`, which the daemon fills
 * from the same reading of `Standing` that writes the sentence in `detail`.
 * It used to be recovered by matching substrings against that sentence,
 * because `standing` collapses three situations into `standing-by` and the
 * record carried the distinction nowhere else. That coupling made `detail` —
 * prose written for an operator, and reworded once already — load-bearing for
 * a verdict, and it is gone rather than kept as a fallback: a fallback would
 * be an untested path through the one function whose job is not to overclaim.
 *
 * `not-reaching` is bad rather than READY for the same reason `standing-by`
 * alone was never enough. A path whose last probe reached nothing is not
 * ready, whether or not it has run out the three failures that condemn it —
 * the only difference between those two is how much evidence there is, and
 * the operator's answer to both is the same. Saying READY there would also
 * put this line in contradiction with the `Way out` row about the same path.
 */
export function verdict(reach: ReachState): Verdict {
  const modem = reach.paths.find((p) => p.path === "modem");
  if (modem === undefined) return { text: "NO MODEM", tone: "neutral" };
  if (modem.standing === "no-route-out") return { text: "NO DATA GETTING THROUGH", tone: "bad" };
  if (modem.standing === "in-use") return { text: "CARRYING TRAFFIC", tone: "good" };
  if (modem.evidence === "untested") return { text: "NOT YET TESTED", tone: "neutral" };
  if (modem.evidence === "not-reaching") return { text: "NO DATA GETTING THROUGH", tone: "bad" };
  return { text: "READY", tone: "good" };
}

/**
 * The same verdict, in the language the annunciator reads (R-UI-11, ADR-0005).
 *
 * `ui-yonder-annunciator` renders a `CommandStatus` and decides nothing —
 * that is what stops a lamp meaning one thing on the Network page and another
 * on Status. A link verdict is not a command, but it is exactly the kind of
 * thing that lamp exists for, so it is said in the language that already
 * exists rather than given a second one.
 *
 * It is here, and not in a `change` node in `flows.json`, because mapping a
 * tone onto a state is a decision, and a decision serialised beside wire
 * coordinates cannot be reviewed (CLAUDE.md rule 2).
 *
 * `message` carries the verdict's own words, so the lamp says
 * `CARRYING TRAFFIC` rather than `Confirmed`: the annunciator prefers the
 * message over the state's generic label.
 */
export function verdictStatus(v: Verdict, at: number): CommandStatus {
  if (v.tone === "good") return confirmed(v.text, { at });
  if (v.tone === "bad") return rejected(v.text, { at });
  // Neutral: nothing has established anything either way, which is exactly
  // what `idle` means — never a green lamp on the strength of no evidence.
  return idle(at, v.text);
}

/**
 * A radio technology as a page shows it.
 *
 * ModemManager reports an identifier — `lte`, `5gnr`, `umts` — and an
 * identifier printed in a readout is a tell that nothing looked at it. These
 * are initialisms, so they are shown as initialisms.
 *
 * It is here rather than in the node that builds the payload because this
 * file is the one place in this package that decides how a value is written,
 * and a second such place is how two surfaces end up disagreeing about the
 * same modem.
 */
export function formatTechnology(value: string | null): string | null {
  return value === null || value === "" ? null : value.toUpperCase();
}

/** The sentence under a path's name on the Way out panel. Already in Yonder's words. */
export function pathDetail(p: PathReport): string {
  return p.detail;
}
