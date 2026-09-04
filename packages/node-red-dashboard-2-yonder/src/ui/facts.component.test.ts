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
    ]);
    const rows = wrapper.findAll(".y-facts__row");
    expect(rows).toHaveLength(2);
    const [notOffered, advertised] = rows;
    expect(notOffered!.find(".y-facts__state").text())
      .not.toBe(advertised!.find(".y-facts__state").text());
    expect(notOffered!.classes()).not.toEqual(advertised!.classes());
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
