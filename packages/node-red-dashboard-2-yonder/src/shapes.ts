// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shapes of the list-valued editor fields.
 *
 * They live in their own module for a mechanical reason worth writing down:
 * a node module uses TypeScript's `export =` so Node-RED's loader gets a bare
 * function, and **`export =` cannot coexist with any other export**. An
 * interface declared beside one compiles, and then fails at load with a
 * ReferenceError that names a generated variable rather than the mistake.
 *
 * So the shapes are here, exported normally, and the node modules import them.
 */

/** One cell of a data bar. */
export interface DataCell {
  /** Property to read from `msg.payload`. */
  key: string;
  /** What the operator sees above it. A `pill` has none — see `kind`. */
  label?: string;
  /**
   * `plain` for a quantity, `id` for something compared character by
   * character — an SSID, an address, a version — which is set in the mono
   * face for the reason `theme.ts` gives: a slashed zero and a fixed width
   * are what make an identifier checkable.
   *
   * `note` is the third: a **sentence** rather than a reading — a run state
   * with the supervisor's failure reason on it, or why a start would be
   * refused. It wraps, on a line of its own, because a reading's own rules
   * (never shrink below the value, never break the line) are what make a bar
   * of readings legible and are exactly what a sentence cannot live under:
   * one 104-character reason took the camera strip 798 px wide inside a
   * 710 px page. `YonderDataBar.vue`'s own doc comment carries the rest.
   *
   * `pill` is the fourth, and it is not a reading at all: one state word in
   * a bordered box with a dot, carrying no caption and drawing **nothing**
   * when its value is absent rather than the em dash every other kind draws
   * (L-23, R-CFG-03). The camera strip's is `● CONFIRMED`. Again,
   * `YonderDataBar.vue`'s own doc comment carries the reasoning.
   */
  kind?: "plain" | "id" | "note" | "pill";
}

/** One key of the soft-key rail. */
export interface SoftKey {
  label: string;
  /** Emitted on `msg.payload` when pressed, so a flow can branch on it. */
  action: string;
  /**
   * `warn` is reserved for a control that takes the page away from the
   * operator — the join that drops the access point (K-13) — and a page has
   * at most one.
   */
  tone?: "plain" | "act" | "warn";
  /** Marks the key for the page currently shown. */
  active?: boolean;
}

/**
 * One row of the facts row (R-UI-20), and one output on the budget track
 * (R-VID-11) — **both from yonder-core, not declared again here.**
 *
 * `capabilityFacts()` and `uplinkBudget()` produce these and the daemon sends
 * them; these components draw them. Two declarations of the same shape is two
 * things to keep in step, and the one that drifts is the one nothing imports:
 * a state added to `capability.ts` later would leave this file's union
 * quietly wrong and the row drawing an unknown state as a known one.
 *
 * From `yonder-core/presentation` rather than the package's main entry, which
 * pulls in the config loader and `node:fs` — the reason that second entry
 * point exists.
 */
export type { CapabilityFact, BudgetSegment } from "yonder-core/presentation";
