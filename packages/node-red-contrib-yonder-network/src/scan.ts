// SPDX-License-Identifier: GPL-3.0-or-later
import { ssidOptions } from "yonder-core";
import { registerReader } from "./read.js";
import type { RED } from "./red.js";

/**
 * `yonder-scan` — what is in the air (R-NET-03).
 *
 * The folding and ordering happen in `yonder-core`'s `scanForNetworks`, where
 * a mesh reporting one SSID four times becomes one row and the list is sorted
 * so it does not reshuffle under the cursor. This node carries the answer.
 *
 * It never returns a credential, because the route cannot: a scan is a list of
 * what is broadcasting, which anything with a radio can already see.
 *
 * **Two outputs from one scan.** The first is the list a table shows. The
 * second is the same list shaped as `msg.ui_update.dropdownOptions`, which is
 * how a Dashboard form is told what to offer — because the join form's SSID
 * field is a dropdown, not a box to transcribe a name into. A form cannot be
 * fed from its own input, so this is the only way the two agree.
 */
export = function register(RED: RED): void {
  registerReader(
    RED,
    "yonder-scan",
    "/net/scan",
    (value) => {
      const networks = (value as { networks?: unknown[] } | undefined)?.networks;
      return `${Array.isArray(networks) ? networks.length : 0} networks`;
    },
    (value) => ({ ui_update: { dropdownOptions: ssidOptions(value as never) } }),
  );
};
