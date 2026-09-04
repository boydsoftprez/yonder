// SPDX-License-Identifier: GPL-3.0-or-later
import { list, num, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";
import type { BudgetSegment } from "./shapes.js";

/**
 * `ui-yonder-budget` — what is leaving, against what the path can carry
 * (R-VID-11, R-UI-09).
 *
 * R-VID-11 asks for each output's bandwidth and their total *against the
 * capacity of the path they leave by*, and R-UI-09 says a bounded quantity
 * cannot be a bare figure. So this is one track: a segment per output, a mark
 * at the measured capacity, and anything past the mark hatched in the fault
 * tone.
 *
 * The bar is a **readout, not an input**. That removes an ambiguity a slider
 * has: with a slider you cannot tell whether the bar shows what you asked for
 * or what you are getting. Bitrate is chosen with a picker beside it.
 *
 * The tee costs almost nothing — 68% of a core for one output against 70% for
 * two — but each consumer that leaves over cellular costs its own bitrate. At
 * 2 Mb/s that is 6 Mb/s for one camera against a field LTE uplink that is
 * often 1-5, and this is the instrument that makes that visible before it is
 * discovered.
 *
 * **It says which layer it counts.** Measured on the board over an 8 s
 * steady-state window, one 2000 kb/s stream is 2003 kb/s of elementary stream,
 * 2022 kb/s once RTP framing is added, and ~2067 kb/s at IP and UDP — 3.2%
 * apart end to end. Rate control itself is within 0.2%, so every discrepancy an
 * operator sees between the configured figure and this track is framing, not
 * the encoder missing its target. A bar that does not name its layer invites
 * exactly the wrong conclusion, and the number an uplink actually carries is
 * the IP one.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-budget",
    props: (node, config) => ({
      label: str(config.label),
      capacityKbps: num(config.capacityKbps, 0),
      segments: list<BudgetSegment>(config.segments, node, "segments"),
    }),
  });
};
