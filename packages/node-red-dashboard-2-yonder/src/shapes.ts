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
