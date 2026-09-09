// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderThumbStrip from "./YonderThumbStrip.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderThumbStrip` draws what it is given, and what it is given includes
 * an array whose *order* an implementation could confuse for identity — a
 * press has to name the camera it was a press on, not the position it
 * happened to be sitting at, and those two agree often enough in a quick
 * manual check to hide a bug that only shows once a camera list is
 * reordered or filtered. That is what this file actually tests.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. `YonderPicture`'s own
 * rework (a later task) composes it the way `strip()` below does: plain
 * props, nothing else.
 */
function strip(props: {
  cameras?: Array<{ id: string; name?: string; active?: boolean; ageSeconds?: number }>;
  downlink?: string;
} = {}) {
  return mount(YonderThumbStrip, { props });
}

/**
 * The coordinator's own resolution (task-19-brief.md §6), verbatim: "one
 * thumb per camera, the active one marked and reading `Live`, the others
 * reading `Still · n s`. A press emits a `go` with the camera's id, not
 * its index."
 */
it("one thumb per camera; the active one on and Live; the others Still · n s; press emits go with the id", async () => {
  const cameras = [
    { id: "cam-nose", name: "Nose", active: false, ageSeconds: 4 },
    { id: "cam-belly", name: "Belly", active: true, ageSeconds: 0 },
    { id: "cam-tail", name: "Tail", active: false, ageSeconds: 11 },
  ];
  const w = strip({ cameras });
  const thumbs = w.findAll(".y-strip__thumb");
  // One thumb per camera — every camera, not only "the others": the
  // coordinator's own resolution corrects the spec's looser first draft
  // (§6's table said "the others as stills"), and this is the count that
  // tells the two apart.
  expect(thumbs).toHaveLength(3);

  expect(thumbs[0].classes()).not.toContain("on");
  expect(thumbs[0].text()).toContain("Still · 4 s");
  expect(thumbs[1].classes()).toContain("on");
  expect(thumbs[1].text()).toContain("Live");
  expect(thumbs[1].text()).not.toContain("Still");
  expect(thumbs[2].classes()).not.toContain("on");
  expect(thumbs[2].text()).toContain("Still · 11 s");

  // The id, not the index: the first *array position* pressed belongs to
  // `cam-nose`, and a component that emitted the loop index instead would
  // send `0` here — a value that happens to look right only because this
  // camera's id is not itself `0`, which is exactly the kind of thing a
  // quick manual check would never catch.
  await thumbs[0].trigger("click");
  expect(w.emitted("go")?.[0]).toEqual(["cam-nose"]);

  // And the last position emits the last camera's id, not its own index
  // (`2`) and not the currently active camera's id (`cam-belly`) either.
  await thumbs[2].trigger("click");
  expect(w.emitted("go")?.[1]).toEqual(["cam-tail"]);
});

/**
 * The coordinator's own resolution, verbatim: "`Downlink now` is the
 * measured path total, never the sum of two configured targets — a number
 * nobody measured is a number nobody should act on."
 */
it("Downlink now is the measured path total, not the sum of two targets", () => {
  // Deliberately not reconstructible from anything else this specimen
  // carries — not the camera count, not either camera's age, not a round
  // number a naive placeholder might reach for. Nothing in this component
  // computes a downlink figure at all; it draws the one string it is
  // handed, which is the only way "measured, not summed" can be true of a
  // dumb presentational part.
  const w = strip({
    cameras: [
      { id: "cam-nose", name: "Nose", active: true, ageSeconds: 0 },
      { id: "cam-belly", name: "Belly", active: false, ageSeconds: 4 },
    ],
    downlink: "3.9 Mb/s",
  });
  expect(w.find(".y-strip__dl").text()).toContain("3.9 Mb/s");
});

/**
 * Not one of the coordinator's two, but the natural partner of the one
 * above: a caller with nothing measured yet (no viewers subscribed, or an
 * early message before the daemon has reported) must not draw a downlink
 * line claiming a reading of nothing.
 */
it("draws no downlink line at all when nothing has been measured yet", () => {
  const w = strip({ cameras: [{ id: "cam-nose", name: "Nose", active: true }] });
  expect(w.find(".y-strip__dl").exists()).toBe(false);
});

it('shows real thumbnail age alongside the source caption, never inventing an age for an unavailable image', () => {
  const w = mount(YonderThumbStrip, { props: { cameras: [
    {id:'one', name:'Pocket', active:true, caption:'ACCESSORY · running', thumbSrc:'/video/one/still?v=1', ageSeconds:3},
    {id:'two', name:'Other', active:false, caption:'USB · stopped', thumbSrc:null, ageSeconds:null},
  ] } });
  const rows = w.findAll('.y-strip__thumb');
  expect(rows[0].text()).toContain('ACCESSORY · running'); expect(rows[0].text()).toContain('3 s ago');
  expect(rows[1].get('.y-strip__img').attributes('style') ?? '').not.toContain('url(');
  expect(rows[1].find('.y-strip__age').exists()).toBe(false);
});
