// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderColumn from "./YonderColumn.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderColumn` is nearly one of those — it is a layout wrapper, not a
 * control — but "nearly" is not "is": which tone a qualifier takes, and
 * whether an empty legend draws an empty box or nothing at all, are its
 * own template's decisions and look identical in a screenshot to the wrong
 * answer beside them, which is why they get an assertion each rather than
 * a read of the source.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes
 * it the way `col()` below does: plain props and a default slot, nothing
 * else.
 */
function col(props: { legend?: string; qualifier?: string; tone?: string } = {}, slotContent = "") {
  return mount(YonderColumn, { props, slots: slotContent ? { default: slotContent } : {} });
}

/**
 * The coordinator's own resolution (task-19-brief.md §2), verbatim: "draws
 * a legend and, optionally, a right-hand qualifier in a named tone. Empty
 * input draws no wrapper at all, the way `not-offered` does elsewhere in
 * this library. An empty box and an absent one say different things."
 *
 * The body is mine — the coordinator left this one, and ten of its eleven
 * siblings, with `…` rather than dictated code (resolution 0), so each
 * assertion below is written to be broken on purpose afterward and confirm
 * it goes red; see this file's own mutation log in the task-19 report for
 * what was actually run.
 */
it("draws its legend and a right-hand qualifier in the given tone; none when empty", () => {
  const w = col({ legend: "Stream", qualifier: "to the ground station", tone: "select" }, "<button>Bitrate</button>");
  expect(w.find(".y-col__legend").text()).toBe("Stream");
  const q = w.find(".y-col__q");
  expect(q.exists()).toBe(true);
  expect(q.text()).toBe("to the ground station");
  // The tone is a lookup (this file's own copy of the rule `YonderFacts`,
  // `YonderPicker`, `YonderSegmented` and `YonderSetBar` all state): a
  // named tone earns its own class, and an unrecognised one must not
  // silently borrow it.
  expect(q.classes()).toContain("tone-select");
  expect(q.classes()).not.toContain("tone-waiting");
  // A group wraps what it is given — the whole reason this part exists.
  expect(w.html()).toContain("Bitrate");

  // A qualifier is optional (unlike the legend): its absence draws a
  // column with nothing on the right, not an empty box in its place.
  const noQualifier = col({ legend: "Stream" });
  expect(noQualifier.find(".y-col__q").exists()).toBe(false);

  // An unrecognised tone is the plain label colour, never `tone-select`'s
  // own class by accident of a ternary's fallback branch.
  const plain = col({ legend: "Stream", qualifier: "rate control", tone: "not-a-real-tone" });
  expect(plain.find(".y-col__q").classes()).toEqual(["y-col__q"]);

  // Empty legend: no wrapper at all, not merely an empty one — the same
  // silence `state: 'not-offered'` already draws for `YonderPicker`,
  // `YonderSegmented` and `YonderSetBar` (R-UI-20's reasoning), extended
  // here to a part with no `state` prop of its own. The slot content this
  // column would otherwise have wrapped must not escape into the page on
  // its own, orphaned from the group that was supposed to contain it.
  const empty = col({ legend: "", qualifier: "should not appear" }, "should not render either");
  expect(empty.find(".y-col").exists()).toBe(false);
  expect(empty.html().replace(/<!--.*?-->/g, "").trim()).toBe("");
});
