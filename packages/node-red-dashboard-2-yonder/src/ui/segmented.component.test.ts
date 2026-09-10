// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderSegmented from "./YonderSegmented.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderSegmented` is not one of those. Which option is marked chosen when
 * handed a value outside its own list, what it emits when one is pressed,
 * whether it stays capped to its own content instead of stretching to its
 * column, and which of the four capability states (R-UI-20, R-UI-21) it
 * draws disabled and in which tone are all decisions this component's own
 * template makes — and every one of them looks identical in a screenshot to
 * the wrong answer beside it (a disabled control reads the same whether it
 * is a fault or by design until you read the colour and the words), which
 * is exactly why each gets its own assertion against a real mount rather
 * than a read of the source.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes
 * it the way `seg()` below does: plain props, nothing else.
 */
function seg(props: { label?: string; value?: string; options?: string[]; state?: string; reason?: string }) {
  return mount(YonderSegmented, { props });
}

/**
 * The coordinator's own resolutions, verbatim (task-17-brief.md's
 * "Coordinator's resolutions" §1). Mine to mount, not to rewrite.
 */
describe("marking the chosen option — honestly, never a consolation prize", () => {
  it("marks exactly one option as chosen, whatever it is handed", () => {
    const w = seg({ options: ["Video", "Photo"], value: "Photo" });
    expect(w.findAll(".y-seg__opt.on")).toHaveLength(1);
    expect(w.find(".y-seg__opt.on").text()).toBe("Photo");
    // A value the options do not contain marks none of them, and must not
    // mark the first as a consolation — that would tell an operator the
    // camera is in a mode it is not in.
    const stray = seg({ options: ["Video", "Photo"], value: "Timelapse" });
    expect(stray.findAll(".y-seg__opt.on")).toHaveLength(0);
  });
});

describe("emitting — the option pressed, not its index", () => {
  it("emits the option pressed, not its index", async () => {
    const w = seg({ options: ["Video", "Photo"], value: "Video" });
    await w.findAll(".y-seg__opt")[1].trigger("click");
    expect(w.emitted("change")?.[0]).toEqual(["Photo"]);
  });
});

describe("layout — capped, never stretched to its column (R-UI-08)", () => {
  it("is capped and never stretches to its column", () => {
    const el = seg({ options: ["Video", "Photo"], value: "Video" }).find(".y-seg").element;
    const s = getComputedStyle(el);
    expect(s.maxWidth).not.toBe("none");
    expect(s.width).not.toBe("100%");
  });
});

describe("gated — not a fault, in the neutral tone, naming the way back (R-UI-21)", () => {
  it("gated: inert, neutral, and it names the way back", () => {
    const w = seg({
      options: ["Manual", "Auto"],
      value: "Auto",
      state: "gated",
      reason: "while auto exposure is aperture priority",
    });
    const why = w.find(".y-seg__why");
    expect(why.classes()).toContain("why-gated");
    expect(why.classes()).not.toContain("why-advertised");
    expect(why.text()).toContain("auto exposure");
  });
});

describe("the three states that never emit (R-UI-20, R-UI-21)", () => {
  it("emits nothing at all unless it is present", async () => {
    for (const state of ["gated", "advertised", "not-offered"]) {
      const w = seg({ options: ["Video", "Photo"], value: "Video", state });
      const opts = w.findAll(".y-seg__opt");
      if (opts.length) await opts[1].trigger("click");
      expect(w.emitted("change"), `${state} emitted a change`).toBeUndefined();
    }
  });

it("a gated control never wears the colour of a live selection", () => {
    // `.on` marks the chosen option in the select colour, which is this
    // console's mark for "live and selected". A gated control is neither, so
    // the state's own tone must win over it — the same way advertised's does
    // here, and the same way the picker's whole control goes neutral.
    const w = seg({ options: ["Manual", "Auto"], value: "Auto", state: "gated",
                    reason: "while auto exposure is aperture priority" });
    //
    // jsdom does not resolve custom properties, so `color` comes back as the
    // literal `var(--yonder-neutral, …)` rather than a colour, and an
    // unresolvable var in `border-color` reads as transparent. So this asserts
    // which *token* wins, which is the thing that can regress; the resolved
    // colours are checked in the gallery, in both palettes, by eye and by
    // getComputedStyle in a real browser.
    const gated = getComputedStyle(w.find(".y-seg__opt.on").element).color;
    const live = getComputedStyle(
        seg({ options: ["Manual", "Auto"], value: "Auto", state: "present" })
            .find(".y-seg__opt.on").element).color;
    expect(gated).not.toBe(live);
    expect(gated).toContain("yonder-neutral");
    expect(live).toContain("yonder-select");
});

it("not-offered draws no wrapper at all, not an empty one", () => {
    // The picker's suite has had this since Task 16; this one did not, and
    // deleting the root's v-if left every other test here green. An empty
    // bordered box and an absent control say different things to an operator
    // (R-UI-20): the deck states the fact where the control would have been.
    const w = seg({ options: ["Video", "Photo"], value: "Video", state: "not-offered" });
    expect(w.find(".y-seg").exists()).toBe(false);
    expect(w.html().replace(/<!--.*?-->/g, "").trim()).toBe("");
});

it("draws nothing at all when it has no options to offer, in any state", () => {
    // K-63's fourth part, guarded here rather than only in the caller. A
    // labelled group with no buttons in it is a control offering nothing —
    // R-UI-20 — and an operator cannot tell it from a control whose choices
    // failed to arrive. `YonderAim` states a fact where the control would
    // have been (`aim.component.test.ts`); this is the promise that stops
    // any *other* caller producing the empty box by forgetting to.
    for (const state of ["present", "advertised", "gated"]) {
        const w = seg({ options: [], value: "", state, reason: "why" });
        expect(w.find(".y-seg").exists(), `${state} drew an empty control`).toBe(false);
        expect(w.html().replace(/<!--.*?-->/g, "").trim()).toBe("");
    }
});

it("the disabled attribute alone stops the press", async () => {
    // These two isolate what the general "emits nothing" test cannot: it
    // passes with either protection removed, so it proves only their joint
    // absence. Caught in review, after a mutation report that removed the
    // guard and concluded `disabled` carried it — the symmetric mutation
    // was never run and tells the opposite story.
    const w = seg({ options: ["Video", "Photo"], value: "Video", state: "gated" });
    expect(w.findAll(".y-seg__opt").every((o) => o.attributes("disabled") !== undefined)).toBe(true);
});

it("the guard inside pick() stops the press even reaching a handler", async () => {
    // A real browser will deliver a *dispatched* click to a disabled
    // button's listener even though `.click()` will not, so `disabled` is
    // not a guarantee on its own. Dispatch it the way a browser would.
    const w = seg({ options: ["Video", "Photo"], value: "Video", state: "gated" });
    w.findAll(".y-seg__opt")[1].element.dispatchEvent(new Event("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("change")).toBeUndefined();
});

it("neither disabled state keeps the wash that marks a live selection", () => {
    // `.on` tints the chosen option with the select colour. Overriding only
    // the border and the text leaves that wash behind, so a control the
    // device is not delivering — or that another control holds — still reads
    // as the live, chosen one. Found in review for advertised after the same
    // defect was fixed for gated; check both so neither can drift back.
    const live = getComputedStyle(
        seg({ options: ["Video", "Photo"], value: "Photo", state: "present" })
            .find(".y-seg__opt.on").element).background;
    for (const state of ["advertised", "gated"]) {
        const off = getComputedStyle(
            seg({ options: ["Video", "Photo"], value: "Photo", state, reason: "why" })
                .find(".y-seg__opt.on").element).background;
        expect(off, `${state} kept the live selection's wash`).not.toBe(live);
    }
});
});
