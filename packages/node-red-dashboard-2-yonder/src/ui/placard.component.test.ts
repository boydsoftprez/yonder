// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderPlacard from "./YonderPlacard.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderPlacard` is nearly one of those, and the "nearly" is the point:
 * ADR-0009 draws every placard in letterspaced capitals, and that ambient
 * `text-transform: uppercase` is exactly the rule that has already turned
 * `Mb/s` into the wrong word twice in this library — once on
 * `YonderReadout`, once on `YonderSetBar` — by uppercasing a unit it should
 * never have touched. A third instance of the identical bug is not a risk
 * worth leaving to inheritance a third time, so this file pins the
 * exemption directly.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes
 * it the way `plc()` below does: plain props, nothing else.
 */
function plc(props: { kind?: string; name?: string; unit?: string } = {}) {
  return mount(YonderPlacard, { props });
}

/**
 * The coordinator's own resolution (task-19-brief.md §3), verbatim:
 * "names the camera and what it is. A unit appearing inside its right-hand
 * text must not be uppercased, even though the placard's own styling is
 * uppercase."
 *
 * `§6`'s own two worked examples — `CAMERA · CAM 2` and
 * `ACCESSORY · H.264 · 1280×720p30` — share one shape, `KIND · VALUE`, so
 * this is one generic part used twice rather than one component drawing
 * two unrelated facts at once (the same way `YonderColumn` is one part
 * reused for both `to the ground station` and `rate control`) — "the
 * camera" is one mount, "what it is" is a second, and both are this same
 * component.
 */
it("draws the camera and what it is; a unit inside the right text keeps text-transform none", () => {
  const camera = plc({ kind: "Camera", name: "Cam 2" });
  expect(camera.text()).toContain("Camera");
  expect(camera.text()).toContain("Cam 2");
  // ADR-0009: every placard is letterspaced capitals. The source text stays
  // whatever case a caller hands it (`Cam 2`, not `CAM 2`) — CSS carries the
  // capitals, so the rule lives in exactly one place rather than in every
  // caller that has to remember to shout.
  expect(getComputedStyle(camera.find(".y-plc").element).textTransform).toBe("uppercase");

  const accessory = plc({ kind: "Accessory", name: "H.264 · 1280×720", unit: "2.07 Mb/s" });
  expect(accessory.text()).toContain("Accessory");
  expect(accessory.text()).toContain("H.264");
  expect(accessory.text()).toContain("1280×720");
  expect(accessory.text()).toContain("2.07 Mb/s");
  // The rule this test exists to hold: `Mb/s` uppercased reads `MB/S`,
  // which says megabytes rather than megabits — a different, wrong unit,
  // not a cosmetic slip. Declared explicitly on the unit's own element
  // rather than trusted to absence, so it wins regardless of what the
  // placard's own ancestor rule declares.
  expect(getComputedStyle(accessory.find(".y-plc__u").element).textTransform).toBe("none");
});

/**
 * Not one of the coordinator's own dictated facts, but the same silence
 * this whole library now speaks with a consistent voice: `YonderColumn`'s
 * empty legend, and `state: 'not-offered'` on `YonderPicker`,
 * `YonderSegmented` and `YonderSetBar`, all draw nothing rather than an
 * empty box. A placard naming neither a kind nor a value is the identical
 * case, applied here.
 */
it("draws no wrapper at all when it has neither a kind nor a name", () => {
  const empty = plc({});
  expect(empty.find(".y-plc").exists()).toBe(false);
  expect(empty.html().replace(/<!--.*?-->/g, "").trim()).toBe("");
});
