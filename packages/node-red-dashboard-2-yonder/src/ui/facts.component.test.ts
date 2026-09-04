// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderFacts from "./YonderFacts.vue";
import type { CapabilityFact } from "../shapes.js";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing, so mounting
 * one against a mocked Dashboard would only assert that the mock behaves
 * like the mock.
 *
 * `YonderFacts` is not one of those. Which words a state gets, and which
 * tone, is a decision made in this component's own template — and getting it
 * wrong is exactly the failure R-UI-15 exists to prevent: an operator must be
 * able to tell *this camera cannot* from *this page failed*. `capability.ts`
 * says the `advertised` state is the one most likely to be got wrong in code,
 * because on the wire it is indistinguishable from success — so the markup
 * that tells the two apart is what is asserted here, mounted for real rather
 * than inferred from the source.
 */
function mountFacts(facts: CapabilityFact[], title = "") {
  return mount(YonderFacts, {
    props: { id: "n1", props: { title, facts } },
    global: { provide: { $dataTracker: () => {} } },
  });
}

describe("mounting", () => {
  it("mounts the .vue file and renders its title", () => {
    // Step 1: prove the harness works at all before trusting it with the
    // two-state distinction below.
    const wrapper = mountFacts([], "This camera has no");
    expect(wrapper.find(".y-facts__title").text()).toBe("This camera has no");
  });

  it("omits the title row when none is configured", () => {
    expect(mountFacts([]).find(".y-facts__title").exists()).toBe(false);
  });
});

describe("the not-offered state — a stated fact, in the neutral tone", () => {
  it("draws one row of text, with no reason and no advertised marking", () => {
    const row = mountFacts([{ label: "aim", state: "not-offered" }]).get(".y-facts__row");
    expect(row.classes()).toContain("is-not-offered");
    expect(row.find(".y-facts__state").text()).toBe("this camera has none");
    expect(row.find(".y-facts__reason").exists()).toBe(false);
  });
});

describe("the advertised state — a fault, in the caution tone, carrying its reason", () => {
  it("keeps the row marked inoperative and states why", () => {
    const row = mountFacts([
      { label: "zoom", state: "advertised", reason: "accepted, does not reshape the feed" },
    ]).get(".y-facts__row");
    expect(row.classes()).toContain("is-advertised");
    expect(row.find(".y-facts__state").text()).toBe("not answering");
    expect(row.find(".y-facts__reason").text()).toBe("accepted, does not reshape the feed");
  });
});

describe("the two states, side by side", () => {
  /**
   * The whole point of this component. Drawing `not-offered` and
   * `advertised` the same way is the one failure it exists to prevent, so
   * this is the test that has to go red if a future edit ever collapses the
   * two renderings into one — whether by unifying the state text, the row
   * class, or both.
   */
  it("renders different text and a different class for each state", () => {
    const wrapper = mountFacts([
      { label: "aim", state: "not-offered" },
      { label: "zoom", state: "advertised", reason: "accepted, does not reshape the feed" },
    ]);
    const rows = wrapper.findAll(".y-facts__row");
    expect(rows).toHaveLength(2);
    const [notOffered, advertised] = rows;
    expect(notOffered!.find(".y-facts__state").text())
      .not.toBe(advertised!.find(".y-facts__state").text());
    expect(notOffered!.classes()).not.toEqual(advertised!.classes());
  });
});
