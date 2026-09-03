// SPDX-License-Identifier: GPL-3.0-or-later
import { confirmed, idle, rejected } from "yonder-core";
import type {
  CommandStatus,
  PathEvidence,
  PathReport,
  PathStanding,
  ReachState,
  ReadingBounds,
} from "yonder-core";

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
  // Both ways a board says it has no modem, and they are one answer. The
  // daemon omits the path when configuration does not name one, and reports
  // it `absent` when it does and no interface is there — reading only the
  // first left a board with no modem saying NOT YET TESTED, which is a
  // promise that a test would tell you something (K-40, R-CEL-09).
  if (modem === undefined || modem.standing === "absent") {
    return { text: "NO MODEM", tone: "neutral" };
  }
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
  return lit(v.tone, v.text, at);
}

/**
 * A tone and some words, in the language the annunciator reads.
 *
 * One mapping, used by every lamp this package lights, so the Cellular tab's
 * verdict and a `Way out` row about the same link cannot be drawn from two
 * different rules.
 *
 * Neutral is `idle`: nothing has established anything either way, which is
 * exactly what `idle` means — never a green lamp on the strength of no
 * evidence.
 */
function lit(tone: Verdict["tone"], text: string, at: number): CommandStatus {
  if (tone === "good") return confirmed(text, { at });
  if (tone === "bad") return rejected(text, { at });
  return idle(at, text);
}

/**
 * What a lamp says when the daemon did not answer at all.
 *
 * A tick that fails carries no row for a panel to draw, so a lamp finds
 * nothing on `msg.yonder` and falls back to `presentation("idle")` — whose
 * shared label is `Ready`. Nothing claims success there and the tone is
 * neutral, but the word is wrong at exactly the moment words matter: an
 * operator reading `Ready` beside a blank row has been told the link is fine
 * by a console that has no idea whether it is.
 *
 * **`bad`, not neutral.** Neutral is the lamp `NOT YET TESTED` wears, which is
 * an ordinary standing on a healthy board. A console that cannot reach its own
 * daemon is a fault, and it is the same fault the Cellular tab already draws
 * in red through `readFailure` — two surfaces describing one event have to
 * agree about how bad it is.
 *
 * The words are the honest ones: nothing here says the path is down, only
 * that nothing can be told about it.
 */
export function cannotTell(at: number): CommandStatus {
  return lit("bad", "CANNOT TELL", at);
}

/**
 * The Status page's one-word answer, as the annunciator reads it (R-UI-11).
 *
 * `reachableBy` is `ETHERNET`, `CELLULAR`, `WI-FI` or `NOTHING`, and
 * `reachable` is the *same fact* that chose between them, settled once in
 * `messageFor`. Both arrive here together for one reason, and it is a defect
 * this had before a capture was looked at: the lamp was lit from
 * `ReachState.carrying`, which is deliberately optimistic — it answers true
 * when nothing holds an address at all, because addresses on interfaces this
 * monitor has no path for are not its to condemn. So a board with no path in
 * use drew a **green** lamp on the word `NOTHING`, which is a console
 * disagreeing with itself in the two characters an operator reads first.
 *
 * Nothing here matches the word to work the tone out. Matching would be a
 * second rule for what `NOTHING` means, and a second rule is the one that
 * stops agreeing with the first.
 *
 * `NOTHING` is bad and not neutral. Nothing is getting off this board; the
 * console being readable over the access point is not evidence that the
 * aircraft is reachable, which is the whole question this panel answers.
 */
export function reachStatus(reachableBy: string, reachable: boolean, at: number): CommandStatus {
  return lit(reachable ? "good" : "bad", reachableBy, at);
}

/**
 * The device's own clock, to the minute.
 *
 * Local rather than UTC, and this is the one place in the project where that
 * is right: every other timestamp Yonder writes goes into a log that may be
 * read anywhere, and this one is read standing next to the aircraft by
 * somebody whose watch says the same thing.
 */
function clockTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What `reachWhy` reads. A `PathRow` satisfies it. */
export interface ReachLine {
  name: string;
  standing: PathStanding;
  /** When this path was stood down, epoch ms; null when it has not been. */
  since: number | null;
  inUse: boolean;
}

/**
 * The line under the one-word answer: what changed, and when.
 *
 * It exists because the lamp alone answers the wrong half of the question. An
 * operator reading `CELLULAR` knows *what* is carrying traffic and not *why
 * it is not the wired port*, and that second half is the whole of what a
 * fallback looks like from the outside.
 *
 * **The stood-down path first, and the most recent one**, because that is the
 * event that moved the answer. `since` is non-null only while a path is
 * currently stood down — the record is cleared when it comes back — so this
 * never reports an old outage as news.
 *
 * The other branches are quieter on purpose. When nothing has been taken out
 * of the running there is no event to report, and the honest line is what the
 * board is doing instead. None of them restates the lamp on its own: each
 * adds the fact the lamp cannot carry.
 */
export function reachWhy(paths: ReachLine[]): string {
  // A path that is not on this board has no standing to report.
  const present = paths.filter((p) => p.standing !== "absent");
  if (present.length === 0) return "There is no way out on this board";

  const down = present
    .filter((p) => p.since !== null)
    .sort((a, b) => (b.since as number) - (a.since as number));
  if (down.length > 0) return `${down[0].name} stood down at ${clockTime(down[0].since as number)}`;

  const carrying = present.find((p) => p.inUse);
  if (carrying !== undefined) {
    return `${carrying.name} is carrying traffic, and nothing has stood down`;
  }
  return "Nothing has stood down, and nothing is carrying traffic";
}

/**
 * What is written beside a `Way out` row's lamp: one path's standing, in a
 * word (R-UI-11).
 *
 * The lamp is read before the word, so this is the confirmation rather than
 * the message — the sentence in `detail` is what says *why*. It is here for
 * the reason everything else in this file is: a second place that decides how
 * a standing is written is the one that stops agreeing with the first.
 *
 * `standing` alone cannot produce it. `standing-by` covers a path that is
 * reaching something, one whose probes are failing but which has not run out
 * the three that condemn it, and one nothing has ever looked at — three
 * states the panel exists to tell apart — so `evidence` is asked for those,
 * exactly as `pathTone` does for the tone.
 */
export function pathStanding(standing: PathStanding, evidence: PathEvidence): string {
  // A path that is not on this board is not a fault, and it has no evidence
  // either way. Asked first, for the same reason `pathTone` asks it first.
  if (standing === "absent") return "NO INTERFACE";
  if (standing === "no-route-out") return "STOOD DOWN";
  if (standing === "testing") return "TESTING";
  // Carrying traffic is what the routing table says, and it is said whether
  // or not anything has tested the link — the lamp beside it stays neutral
  // until something has, which is the distinction R-CEL-09 is about.
  if (standing === "in-use") return "CARRYING TRAFFIC";
  if (evidence === "reaching") return "READY";
  if (evidence === "not-reaching") return "NOT REACHING";
  return "NOT YET TESTED";
}

/** Everything a lit `Way out` row needs, and nothing a flow has to work out. */
export interface PathStandingView {
  standing: PathStanding;
  evidence: PathEvidence;
  tone: Verdict["tone"];
}

/**
 * One `Way out` row's lamp, as the annunciator reads it (R-UI-11, ADR-0005).
 *
 * **The tone is taken, not re-derived.** `pathTone` in `state.ts` decides it
 * from `standing` and `evidence`; deciding it a second time here is how the
 * lamp on this panel and the lamp on the Cellular tab end up disagreeing
 * about one link. The only judgement made here is which words go beside it.
 */
export function pathStatus(row: PathStandingView, at: number): CommandStatus {
  return lit(row.tone, pathStanding(row.standing, row.evidence), at);
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
