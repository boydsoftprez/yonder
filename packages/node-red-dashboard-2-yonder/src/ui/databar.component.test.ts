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

describe("a cell holding a sentence rather than a reading", () => {
  /**
   * The camera strip's `RUNNING`, at the widest honest value the capture
   * gate photographs it at — the supervisor's own failure sentence, 104
   * characters of it.
   */
  const REASON = "failed — the pipeline could not be started: "
    + "Error: spawn gst-launch-1.0 ENOENT; gave up after 5 restarts";

  /**
   * Three rules, asserted separately for the reason the test above gives for
   * splitting its own two: `jsdom` cannot tell a cell that wrapped from one
   * that never had to, so each rule that has to hold gets its own assertion
   * rather than standing on another's shoulders. Between them they are what
   * make the bar's height a function of the page width alone — restore any
   * one of a reading's three rules to a note cell and the strip either runs
   * off the side of the page or changes height with its own content.
   */
  it("wraps a note, on a line of its own, and never shrinks a reading beside it", () => {
    const w = bar(
      [
        { key: "state", label: "RUNNING", kind: "note" },
        { key: "res", label: "PICTURE" },
      ],
      { state: REASON, res: "3840 × 2160" },
    );

    const note = w.findAll(".y-bar__cell")[0]!.element;
    const reading = w.findAll(".y-bar__cell")[1]!.element;

    // 1. The whole sentence is there. Nothing shortens it (R-UI-25).
    expect(w.findAll(".y-bar__v")[0]!.text()).toBe(REASON);

    // 2. It may shrink, so the row can wrap it — the reading beside it may
    //    not, which is what keeps `3840 × 2160` from breaking after the ×.
    expect(getComputedStyle(note).minWidth).toBe("0px");
    expect(getComputedStyle(reading).minWidth).toBe("max-content");

    // 3. A line of its own, and words that wrap on it. `flex-basis: 100%` is
    //    what makes the height depend on the page width and not on how wide
    //    the values beside it happened to be that run.
    expect(getComputedStyle(note).flexBasis).toBe("100%");
    expect(getComputedStyle(w.findAll(".y-bar__v")[0]!.element).whiteSpace).toBe("normal");
    expect(getComputedStyle(w.findAll(".y-bar__v")[1]!.element).whiteSpace).toBe("nowrap");
  });
});

/* -------------------------------------------------------------------------- *
 * L-23 — the `● CONFIRMED` pill (R-CFG-03, R-UI-15).
 * -------------------------------------------------------------------------- */

describe("a pill cell", () => {
  const CELLS: DataCell[] = [
    { key: "confirmed", kind: "pill" },
    { key: "name", label: "CAMERA" },
    { key: "picture", label: "PICTURE" },
  ];

  it("draws the word the daemon composed, with its dot, before the first cell", () => {
    const w = bar(CELLS, { confirmed: "Confirmed", name: "Cam 1", picture: "1280 × 720" });
    expect(w.get(".y-bar__pill").text()).toBe("Confirmed");
    expect(w.find(".y-bar__pill-dot").exists()).toBe(true);
    // Before the first reading, which is where the blueprint draws it. The
    // order is the page's — `cells` declares it first — and this is the
    // assertion that the component honours the order rather than appending
    // its own kinds after the rest.
    const order = [...w.element.querySelectorAll(".y-bar__pill, .y-bar__k")]
      .map((el) => el.className);
    expect(order[0]).toContain("y-bar__pill");
    expect(w.findAll(".y-bar__k").map((k) => k.text())).toEqual(["CAMERA", "PICTURE"]);
  });

  /**
   * **Absent is silence, not an em dash.** Every other kind answers a
   * question, and a question asked with no answer is `—`; a pill is asserted
   * rather than asked, and `—` in a box where a state word goes reads as a
   * state the device is in.
   */
  it("draws nothing at all when the value is absent", () => {
    for (const payload of [{ name: "Cam 1" }, { confirmed: null, name: "Cam 1" }, { confirmed: "", name: "Cam 1" }]) {
      const w = bar(CELLS, payload);
      expect(w.find(".y-bar__pill").exists()).toBe(false);
      expect(w.find(".y-bar__pill-cell").exists(), "no empty box either").toBe(false);
      // And it is not silently redrawn as an ordinary cell with a dash in it.
      expect(w.findAll(".y-bar__cell")).toHaveLength(2);
      expect(w.findAll(".y-bar__v").map((v) => v.text())).toEqual(["Cam 1", "—"]);
    }
  });

  it("carries no caption, and takes no share of the row's width", () => {
    const w = bar(CELLS, { confirmed: "Confirmed", name: "Cam 1", picture: "1280 × 720" });
    const cell = w.get(".y-bar__pill-cell");
    expect(cell.find(".y-bar__k").exists()).toBe(false);
    // `flex: 1` on this box would push every reading beside it narrower to
    // hold a box that is always the same size — R-UI-25's own failure, from
    // the other direction.
    expect(getComputedStyle(cell.element).flex).toBe("0 0 auto");
  });

  /** The blueprint's tone: the good green, not the select cyan. */
  it("is drawn in the good tone", () => {
    const w = bar(CELLS, { confirmed: "Confirmed", name: "Cam 1" });
    const style = getComputedStyle(w.get(".y-bar__pill").element);
    expect(style.color).toContain("--yonder-good");
    expect(style.color).not.toContain("--yonder-select");
  });
});
