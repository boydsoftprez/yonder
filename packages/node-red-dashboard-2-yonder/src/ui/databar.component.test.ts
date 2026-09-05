// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderDataBar from "./YonderDataBar.vue";
import type { DataCell } from "../shapes.js";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing. `YonderDataBar`
 * is one of those, and this file does not relitigate that — the em-dash
 * decision in `has()`/`shown()` stays unguarded here, same as it always has.
 *
 * What changed is R-UI-25: the gallery rendered six real cells at once and
 * one came back `1280 × 7…`, sheared off mid-value. That is not a decision
 * this component got wrong; it is a *rule* — every cell stays its own width
 * and the row wraps rather than shrinking one below what its value needs —
 * and a rule is exactly what a mounted component can hold to, `jsdom`'s
 * missing layout engine notwithstanding. `jsdom` reports the stylesheet a
 * component ships with precisely (`getComputedStyle` on a real `<style
 * scoped>` rule, not a mock), it only cannot say where that rule would place
 * a pixel — so this asserts the rule, and the full text every cell was
 * handed, never a measured position.
 */

const SIX_CELLS: DataCell[] = [
  { key: "res", label: "Resolution" },
  { key: "rate", label: "Bitrate" },
  { key: "batt", label: "Battery" },
  { key: "temp", label: "Board" },
  { key: "sig", label: "Signal" },
  { key: "net", label: "Net", kind: "id" },
];

/** The values measured on the board — the full ones the row cut short. */
const PAYLOAD = {
  res: "1280 × 720",
  rate: "5.17 Mb/s at IP",
  batt: "92%",
  temp: "41°C",
  sig: "-71 dBm",
  net: "cell-0",
};

function bar(cells: DataCell[], payload: unknown) {
  return mount(YonderDataBar, {
    props: { id: "n1", props: { cells } },
    global: {
      provide: { $dataTracker: () => {}, $socket: { emit() {}, on() {}, off() {} } },
      mocks: { $store: { state: { data: { messages: { n1: { payload } } } } } },
    },
  });
}

describe("mounting", () => {
  it("mounts the .vue file and renders one cell per key, its label included", () => {
    const w = bar([{ key: "batt", label: "Battery" }], { batt: "92%" });
    expect(w.findAll(".y-bar__cell")).toHaveLength(1);
    expect(w.get(".y-bar__k").text()).toBe("Battery");
    expect(w.get(".y-bar__v").text()).toBe("92%");
  });
});

describe("R-UI-25 — the row an operator reaches for while an aircraft is flying", () => {
  /**
   * The defect seen on the board — `1280 × 7…` — reproduced standing alone.
   *
   * `min-width: 0` on `.y-bar__cell` is what let a cell shrink below its
   * value's own width in the first place, at which point `white-space:
   * nowrap` did exactly what it is told and sheared the value against the
   * cell's edge. Six cells and two full-length values are what it takes to
   * force that shrink; `.text()` would report the value in full even while
   * shrunk and visually clipped — `textContent` does not know about paint —
   * which is why the fix is asserted as two rules rather than as a
   * measurement: the row's own `flex-wrap`, and the cell's own `min-width`.
   * Breaking `flex-wrap` alone turns this test red; breaking `min-width`
   * alone does not, because nothing built on `jsdom` can tell a cell that
   * shrank from one that never had to — which is exactly why that rule gets
   * its own assertion instead of standing on the first one's shoulders.
   */
  it("draws every cell it was given, each value in full, and wraps rather than clips", () => {
    const w = bar(SIX_CELLS, PAYLOAD);
    expect(w.findAll(".y-bar__cell")).toHaveLength(6);
    expect(w.findAll(".y-bar__v").map((v) => v.text())).toEqual(
      expect.arrayContaining(["1280 × 720", "5.17 Mb/s at IP"]),
    );
    expect(getComputedStyle(w.find(".y-bar").element).flexWrap).toBe("wrap");
    expect(getComputedStyle(w.find(".y-bar__cell").element).minWidth).toBe("max-content");
  });
});
