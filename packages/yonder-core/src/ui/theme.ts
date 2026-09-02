// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/**
 * Turning "use the night theme" into a configuration (R-UI-07).
 *
 * The same shape, and the same reason, as `joinNetwork` (net/join.ts): what the
 * apply engine takes is a whole configuration document, and the step that
 * turns one field from a browser into one is a decision that does not belong
 * in wiring.
 *
 * It exists because the wiring that did this instead was wrong in a way that
 * was invisible from the page. A `change` node held the last configuration in
 * `flow.yonderConfig`, copied it to `msg.payload`, and then set
 * `msg.payload.ui.theme` — and Node-RED's change node stores and retrieves
 * context by reference, so all three steps addressed one object. Setting the
 * theme mutated the cached configuration in place, whether or not the apply
 * that followed was ever confirmed. A revert put the device back and left the
 * cache holding a theme the device did not have, so the next apply of anything
 * at all carried an unconfirmed change with it.
 *
 * `structuredClone` is the whole fix, and it is here rather than in the flow
 * because a rule about aliasing cannot be enforced by reviewing wire
 * coordinates.
 */

export interface ThemeRequest {
  theme?: unknown;
}

export type ThemeResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/** The two modes, and the only two. Both designed, both selectable (ADR-0005). */
export const THEMES = ["day", "night"] as const;

/**
 * The configuration this device should have in order to use that theme.
 *
 * The whole document, with `ui.theme` set and nothing else touched. Validated
 * against the same list the schema holds, so an unknown value is refused here
 * with a message an operator can read rather than as a Zod issue from inside
 * the apply.
 */
export function setTheme(current: Config, request: ThemeRequest | undefined): ThemeResult {
  const theme = request?.theme;
  if (typeof theme !== "string" || !(THEMES as readonly string[]).includes(theme)) {
    // The submitted value is not echoed: it is unvalidated input on its way
    // back to a browser, and naming the two that are accepted is more use than
    // repeating the one that was not.
    return { ok: false, error: `theme must be one of: ${THEMES.join(", ")}` };
  }

  const config = structuredClone(current);
  config.ui.theme = theme as Config["ui"]["theme"];
  return { ok: true, config };
}
