// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderBudget from "./YonderBudget.vue";
import type { BudgetSegment } from "../shapes.js";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderBudget` decides three things a bare figure cannot: what scale the
 * track is drawn at, where each segment starts, and which part of it is past
 * the capacity mark. Each is arithmetic in the component's own `computed`
 * and `methods`, so each is asserted against a mounted component rather than
 * inferred from the source.
 *
 * The segment figures below are Task 11's own measurement: a preview branch
 * at 374 kb/s against a full-rate path at 1,888 — what this track actually
 * shows in M4. The unit figures are Task 6's: one 2000 kb/s stream measured
 * at 2003 kb/s of elementary stream, 2022 with RTP framing, and roughly 2067
 * at IP and UDP, which is the layer this track names and the number an
 * uplink actually carries.
 */
function mountBudget(capacityKbps: number, segments: BudgetSegment[], label = "Uplink") {
  return mount(YonderBudget, {
    props: { id: "n1", props: { label, capacityKbps, segments } },
    // `$store: undefined` rather than omitted: Dashboard always installs one,
    // and a track read before any message has arrived is the case these mounts
    // stand for. Declaring it absent exercises that path without Vue warning
    // about a property that was never defined.
    global: { provide: { $dataTracker: () => {} }, mocks: { $store: undefined } },
  });
}

/** The same track with a message on it, the way Dashboard delivers one. */
function mountWithMessage(
  configured: { capacityKbps: number; segments: BudgetSegment[] },
  payload: unknown,
) {
  return mount(YonderBudget, {
    props: { id: "n1", props: { label: "Uplink", ...configured } },
    global: {
      provide: { $dataTracker: () => {} },
      mocks: { $store: { state: { data: { messages: { n1: { payload } } } } } },
    },
  });
}

function leftPct(el: { element: Element }): number {
  return parseFloat((el.element as HTMLElement).style.left);
}
function widthPct(el: { element: Element }): number {
  return parseFloat((el.element as HTMLElement).style.width);
}

describe("mounting", () => {
  it("mounts the .vue file and renders its label", () => {
    expect(mountBudget(0, []).find(".y-budget__label").text()).toBe("Uplink");
  });
});

describe("scaling — the track is drawn to whichever is larger, total or capacity", () => {
  it("scales to capacity when the segments fit under it, so the mark sits at the far edge", () => {
    const wrapper = mountBudget(2000, [{ label: "cam0", kbps: 1000 }]);
    expect(leftPct(wrapper.get(".y-budget__mark"))).toBeCloseTo(100, 1);
    expect(widthPct(wrapper.get(".y-budget__seg"))).toBeCloseTo(50, 1);
  });

  it("scales to the total when it is oversubscribed, so the mark moves left instead of the bar running off the end", () => {
    const wrapper = mountBudget(2000, [
      { label: "preview", kbps: 374 },
      { label: "full-rate", kbps: 1888 },
    ]);
    const total = 374 + 1888;
    expect(leftPct(wrapper.get(".y-budget__mark"))).toBeCloseTo((2000 / total) * 100, 1);
  });
});

describe("segment offsets — each segment starts where the last one ended", () => {
  it("stacks segments back to back rather than overlapping or restarting at zero", () => {
    const wrapper = mountBudget(2000, [
      { label: "preview", kbps: 374 },
      { label: "full-rate", kbps: 1888 },
    ]);
    const total = 374 + 1888;
    const segs = wrapper.findAll(".y-budget__seg");
    expect(leftPct(segs[0]!)).toBeCloseTo(0, 1);
    expect(leftPct(segs[1]!)).toBeCloseTo((374 / total) * 100, 1);
  });
});

describe("over-capacity hatching", () => {
  /**
   * The only drawing of oversubscription an operator can read at a glance,
   * so this is the test that has to go red if a future edit ever deletes the
   * over-capacity branch — whether by removing the class binding or by
   * making the underlying check always false.
   */
  it("marks a segment that starts past capacity, and leaves an earlier one alone", () => {
    const wrapper = mountBudget(1000, [
      { label: "under", kbps: 1200 },
      { label: "over", kbps: 500 },
    ]);
    const segs = wrapper.findAll(".y-budget__seg");
    expect(segs[0]!.classes()).not.toContain("over");
    expect(segs[1]!.classes()).toContain("over");
  });

  it("marks no segment over when the total stays under capacity", () => {
    const wrapper = mountBudget(2000, [{ label: "cam0", kbps: 1000 }]);
    expect(wrapper.get(".y-budget__seg").classes()).not.toContain("over");
  });
});

describe("the unit token", () => {
  it("names the layer without uppercasing the unit — Mb/s uppercased says megabytes", () => {
    const wrapper = mountBudget(2067, [{ label: "cam0", kbps: 2003 }]);
    expect(wrapper.get(".y-budget__total").text()).toContain("Mb/s");
  });
});

/**
 * **What arrived, in preference to what was configured.**
 *
 * A track written into `flows.json` states the bitrates somebody typed there
 * once, and the first operator to change a camera's bitrate or add an output
 * reads a picture of the old configuration. `uplinkBudget()` in yonder-core
 * builds these from the configuration in force and the daemon sends them on
 * `payload.budget`.
 */
describe("the live answer", () => {
  it("draws the configuration in force rather than the one the flow was written with", () => {
    const wrapper = mountWithMessage(
      { capacityKbps: 5000, segments: [{ label: "stale", kbps: 100 }] },
      { budget: { capacityKbps: 4000, segments: [{ label: "front · rtp", kbps: 2067 }] } },
    );
    expect(wrapper.findAll(".y-budget__key").map((n) => n.text()))
      .toEqual(["front · rtp 2.1 Mb/s"]);
    expect(wrapper.find(".y-budget__total").text()).toBe("2.1 of 4.0 Mb/s");
  });

  it("keeps the configured track until the first message arrives", () => {
    const wrapper = mountWithMessage(
      { capacityKbps: 5000, segments: [{ label: "preview", kbps: 413 }] },
      undefined,
    );
    expect(wrapper.find(".y-budget__total").text()).toBe("0.4 of 5.0 Mb/s");
  });

  it("hatches a live segment past the mark, exactly as it hatches a configured one", () => {
    const wrapper = mountWithMessage(
      { capacityKbps: 5000, segments: [] },
      {
        budget: {
          capacityKbps: 2000,
          segments: [{ label: "a", kbps: 2067 }, { label: "b", kbps: 2067 }],
        },
      },
    );
    const over = wrapper.findAll(".y-budget__seg").filter((n) => n.classes().includes("over"));
    expect(over).toHaveLength(1);
  });
});
