// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderPositionGauge from "./YonderPositionGauge.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderPositionGauge` draws a fraction it computes itself — `(value -
 * min) / (max - min)` — onto a track whose own rendered width is a fact
 * this file can check, which is exactly the shape of thing that looks
 * identical in a screenshot to an off-by-one and is not identical at all.
 *
 * **`jsdom` performs no layout**, confirmed directly against this
 * repository's own installed jsdom before writing a single assertion
 * against it (the same trap `setbar.component.test.ts`'s own header
 * documents at length): `getBoundingClientRect()` on any element in this
 * environment returns a real `DOMRect` with every field, `width` included,
 * reading zero. `YonderPositionGauge` never calls it at all — this part
 * has no drag, no click, nothing converting a pixel coordinate back into a
 * value, so there is no reverse conversion for that trap to hide in — but
 * the *forward* direction has a version of the same hazard: the pointer's
 * `left` is computed from `TRACK_WIDTH`, a constant the track's own
 * rendered width is also bound from (§ coordinator resolution 4, "exactly
 * as `YonderSetBar` and `YonderGauge` do"), so this file asserts the
 * pointer's position as an exact pixel value derived from that same
 * constant rather than by re-measuring the rendered track, which would
 * read zero and make every position assertion pass by accident regardless
 * of whether the fraction behind it is correct.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node (the aim
 * pad, Task 20) composes it the way `gauge()` below does: plain props,
 * nothing else.
 */
function gauge(props: {
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
  dead?: boolean;
  reason?: string;
}) {
  return mount(YonderPositionGauge, { props });
}

/**
 * The coordinator's own resolution (task-19-brief.md §4), verbatim: "the
 * pointer sits at (value − min) / (max − min) of the track, with the
 * bounds written beneath. A dead axis is dashed and reads an em dash
 * rather than a number."
 */
describe("the pointer, at (value - min) / (max - min) of a track whose width is a constant", () => {
  it("puts the pointer at the exact pixel the fraction demands, on the same constant the track renders from", () => {
    // Pan's own real range (§7's Aim table: pan ±180°). Zero is the
    // fraction's own midpoint — 0.5 — for a range centred on it, which is
    // an easy value to get right by accident; +90 is not, and pins the
    // arithmetic rather than merely its symmetry.
    const w = gauge({ label: "Pan", value: 90, min: -180, max: 180 });
    const track = w.find(".y-pg__trk");
    const width = parseFloat(getComputedStyle(track.element).width);
    expect(width).toBeGreaterThan(0);
    const ptr = w.find(".y-pg__ptr");
    // (90 - -180) / (180 - -180) = 270 / 360 = 0.75
    const expectedLeft = 0.75 * width;
    expect(parseFloat((ptr.element as HTMLElement).style.left)).toBeCloseTo(expectedLeft, 5);
  });

  it("clamps the pointer to the track rather than drawing it outside — bounds beneath, not a bar past them", () => {
    // A value past either bound must not push the pointer off the track:
    // there is nowhere further for a "reported position" to mean.
    const under = gauge({ value: -400, min: -180, max: 180 });
    const over = gauge({ value: 400, min: -180, max: 180 });
    const width = parseFloat(getComputedStyle(under.find(".y-pg__trk").element).width);
    expect(parseFloat((under.find(".y-pg__ptr").element as HTMLElement).style.left)).toBeCloseTo(0, 5);
    expect(parseFloat((over.find(".y-pg__ptr").element as HTMLElement).style.left)).toBeCloseTo(width, 5);
  });

  it("writes the bounds beneath the track", () => {
    const w = gauge({ label: "Tilt", value: 12, min: -90, max: 90 });
    expect(w.text()).toContain("-90");
    expect(w.text()).toContain("90");
  });

  /**
   * The coordinator's own resolution, verbatim, other half: "a dead axis
   * is dashed and reads an em dash rather than a number."
   */
  it("a dead axis reads a single em dash, not a number, and draws no pointer", () => {
    const w = gauge({ label: "Roll", value: 12, min: -90, max: 90, dead: true, reason: "no answer on this axis" });
    expect(w.find(".y-pg__val").text()).toBe("—");
    expect(w.find(".y-pg__ptr").exists()).toBe(false);
    expect(w.find(".y-pg").classes()).toContain("is-dead");
    expect(w.text()).toContain("no answer on this axis");
  });

  it("draws a live reading as a number with its unit, not a dash", () => {
    const w = gauge({ label: "Tilt", value: 12.3, min: -90, max: 90, unit: "°", precision: 1 });
    expect(w.find(".y-pg__val").text()).not.toContain("—");
    expect(w.find(".y-pg__val").text()).toContain("12.3");
    expect(w.find(".y-pg__ptr").exists()).toBe(true);
  });
});
