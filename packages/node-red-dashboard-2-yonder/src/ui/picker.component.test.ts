// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import YonderPicker from "./YonderPicker.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderPicker` is not one of those. Which of the camera's own entries a
 * menu offers, what it emits when one is chosen, and which of the four
 * capability states (R-UI-20, R-UI-21) it draws — and in which tone — are
 * all decisions made in this component's own template. Getting any of them
 * wrong is invisible in a screenshot the same way it always is in this
 * library: a control drawn disabled looks identical whether it is a fault
 * (`advertised`) or by design (`gated`) until you read the colour and the
 * words, which is exactly the distinction this file exists to prove against
 * a real mount rather than infer from the source.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes it
 * the way `picker()` below does: plain props, nothing else.
 */
function picker(props: {
  label?: string;
  value?: string;
  options?: Array<{ value: string; label: string }>;
  state?: string;
  reason?: string;
}) {
  return mount(YonderPicker, { props });
}

describe("mounting", () => {
  it("mounts the .vue file, renders the label, and shows the selected option's own label", () => {
    const w = picker({
      label: "Auto exposure",
      value: "3",
      options: [
        { value: "1", label: "Manual" },
        { value: "3", label: "Aperture priority" },
      ],
    });
    expect(w.find(".y-pick__label").text()).toBe("Auto exposure");
    expect(w.find("select").exists()).toBe(true);
    expect(w.find(".y-pick__value").text()).toBe("Aperture priority");
  });

  it("omits the label row when none is configured", () => {
    expect(picker({ value: "3", options: [{ value: "3", label: "Aperture priority" }] }).find(".y-pick__label").exists()).toBe(false);
  });
});

/**
 * The coordinator's own resolution, verbatim (task-16-brief.md's
 * "Coordinator's resolutions" §1). Mine to use, not to rewrite.
 */
describe("options — exactly the device's own entries (R-CAM-14)", () => {
  it("offers exactly the options given — menu ids 1 and 3 are two options, never four", () => {
    // The bench camera's `auto_exposure` reports min=0 max=3 and offers ids 1
    // and 3 only. Expanding a menu's range would put two modes on the page the
    // camera does not have, which R-CAM-14 exists to prevent, and the parser
    // keeps the device's own entries for exactly this reason.
    const w = picker({ options: [{ value: "1", label: "Manual" }, { value: "3", label: "Aperture priority" }] });
    const opts = w.findAll("option");
    expect(opts).toHaveLength(2);
    expect(opts.map((o) => o.attributes("value"))).toEqual(["1", "3"]);
  });
});

describe("emitting — a real select, not a div listening for clicks", () => {
  it("emits the chosen value", async () => {
    const w = picker({
      value: "1",
      options: [{ value: "1", label: "Manual" }, { value: "3", label: "Aperture priority" }],
    });
    await w.find("select").setValue("3");
    expect(w.emitted("change")?.[0]).toEqual(["3"]);
  });

  /**
   * **What the test above cannot tell apart, and this does (coordinator
   * resolution 5).** `@vue/test-utils`'s own `setValue()` triggers `input`
   * *and* `change` on every call, so a component wired to `@input` instead
   * of `@change` would pass the test above exactly as well as a correct
   * one — the same trap `textfield.component.test.ts` records, the other
   * way round: there the component had to depend on `input` and `setValue`'s
   * bundled `change` masked a wrong `@change` binding; here it depends on
   * `change`, and `setValue`'s bundled `input` would equally mask a wrong
   * `@input` binding. This fires a bare `change` event with no accompanying
   * `input`, so only a handler truly bound to `change` can answer it.
   */
  it("emits from the change event itself, not only from whatever else setValue() also fires", async () => {
    const w = picker({
      value: "1",
      options: [{ value: "1", label: "Manual" }, { value: "3", label: "Aperture priority" }],
    });
    const select = w.find("select");
    (select.element as HTMLSelectElement).value = "3";
    await select.trigger("change");
    expect(w.emitted("change")?.at(-1)).toEqual(["3"]);
  });
});

describe("present — the plain state", () => {
  it("leaves the select enabled", () => {
    const w = picker({ value: "3", options: [{ value: "3", label: "Aperture priority" }], state: "present" });
    expect(w.find("select").attributes("disabled")).toBeUndefined();
  });

  it("shows no reason row when none is given", () => {
    const w = picker({ value: "3", options: [{ value: "3", label: "Aperture priority" }], state: "present" });
    expect(w.find(".y-pick__why").exists()).toBe(false);
  });
});

/**
 * The coordinator's own resolution, verbatim (task-16-brief.md's
 * "Coordinator's resolutions" §1). Mine to use, not to rewrite.
 */
describe("advertised — a fault, in the caution tone, carrying its reason", () => {
  it("draws advertised disabled, in the caution tone, carrying its reason", () => {
    const w = picker({ state: "advertised", reason: "the frame never moved", options: [{ value: "1", label: "Manual" }], value: "1" });
    expect(w.find("select").attributes("disabled")).toBeDefined();
    const why = w.find(".y-pick__why");
    expect(why.classes()).toContain("why-advertised");
    expect(why.classes()).not.toContain("why-gated");
    expect(why.text()).toContain("the frame never moved");
  });
});

/**
 * `task-16-brief.md`'s Step 1, stem given verbatim; the mount call is mine
 * to supply. The assertions on `.y-pick__why` are the brief's own text.
 */
describe("gated — not a fault, in the neutral tone, naming the way back (R-UI-21)", () => {
  it("draws gated disabled, in the neutral tone, naming the way back — and never in caution", () => {
    const w = picker({
      state: "gated",
      reason: "while auto exposure is aperture priority",
      options: [{ value: "1/125", label: "1/125" }],
      value: "1/125",
    });
    expect(w.find("select").attributes("disabled")).toBeDefined();
    const why = w.find(".y-pick__why");
    expect(why.classes()).toContain("why-gated");
    expect(why.classes()).not.toContain("why-advertised");
    expect(why.text()).toContain("while auto exposure is aperture priority");
  });
});

describe("not-offered — draws nothing at all (R-UI-20)", () => {
  it("draws nothing at all when not offered", () => {
    expect(picker({ state: "not-offered" }).find("select").exists()).toBe(false);
  });

  /**
   * The test above only proves the select is gone; a component that kept
   * its outer wrapper (and its label, if one was configured) rendered while
   * hiding just the `<select>` would still pass it. "Renders nothing at
   * all" means the wrapper too — a picker that drew an empty box where its
   * control would have been would be stating this camera's absence a second
   * time, in a second silence, beside `YonderFacts`' own.
   */
  it("renders no wrapper at all, not merely an empty one", () => {
    const w = picker({ state: "not-offered", label: "Aim", options: [{ value: "1", label: "Manual" }] });
    expect(w.find(".y-pick").exists()).toBe(false);
  });
});

describe("layout", () => {
  it("has a maximum width", () => {
    const w = picker({ value: "3", options: [{ value: "3", label: "Aperture priority" }] });
    expect(getComputedStyle(w.find(".y-pick__control").element).maxWidth).not.toBe("none");
  });

it("associates its label with its select, and gives each instance its own id", () => {
    // A span beside a control is not a label: the accessible name was fine,
    // but clicking the word did nothing. And a deck draws many pickers at
    // once, so a shared id would point every label at the first select.
    const a = picker({ label: "Exposure", state: "present" });
    const b = picker({ label: "White balance", state: "present" });
    const forA = a.find("label").attributes("for");
    expect(forA).toBeTruthy();
    expect(a.find("select").attributes("id")).toBe(forA);
    expect(b.find("label").attributes("for")).not.toBe(forA);
});

it("takes its id from a counter, not from a Vue 2 property that does not exist here", () => {
    // The fix this guards shipped without a test, and review caught that by
    // reverting it: all thirteen tests still passed. The uniqueness test
    // above only asks that two ids differ, which two random strings do
    // near-certainly — so it could not tell a counter from the fallback the
    // bug was landing in. `this._uid` is Vue 2's; here it warned on every
    // mount and fell through to `Math.random().toString(36)`.
    //
    // Assert the shape a counter produces and the shape random does not, and
    // assert the warning is gone, because the warning is what an operator's
    // console was actually filling up with.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
        const id = picker({ label: "Exposure", state: "present" }).find("select").attributes("id");
        expect(id, "a counter gives digits; Math.random().toString(36) gives letters too")
            .toMatch(/^y-pick-\d+$/);
        expect(
            warn.mock.calls.flat().join(" "),
            "mounting a picker must not warn about a property that does not exist",
        ).not.toContain("_uid");
    } finally {
        warn.mockRestore();
    }
});
});
