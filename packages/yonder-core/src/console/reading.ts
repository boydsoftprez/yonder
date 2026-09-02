// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandPresentation } from "./command.js";

/**
 * A bounded quantity, and where it sits between its bounds (R-UI-09, ADR-0009).
 *
 * R-UI-09 says a reading whose meaning depends on a limit is drawn against
 * that limit. `62.4 °C` is a number; `62.4 °C, caution at 60, throttles at
 * 80, ceiling 85` is a reading. This module is the second thing from the
 * first, and it lives here for the same reason `command.ts` does: **the
 * decision about what a value means cannot be taken twice.** A Vue component
 * that decided its own colour and a node that decided its own status text
 * would disagree the first time somebody changed a threshold, and the
 * disagreement would be invisible until a board got hot.
 *
 * So the tone is computed here, in a package with tests, and travels to the
 * page as data. The component draws what it is told and decides nothing.
 *
 * The tone names are `command.ts`'s, deliberately. ADR-0005 required one
 * command-state language shared by both idioms; a second, parallel vocabulary
 * for instrument bands would be exactly the drift it was written to prevent.
 * A reading is never `waiting` — nothing is pending about a temperature — so
 * the four names are used as three, and that is a narrowing rather than a
 * different set.
 */

export type ReadingTone = CommandPresentation["tone"];

export interface ReadingBounds {
  /** Bottom of the scale. Defaults to 0, which is right for every quantity so far. */
  min?: number;
  /** Top of the scale. The reading is clamped to it, never drawn past it. */
  max: number;
  /**
   * Where the value stops being unremarkable. Optional: a quantity with a
   * ceiling but no meaningful caution band — disk, say — simply has none, and
   * gets no amber.
   */
  caution?: number;
  /**
   * The number that matters operationally, marked distinctly on the scale.
   * On a Pi this is the throttle point, which is not the ceiling: the board
   * survives 85 °C and slows down at 80, and an operator needs to see the 80.
   */
  limit?: number;
}

export interface Reading extends ReadingBounds {
  value: number;
  /** 0..1, clamped. What a bar fills to and a tape rises to. */
  fraction: number;
  /** Where `caution` sits on the same 0..1 scale, when there is one. */
  cautionAt?: number;
  /** Where `limit` sits on the same 0..1 scale, when there is one. */
  limitAt?: number;
  tone: ReadingTone;
}

/** Clamp to 0..1. A sensor that reads past its own ceiling still draws. */
function fraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Which band a value is in.
 *
 * At or above `limit` is bad; at or above `caution` is waiting; otherwise
 * good. **At** rather than past, because a threshold an operator was told
 * about should announce itself when it is reached, not one sample later.
 *
 * With neither threshold configured the reading is `neutral`, not `good`: a
 * quantity nobody has set bounds on has not been judged, and claiming it is
 * healthy would be an answer we do not have.
 */
function tone(value: number, bounds: ReadingBounds): ReadingTone {
  if (bounds.limit !== undefined && value >= bounds.limit) return "bad";
  if (bounds.caution !== undefined && value >= bounds.caution) return "waiting";
  if (bounds.caution === undefined && bounds.limit === undefined) return "neutral";
  return "good";
}

/**
 * A value and its bounds, resolved into everything a page needs to draw it.
 *
 * A non-finite value — a sensor that is not there, a field the daemon could
 * not read — is not an error and not a zero. It comes back with `fraction` 0
 * and tone `neutral`, so the instrument renders empty and unjudged rather
 * than drawing a confident reading of nothing. R-UI-05's logic applied to a
 * gauge: not knowing is a state, and it is not the same as fine.
 */
export function reading(value: number, bounds: ReadingBounds): Reading {
  const min = bounds.min ?? 0;
  const { max, caution, limit } = bounds;

  if (!Number.isFinite(value)) {
    return { value: Number.NaN, min, max, caution, limit, fraction: 0, tone: "neutral" };
  }

  return {
    value,
    min,
    max,
    caution,
    limit,
    fraction: fraction(value, min, max),
    cautionAt: caution === undefined ? undefined : fraction(caution, min, max),
    limitAt: limit === undefined ? undefined : fraction(limit, min, max),
    tone: tone(value, bounds),
  };
}
