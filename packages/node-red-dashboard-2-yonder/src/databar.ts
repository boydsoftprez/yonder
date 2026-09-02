// SPDX-License-Identifier: GPL-3.0-or-later
import { list, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";
import type { DataCell } from "./shapes.js";

/**
 * `ui-yonder-databar` — facts, densely (ADR-0009).
 *
 * A row of label-and-value cells. It is here because of arithmetic rather
 * than taste: a stock widget is a whole row of its group and holds one
 * string, so the Status page spent about 370 px displaying five short values.
 * This widget puts six in 30, which is the difference between a page an
 * operator scans and a page they scroll.
 *
 * Each cell names a key in the incoming payload object. A key that is absent
 * draws as an em dash rather than as blank or as zero: R-UI-05's logic
 * applied to a fact, where *not known* and *nothing* are different answers
 * and only one of them is honest.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-databar",
    props: (node, config) => ({
      label: str(config.label),
      cells: list<DataCell>(config.cells, node, "cells"),
    }),
  });
};
