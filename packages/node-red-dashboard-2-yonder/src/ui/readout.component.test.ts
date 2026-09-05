// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderReadout from "./YonderReadout.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderReadout` is not one of those, in one specific way: whether a row's
 * value is *absent* or *zero* is a decision this component makes for every
 * row it is handed, and getting it wrong is exactly the failure this task's
 * own brief opens with — "a card that is not fitted and a card at zero
 * become the same blank." So that decision is asserted here, mounted for
 * real, rather than inferred from the template.
 *
 * `YonderReadout` is a part (`docs/superpowers/plans/2026-09-04-console-
 * instrument-library.md`'s File Structure table), not a Node-RED widget in
 * its own right — no `id`, no `$dataTracker`, no `$store`. A future node
 * (`YonderDeck`, later in this plan) composes it the way `rows()` below
 * does: a plain `rows` prop, nothing else.
 */
function rows(entries: Array<{ label: string; value: string | number | null; unit?: string }>) {
  return mount(YonderReadout, { props: { rows: entries } });
}

describe("mounting", () => {
  it("mounts the .vue file and draws one row per entry, in order", () => {
    const w = rows([
      { label: "Battery", value: "92", unit: "%" },
      { label: "Board", value: "41", unit: "°C" },
    ]);
    const labels = w.findAll(".y-ro__l").map((n) => n.text());
    expect(labels).toEqual(["Battery", "Board"]);
  });
});

describe("the value and its unit — a real gap between them, not a visual one", () => {
  /**
   * The brief's own first test, verbatim. `\s+` rather than a literal single
   * space: the gap is a `{{ ' ' }}` text node in the template (see the
   * component's own comment on why), and this only cares that *some*
   * whitespace separates the two, not how many characters wide it is.
   */
  it("draws a label, a value and its unit, with a space between", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(w.find(".y-ro__v").text()).toMatch(/3\.0\s+Mb\/s/);
  });

  /**
   * The serialised-text gap above is one half of the fix; this is the
   * other. `jsdom` renders no layout, so nothing here could assert the gap
   * is visually four pixels wide by measuring — but `margin-left` is a
   * stylesheet fact, not a layout one, and `getComputedStyle` reports it
   * precisely (Task 14 turned `css: true` on for exactly this). A
   * component that satisfied the test above by leaning on the margin alone,
   * with no real separation in the text, would leave a screen reader (or
   * any other consumer of `.textContent`) reading `3.0Mb/s`; a component
   * that satisfied it with the text node alone and no margin would look
   * wrong. Both are required, and each has its own test because neither
   * test can see the other's half.
   */
  it("separates the unit with a margin, not a leading space typed into the tag", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(getComputedStyle(w.find(".y-ro__u").element).marginLeft).toBe("4px");
  });

  /**
   * The brief's own second test, verbatim. A unit sits among uppercase
   * labels on every side of it, so this is the one rule in this component
   * most easily lost without anyone noticing — `Mb/s` uppercased reads
   * `MB/S`, which says megabytes.
   */
  it("never uppercases a unit", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(getComputedStyle(w.find(".y-ro__u").element).textTransform).toBe("none");
  });
});

/**
 * The coordinator's own resolution, verbatim (task-15-brief.md's
 * "Coordinator's resolutions" §1). Mine to use, not to rewrite.
 */
describe("absence — `null` is not `0` and not an empty string", () => {
  it("omits the unit slot when there is none; draws absent in the neutral tone", () => {
    const w = rows([
      { label: "Viewers", value: "1" }, // no unit at all
      { label: "Card", value: null }, // nothing to report
    ]);
    expect(w.findAll(".y-ro__u")).toHaveLength(0);
    expect(w.findAll(".y-ro__v")[1].text()).toBe("none");
    expect(w.findAll(".y-ro__v")[1].classes()).toContain("is-absent");
  });

  /**
   * The verbatim test above never hands this component a zero — "Viewers"
   * is "1", a truthy string, so a naive `row.value || 'none'` implementation
   * would pass it exactly as well as a correct one, and would only fail
   * here. This is the test the brief's own opening line is about: a card
   * that is not fitted (`null`, above) and a card that is fitted and
   * reading zero must not become the same blank. Mutation-checked (see
   * task-15-report.md): swapping the strict-`null` check for a truthy check
   * turns this test red while leaving every test above it green.
   */
  it("draws zero as 0, in the ordinary tone, not as absent", () => {
    const w = rows([{ label: "Bitrate", value: 0, unit: "Mb/s" }]);
    const value = w.get(".y-ro__v");
    expect(value.text()).toMatch(/^0\s+Mb\/s$/);
    expect(value.classes()).not.toContain("is-absent");
  });

  /**
   * The verbatim test above never gives this component a value long enough,
   * or a `unit`, to catch a version that shows a unit beside "none" — which
   * would read as nonsense ("none Mb/s") for a card that is not fitted. Not
   * fitted is not fitted regardless of what unit a caller happened to pass.
   */
  it("shows no unit beside an absent value even when the row carries one", () => {
    const w = rows([{ label: "Bitrate", value: null, unit: "Mb/s" }]);
    expect(w.find(".y-ro__u").exists()).toBe(false);
    expect(w.get(".y-ro__v").text()).toBe("none");
  });
});
