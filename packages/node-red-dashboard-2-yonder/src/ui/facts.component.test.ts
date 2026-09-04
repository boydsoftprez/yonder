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
 * wrong is exactly the failure R-UI-20 exists to prevent: an operator must be
 * able to tell *this camera cannot* from *this page failed*. `capability.ts`
 * says the `advertised` state is the one most likely to be got wrong in code,
 * because on the wire it is indistinguishable from success — so the markup
 * that tells the two apart is what is asserted here, mounted for real rather
 * than inferred from the source.
 */
function mountFacts(facts: CapabilityFact[], title = "") {
  return mount(YonderFacts, {
    props: { id: "n1", props: { title, facts } },
    // `$store: undefined` rather than omitted: Dashboard always installs one,
    // and a component read before any message has arrived is the case these
    // mounts stand for. Declaring it absent exercises that path without Vue
    // warning about a property that was never defined.
    global: { provide: { $dataTracker: () => {} }, mocks: { $store: undefined } },
  });
}

/**
 * The same component with a message on it, the way Dashboard delivers one.
 *
 * `$store` and not a prop, because that is where Dashboard actually puts an
 * incoming payload — see the note in YonderDataBar about why vuex cannot be
 * imported here.
 */
function mountWithMessage(configured: CapabilityFact[], payload: unknown) {
  return mount(YonderFacts, {
    props: { id: "n1", props: { title: "", facts: configured } },
    global: {
      provide: { $dataTracker: () => {} },
      mocks: { $store: { state: { data: { messages: { n1: { payload } } } } } },
    },
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
      { label: "focus", state: "undrawn" },
    ]);
    const rows = wrapper.findAll(".y-facts__row");
    expect(rows).toHaveLength(3);
    const said = rows.map((r) => r.find(".y-facts__state").text());
    expect(new Set(said).size).toBe(3);
    const classes = rows.map((r) => r.classes().join(" "));
    expect(new Set(classes).size).toBe(3);
  });

  /**
   * **The camera has it and this page does not draw it**, which is a fact
   * about the console rather than about the device — and the sentence for a
   * capability the camera does not have would be a lie about the camera.
   */
  it("says a capability is offered but not on this page, not that the camera lacks it", () => {
    const wrapper = mountFacts([{ label: "Zoom", state: "undrawn" }]);
    const said = wrapper.find(".y-facts__state").text();
    expect(said).toBe("offered, not on this page");
    expect(said).not.toContain("none");
  });

  it("names a state it does not know rather than asserting the camera lacks it", () => {
    // The rendering was a binary ternary, so *every* state that was not
    // `advertised` read "this camera has none" — and a state added to
    // `capability.ts` later would have had the console asserting a camera
    // lacks something it knows nothing about. `shapes.ts` imports the type to
    // stop that drift and cannot reach here: this template is untyped JS.
    const wrapper = mountFacts([
      { label: "Zoom", state: "partial" } as unknown as CapabilityFact,
    ]);
    const said = wrapper.find(".y-facts__state").text();
    expect(said).toContain("partial");
    expect(said).not.toContain("none");
  });
});

/**
 * **What arrived, in preference to what was configured.**
 *
 * A capability list written into `flows.json` is a *stored* list, and R-CAM-14
 * exists because a stored list is a stale list the first time a lens, a
 * firmware or the camera itself changes: a page confidently telling an
 * operator their camera cannot record, about a camera that can. The daemon
 * computes these from what the device answered a moment ago and sends them on
 * `payload.facts`.
 */
describe("the live answer", () => {
  it("draws what the device answered rather than what the flow was configured with", () => {
    const wrapper = mountWithMessage(
      [{ label: "Aim", state: "not-offered" }],
      { facts: [{ label: "Recording", state: "not-offered" }] },
    );
    const labels = wrapper.findAll(".y-facts__label").map((n) => n.text());
    expect(labels).toEqual(["Recording"]);
  });

  it("draws the configured list until the first message arrives, so an empty page is not mistaken for a failed one", () => {
    const wrapper = mountWithMessage([{ label: "Aim", state: "not-offered" }], undefined);
    expect(wrapper.findAll(".y-facts__label").map((n) => n.text())).toEqual(["Aim"]);
  });

  it("ignores a payload carrying no facts at all rather than blanking the row", () => {
    const wrapper = mountWithMessage(
      [{ label: "Aim", state: "not-offered" }],
      { camera: { id: "front" } },
    );
    expect(wrapper.findAll(".y-facts__label").map((n) => n.text())).toEqual(["Aim"]);
  });

  it("draws an empty row when the device answered every capability, and says nothing", () => {
    const wrapper = mountWithMessage([{ label: "Aim", state: "not-offered" }], { facts: [] });
    expect(wrapper.findAll(".y-facts__row")).toHaveLength(0);
  });
});
