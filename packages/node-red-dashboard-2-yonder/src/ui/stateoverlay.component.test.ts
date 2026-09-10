// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderStateOverlay from "./YonderStateOverlay.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderStateOverlay` is nearly one of those — every field it shows is
 * handed to it pre-formatted, the daemon's own preview-state message
 * (§8.2) rather than anything computed here — but which of five head
 * words it draws, and which tone each takes, is this component's own
 * lookup, and a lookup that silently falls back to the wrong branch reads
 * identically to a correct one until the specific state it got wrong is
 * exercised. That, and the cost row's own three-fields-never-one-sum rule
 * (coordinator resolution 5), are what this file actually tests.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. `YonderPicture`'s own
 * rework (a later task) composes it the way `overlay()` below does: plain
 * props, nothing else.
 */
function overlay(props: {
  head?: string;
  size?: string;
  rate?: string;
  bitrate?: string;
  detail?: string;
  step?: string;
  cost?: { view?: string; encode?: string; path?: string };
} = {}) {
  return mount(YonderStateOverlay, { props });
}

/**
 * The coordinator's own resolution (task-19-brief.md §5) gave this one
 * test body verbatim, unlike its three siblings below: "draws head, size,
 * rate and bitrate, and the detail line" with
 * `expect(text).toContain("ADAPTIVE"); expect(text).toContain("1.8 of
 * 0.3–2.0");`. Reproduced exactly, with the three fields its own name
 * promises and the two dictated lines do not individually pin added
 * alongside rather than in their place.
 */
it("draws head, size, rate and bitrate, and the detail line", () => {
  const text = overlay({
    head: "adaptive",
    size: "1280×720",
    rate: "15 fps",
    bitrate: "1.8 Mb/s",
    detail: "1.8 of 0.3–2.0",
  }).text();
  expect(text).toContain("ADAPTIVE");
  expect(text).toContain("1.8 of 0.3–2.0");
  expect(text).toContain("1280×720");
  expect(text).toContain("15 fps");
  expect(text).toContain("1.8 Mb/s");
});

/**
 * The coordinator's own resolution, verbatim: "Its tone changes with what
 * the picture is doing: caution at the floor, the fault tone on stills,
 * select at full rate." Three of this component's five head words are
 * named outright; `adaptive` (ordinary operation) and `held` (a size
 * holding, not stepping) are this file's own reasoned extensions —
 * documented on the component itself, not asserted here as load-bearing —
 * because the coordinator's examples were never claimed to be all five.
 */
it("takes the caution tone at the floor, the fault tone on stills, select at full rate", () => {
  expect(overlay({ head: "floor" }).find(".y-ov").classes()).toContain("tone-waiting");
  expect(overlay({ head: "stills" }).find(".y-ov").classes()).toContain("tone-bad");
  expect(overlay({ head: "full-rate" }).find(".y-ov").classes()).toContain("tone-select");
  // The tone is a lookup (this library's own repeated rule — YonderFacts,
  // YonderPicker, YonderSegmented, YonderSetBar, YonderColumn all state
  // it): none of the three above may collide with either of the others.
  const floor = overlay({ head: "floor" }).find(".y-ov").classes();
  const stills = overlay({ head: "stills" }).find(".y-ov").classes();
  const full = overlay({ head: "full-rate" }).find(".y-ov").classes();
  expect(floor).not.toContain("tone-bad");
  expect(stills).not.toContain("tone-select");
  expect(full).not.toContain("tone-waiting");

  // Found by mutation, not written in on the first pass: a ternary keyed
  // only on `adaptive` (`head === 'adaptive' ? 'ADAPTIVE' : 'OTHER'`)
  // satisfies every assertion above — none of them reads the *word* for
  // any head but `adaptive` — while silently mislabelling `floor`,
  // `stills` and `full-rate` alike. The caption is part of what this test
  // promises in its own name ("takes the tone"), so the words are pinned
  // here rather than left to the first test's single `adaptive` case.
  expect(overlay({ head: "floor" }).text()).toContain("MINIMUM BITRATE");
  expect(overlay({ head: "stills" }).text()).toContain("STILLS");
  expect(overlay({ head: "full-rate" }).text()).toContain("FULL RATE");

  // The fallback branch itself: a head this file does not recognise must
  // not silently borrow a real tone (`tone-good` reads as "everything is
  // fine", which is the one thing that is not established about a state
  // nobody named). It still shows *something* — its own value, upper-
  // cased, rather than a blank caption — so an unrecognised state is
  // visible and investigable rather than invisible.
  const unknown = overlay({ head: "some-future-state" });
  expect(unknown.find(".y-ov").classes()).toEqual(["y-ov"]);
  expect(unknown.text()).toContain("SOME-FUTURE-STATE");
});

/**
 * The coordinator's own resolution, verbatim: "The step line appears only
 * when a step has actually happened."
 */
it("shows the step line only when a step is set", () => {
  const stepped = overlay({ head: "floor", step: "stepped down to 854×480 · pinned at the floor" });
  expect(stepped.find(".y-ov__step").text()).toContain("stepped down to 854×480");

  const notStepped = overlay({ head: "adaptive" });
  expect(notStepped.find(".y-ov__step").exists()).toBe(false);
  expect(notStepped.text()).not.toContain("stepped");
});

/**
 * The coordinator's own resolution, verbatim: "the cost is three fields,
 * never one sum: this viewer's delivery, the shared encode, the path
 * total. Summing them would tell an operator they are spending something
 * they are not."
 */
it("shows this viewer's cost, the shared encode and the path total as three fields, never one sum", () => {
  const w = overlay({ cost: { view: "0.6 Mb/s", encode: "1.8 Mb/s", path: "3.9 Mb/s" } });
  // Three distinct elements, not one field concatenating them — a
  // consolidated single reading is exactly the shape this test exists to
  // refuse, whatever number ends up inside it.
  expect(w.findAll(".y-ov__cost-f")).toHaveLength(3);
  expect(w.text()).toContain("0.6 Mb/s");
  expect(w.text()).toContain("1.8 Mb/s");
  expect(w.text()).toContain("3.9 Mb/s");
  // 3.9 is deliberately not 0.6 + 1.8 (= 2.4 Mb/s): the path total
  // includes other viewers and thumbnail stills (§8.2) this component is
  // never told the makeup of, so it cannot be recovered by adding the
  // other two even where its provider's own arithmetic is briefly wrong.
  // Nothing in this component computes a sum at all — asserting the
  // literal, unsummed figure is what proves that rather than assumes it.
  expect(w.text()).not.toContain("2.4 Mb/s");
});

/**
 * Not one of the coordinator's four, but the natural partner of the one
 * above: a cost the caller has not supplied at all (an early message
 * before the daemon has anything to report) must not draw an empty row
 * claiming a reading of nothing.
 */
it("draws no cost row at all when nothing is given to show", () => {
  const w = overlay({ head: "adaptive" });
  expect(w.find(".y-ov__cost").exists()).toBe(false);
});
