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
  /** What the operator sees above it. */
  label: string;
  /**
   * `plain` for a quantity, `id` for something compared character by
   * character — an SSID, an address, a version — which is set in the mono
   * face for the reason `theme.ts` gives: a slashed zero and a fixed width
   * are what make an identifier checkable.
   */
  kind?: "plain" | "id";
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
 * One row of the facts row (R-UI-15).
 *
 * Only the two states of `Capability<T>` (`capability.ts`, yonder-core) that
 * are *not* `present` ever become one of these — a capability the camera
 * answered gets a real control, not a row here. `not-offered` and
 * `advertised` keep those names on purpose, so the vocabulary a control
 * checks and the vocabulary this row draws are the same union rather than a
 * translation of it.
 */
export interface CapabilityFact {
  label: string;
  /**
   * `not-offered` is a fact in the neutral tone: the camera does not have
   * this, and nothing is wrong. `advertised` is a fault in the caution
   * tone: the device lists the capability, accepts the command, and does
   * nothing — carried in `reason`, because on the wire it is
   * indistinguishable from success.
   */
  state: "not-offered" | "advertised";
  /** Required in spirit for `advertised`; the component draws its absence. */
  reason?: string;
}

/** One output leaving over the path the budget track measures (R-VID-11). */
export interface BudgetSegment {
  label: string;
  /** At IP, the layer an uplink actually carries — see `budget.ts`. */
  kbps: number;
}
