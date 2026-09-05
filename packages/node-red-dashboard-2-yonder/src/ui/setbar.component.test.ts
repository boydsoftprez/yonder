// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderSetBar from "./YonderSetBar.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderSetBar` is not one of those, and it is the one part in this
 * library whose design the operator has already corrected in person: an
 * earlier draft filled the track to the device's value and closed it with
 * a tick (the shape of a slider) beside a hollow ring for the pending value
 * (the shape of a thumb) — two things that looked grabbable, one of them
 * inert, and he read it as two handles inside a minute of using it. The
 * corrected shape keeps exactly one mark on the track at all — `.y-sb__req`
 * — and this file's first `describe` block exists to keep it that way.
 *
 * Three traps sit underneath the tests below, all confirmed by hand before
 * writing a single assertion against them, not assumed:
 *
 * 1. **`jsdom` performs no layout.** `getBoundingClientRect()` on the track
 *    returns a real `DOMRect` with `width` (and `left`) reading zero —
 *    checked directly against this repository's own installed jsdom.
 *    Converting a press to a value by `(clientX - rect.left) / rect.width`
 *    is therefore `x / 0` under every test in this file, and the
 *    "clamps to the device's bounds" test below is written to fail loudly
 *    if that ever happens again: a component that resolves every press to
 *    fraction 0 emits `min` where that test demands `max`. `YonderSetBar.vue`
 *    answers this by driving the pointer geometry from `TRACK_WIDTH`, the
 *    same constant that sets the track's own rendered width, rather than
 *    from a measurement of it — see that constant's own comment.
 *
 * 2. **`(3.05).toFixed(1)` reads `"3.0"`, not `"3.1"`, in this project's own
 *    Node** (checked directly) — the coordinator's own second worked
 *    example for the precision test below, and a plain
 *    `actual.toFixed(precision)` fails it outright, before any mutation is
 *    involved. `YonderSetBar.vue`'s `fixed()` helper nudges by
 *    `Number.EPSILON` before rounding for exactly this reason.
 *
 * 3. **`@vue/test-utils@2.5.0`'s own `trigger("pointerdown", { clientX })`
 *    throws in this project's installed jsdom** — also checked directly,
 *    against this exact `node_modules`, before writing `press()` below.
 *    `createDOMEvent` builds the event correctly on its first pass (a real
 *    `PointerEvent`, `clientX` included, is exactly what its own
 *    constructor call produces) and then, on a second, unconditional pass,
 *    tries to *patch* every key of the options object onto the constructed
 *    event again, guarded by
 *    `Object.getOwnPropertyDescriptor(prototype, key)`. jsdom's
 *    `PointerEvent` inherits `clientX` from `MouseEvent.prototype` rather
 *    than redeclaring it, so that lookup finds nothing directly on
 *    `PointerEvent.prototype`, the guard wrongly concludes the property is
 *    assignable, and the resulting `event.clientX = 40` throws — "Cannot
 *    set property clientX of #<MouseEvent> which has only a getter" — on
 *    every one of this file's own tests that carry a coordinate, before a
 *    single one of their assertions runs. `YonderHoldKey`'s own test file
 *    dispatches its pointer events directly rather than through `trigger()`
 *    for the same class of reason ("without this suite depending on the
 *    DOM environment's Pointer* fidelity"); `press()` below is the
 *    coordinate-carrying version of that same choice — it never reaches
 *    `createDOMEvent`'s second, buggy pass at all, because the constructor
 *    already sets `clientX` correctly on its own.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes
 * it the way `bar()` below does: plain props, nothing else.
 */
function bar(props: {
  label?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  actual?: number;
  commanded?: number | null;
  requested?: number | null;
  state?: string;
  reason?: string;
  fine?: string;
  readonly?: boolean;
}) {
  return mount(YonderSetBar, { props });
}

/** See trap 3 above. A real `PointerEvent`, dispatched directly, with
 * `clientX` set the one way this environment does not choke on: through
 * the constructor's own init dict. */
function press(el: Element, clientX: number) {
  el.dispatchEvent(new PointerEvent("pointerdown", { clientX, bubbles: true, cancelable: true }));
}

describe("formatting the device's own reading", () => {
  /**
   * The coordinator's own resolution, verbatim (task-18-brief.md's
   * "Coordinator's resolutions" §1). Mine to use, not to rewrite.
   */
  it("formats the device's value to its precision", () => {
    const w = bar({ actual: 15600, precision: 0, unit: "µs" });
    expect(w.find(".y-sb__val").text()).toBe("15600 µs");
    const w2 = bar({ actual: 3.05, precision: 1, unit: "Mb/s" });
    expect(w2.find(".y-sb__val").text()).toBe("3.1 Mb/s");
  });

  /**
   * Not one of the coordinator's four, and closing a real gap in the one
   * above: `3.05 * 10` happens to land on exactly `30.5` in IEEE 754, so
   * the test above passes whether or not `fixed()`'s `Number.EPSILON`
   * nudge is there at all (confirmed: removing the nudge left it green).
   * `1.005 * 100` is the classic case that does not land cleanly —
   * `100.49999999999999` — and rounds to `1.00` without the nudge,
   * `1.01` with it (confirmed both ways directly before writing this).
   */
  it("formats a value the nudge, not the multiply, gets right", () => {
    const w = bar({ actual: 1.005, precision: 2 });
    expect(w.find(".y-sb__val").text()).toBe("1.01");
  });

  it("never uppercases its unit; has a fixed track width", () => {
    const w = bar({ actual: 15600, unit: "µs" });
    expect(getComputedStyle(w.find(".y-sb__u").element).textTransform).toBe("none");
    expect(getComputedStyle(w.find(".y-sb__trk").element).width).toBe("220px");
  });
});

describe("three marks, and only one of them a control", () => {
  /**
   * The coordinator's own resolution, verbatim.
   */
  it("draws a commanded mark only when it differs from the actual", () => {
    expect(bar({ actual: 3000, commanded: 3000 }).findAll(".y-sb__cmd")).toHaveLength(0);
    expect(bar({ actual: 3000, commanded: 4000 }).findAll(".y-sb__cmd")).toHaveLength(1);
  });

  /**
   * Not one of the coordinator's four. The test above only checks exact
   * equality against a clear difference, which a plain `commanded !==
   * actual` — dropping the "half a step" threshold `YonderSetBar.vue`
   * actually uses — would pass exactly as well as a correct implementation
   * (confirmed: that mutation left the test above green). This closes the
   * gap it leaves open: a difference smaller than half the device's own
   * step is noise, not a fact worth a mark.
   */
  it("does not draw a commanded mark for a difference smaller than half the step", () => {
    expect(bar({ actual: 3000, commanded: 3000.4, step: 1 }).findAll(".y-sb__cmd")).toHaveLength(0);
  });

  /**
   * The coordinator's own resolution, verbatim.
   */
  it("draws a requested mark and the pending line when a draft exists", () => {
    const w = bar({ actual: 3000, requested: 5000 });
    expect(w.findAll(".y-sb__req")).toHaveLength(1);
    expect(w.text()).toContain("Pending");
  });

  /**
   * Not one of the coordinator's four — the given test above only exercises
   * the case where a draft exists. The one grabbable mark still draws with
   * no draft at all (it sits at `actual` until one exists, per the
   * component's own doc comment on `grabAt`), but the *pending line* is a
   * fact about a draft specifically and must not survive its absence.
   */
  it("does not show the pending line when there is no draft", () => {
    const w = bar({ actual: 3000 });
    expect(w.find(".y-sb__note").exists()).toBe(false);
    expect(w.text()).not.toContain("Pending");
  });

  /**
   * The brief's own worked example, verbatim (task-18-brief.md, the
   * "Exactly one mark may look draggable" section) — the fix for the exact
   * defect the operator found.
   */
  it("offers exactly one grabbable mark, whatever else it is drawing", () => {
    const w = bar({ actual: 3000, commanded: 4000, requested: 5000, state: "present" });
    expect(w.findAll("[data-grab]")).toHaveLength(1);
    expect(w.find("[data-grab]").attributes("aria-label")).toMatch(/requested|pending/i);
  });

  /**
   * Not one of the coordinator's four. The test above only exercises the
   * case where a draft already exists; this is the other half of `grabAt`'s
   * own "never none, never two" doc comment — before any draft exists at
   * all, the one grabbable mark still has to be somewhere, or an operator
   * would have nothing to press to create the first one.
   */
  it("still offers the one grabbable mark at the actual value when there is no draft yet", () => {
    const w = bar({ actual: 3000, state: "present" });
    expect(w.findAll("[data-grab]")).toHaveLength(1);
  });
});

describe("a press on the track — converted to a value, snapped, clamped", () => {
  /**
   * The brief's own worked example. Not the actual, which is the device's
   * own answer and not ours to change. (`press()`, not `.trigger()` — see
   * trap 3 in this file's own top comment.)
   */
  it("a press anywhere on the track moves the requested mark and nothing else", async () => {
    const w = bar({ actual: 3000, commanded: 4000, requested: 5000 });
    press(w.find(".y-sb__trk").element, 40);
    await w.vm.$nextTick();
    expect(w.emitted("set")).toHaveLength(1);
    expect(w.props("actual")).toBe(3000);
  });

  /**
   * Given in the plan text itself (not one of the coordinator's four
   * `…`-bodied tests — this one already had a body), with one fix:
   * `clientX: 91` against this range and track width snaps to -111600
   * (correctly — confirmed by hand), and `-111600 % 3600` is `-0` in IEEE
   * 754, not `0` — a real, distinct value under `Object.is`, which is what
   * vitest's own `.toBe()` uses. `expect(-111600 % 3600).toBe(0)` therefore
   * fails against a *correct* snap, not only a broken one — confirmed
   * directly before changing anything. The mathematical question this test
   * asks — is the emitted value an exact multiple of the step — has not
   * changed; wrapping it in a plain `=== 0` (regular equality, which does
   * not distinguish the sign of zero, unlike `Object.is`) before handing
   * the boolean to `.toBe()` is the fix, not a loosening of it.
   */
  it("snaps what it emits to the device's step", async () => {
    const w = bar({ min: -648000, max: 648000, step: 3600, actual: 0 });
    press(w.find(".y-sb__trk").element, 91);
    await w.vm.$nextTick();
    expect((w.emitted("set")![0] as [number])[0] % 3600 === 0).toBe(true);
  });

  /**
   * The coordinator's own resolution. `clientX: 100000` is far outside any
   * real viewport — deliberately, so a component that forgot to clamp the
   * fraction, or forgot to clamp the final value, both fail this the same
   * way: by emitting something other than the device's own ceiling.
   */
  it("clamps to the device's bounds", async () => {
    const w = bar({ min: 100, max: 4000, step: 100, actual: 2000 });
    press(w.find(".y-sb__trk").element, 100000);
    await w.vm.$nextTick();
    expect(w.emitted("set")!.at(-1)).toEqual([4000]);
  });
});

describe("gated — not a fault, in the neutral tone, naming the way back (R-UI-21)", () => {
  it("gated: an em dash, no pointer, the way back, and it emits nothing", async () => {
    const w = bar({ actual: 3000, state: "gated", reason: "while auto exposure is aperture priority" });
    expect(w.find(".y-sb__val").text()).toBe("——");
    expect(getComputedStyle(w.find(".y-sb__trk").element).cursor).toBe("not-allowed");
    const why = w.find(".y-sb__why");
    expect(why.classes()).toContain("why-gated");
    expect(why.classes()).not.toContain("why-advertised");
    expect(why.text()).toContain("aperture priority");
    press(w.find(".y-sb__trk").element, 40);
    await w.vm.$nextTick();
    expect(w.emitted("set")).toBeUndefined();
  });

  /**
   * The value is unknown while gated (hence the em dash above); a caret
   * planted at some numeric position on the track would contradict that.
   */
  it("draws neither reading mark while gated", () => {
    const w = bar({ actual: 3000, commanded: 4000, state: "gated", reason: "why" });
    expect(w.findAll(".y-sb__act")).toHaveLength(0);
    expect(w.findAll(".y-sb__cmd")).toHaveLength(0);
  });

  /**
   * The regression `YonderPicker` and `YonderSegmented` were each fixed for
   * in review (coordinator resolution 6): a disabled state that kept the
   * wash marking a live selection. `css: true` resolves the cascade but not
   * custom properties (resolution 5), so this asserts which *token* wins,
   * not a resolved colour — the resolved colours are checked in the
   * gallery, in both palettes.
   */
  it("never wears the live value colour while gated", () => {
    const gated = getComputedStyle(bar({ actual: 3000, state: "gated", reason: "why" }).find(".y-sb__val").element).color;
    const live = getComputedStyle(bar({ actual: 3000, state: "present" }).find(".y-sb__val").element).color;
    expect(gated).not.toBe(live);
    expect(gated).toContain("yonder-neutral");
    expect(live).toContain("yonder-value");
  });

  /**
   * A `<div>` track has no native `disabled` attribute the way a `<select>`
   * or a `<button>` does, so there is no HTML-level guard to isolate the
   * way `segmented.component.test.ts` isolates `disabled` from its own
   * internal guard. This is the one guard there is: dispatched directly,
   * the way a real browser delivers a *dispatched* pointerdown to a
   * listener regardless of what CSS says about `pointer-events`.
   */
  it("the guard inside down() stops the press even reaching a handler", async () => {
    const w = bar({ actual: 3000, state: "gated", reason: "why" });
    w.find(".y-sb__trk").element.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    await w.vm.$nextTick();
    expect(w.emitted("set")).toBeUndefined();
  });
});

describe("readonly — a live readout, not a fifth state (GOING OUT in Adaptive)", () => {
  it("readonly (GOING OUT in Adaptive) emits nothing on a press", async () => {
    const w = bar({ actual: 1800, readonly: true });
    press(w.find(".y-sb__trk").element, 40);
    await w.vm.$nextTick();
    expect(w.emitted("set")).toBeUndefined();
  });

  /**
   * `readonly` removes the one draggable mark entirely rather than merely
   * disabling it — the same reason `gated` and `advertised` never draw a
   * stray handle. Not one of the required tests, but the natural partner
   * of the one above: a readout that still offered something to grab would
   * be the exact defect this whole task exists to prevent, one state over.
   */
  it("offers no grabbable mark while readonly, even though state is present", () => {
    const w = bar({ actual: 1800, readonly: true, requested: 2000 });
    expect(w.findAll("[data-grab]")).toHaveLength(0);
  });

  /**
   * "The bar is a readout" (§6) means a readout, not a blank: the value
   * still shows, in its ordinary colour — a live reading, not a fault and
   * not gated, so it carries no special tone of its own.
   */
  it("still shows the actual reading, in its ordinary colour", () => {
    const w = bar({ actual: 1800, readonly: true, unit: "Mb/s", precision: 1 });
    expect(w.find(".y-sb__val").text()).toBe("1800.0 Mb/s");
    expect(w.findAll(".y-sb__act")).toHaveLength(1);
    expect(getComputedStyle(w.find(".y-sb__val").element).color).toContain("yonder-value");
  });
});

describe("advertised — a fault, in the caution tone, the reading stays (R-CTL-11…14)", () => {
  /**
   * Not one of the coordinator's four, but the same "follow the two
   * reviewed parts" instruction (resolution 6) applies to every state this
   * component shares with `YonderPicker`/`YonderSegmented`, not only the
   * two the required list names outright.
   */
  it("draws advertised disabled, in the caution tone, and the reading stays", async () => {
    const w = bar({ actual: 400, state: "advertised", reason: "accepted; stays at its own default", unit: "Mb/s", precision: 1 });
    expect(w.find(".y-sb__val").text()).toBe("400.0 Mb/s");
    expect(w.findAll(".y-sb__act")).toHaveLength(1);
    expect(getComputedStyle(w.find(".y-sb__trk").element).cursor).toBe("not-allowed");
    const why = w.find(".y-sb__why");
    expect(why.classes()).toContain("why-advertised");
    expect(why.classes()).not.toContain("why-gated");
    expect(why.text()).toContain("stays at its own default");
    press(w.find(".y-sb__trk").element, 40);
    await w.vm.$nextTick();
    expect(w.emitted("set")).toBeUndefined();
  });

  it("never wears the live value colour while advertised", () => {
    const advertised = getComputedStyle(bar({ actual: 400, state: "advertised", reason: "why" }).find(".y-sb__val").element).color;
    const live = getComputedStyle(bar({ actual: 400, state: "present" }).find(".y-sb__val").element).color;
    expect(advertised).not.toBe(live);
    expect(advertised).toContain("yonder-waiting");
  });
});

describe("not-offered — draws nothing at all (R-UI-20)", () => {
  it("renders no wrapper at all, not merely an empty one", () => {
    const w = bar({ actual: 3000, state: "not-offered", label: "Bitrate" });
    expect(w.find(".y-sb").exists()).toBe(false);
    expect(w.html().replace(/<!--.*?-->/g, "").trim()).toBe("");
  });

it("rounds a negative value the same way it rounds a positive one", () => {
    // Found in review by measurement: an unsigned epsilon nudge only ever
    // pushes upward, so it corrects the positive half-boundaries and breaks
    // the negative ones — `(-4.995).toFixed(2)` is already right at -5.00 and
    // an unsigned nudge makes it -4.99. Dormant only because nothing shipped
    // draws a negative fraction yet, and this component already takes
    // negative ranges: the gimbal's pan is min -648000.
    expect(bar({ actual: -4.995, precision: 2, unit: "dB" }).find(".y-sb__val").text())
        .toBe("-5.00 dB");
    expect(bar({ actual: 4.995, precision: 2, unit: "dB" }).find(".y-sb__val").text())
        .toBe("5.00 dB");
    // And zero stays zero rather than acquiring a sign.
    expect(bar({ actual: 0, precision: 1, unit: "dB" }).find(".y-sb__val").text())
        .toBe("0.0 dB");
});

it("offers a press target larger than the bar it paints", () => {
    // The blueprint grew the hit area with a transparent border and kept the
    // painted bar at its own size with background-clip. Dropping that shrank
    // the target to the visible 220x10 — a silent regression review caught.
    // A notebook is the primary surface, but a tablet is a real one.
    const trk = getComputedStyle(bar({ actual: 2000 }).find(".y-sb__trk").element);
    expect(trk.borderTopWidth).not.toBe("0px");
    expect(trk.borderTopStyle).toBe("solid");
    expect(trk.backgroundClip).toBe("padding-box");
    // content-box, so the border cannot eat the width the pointer maths assumes.
    expect(trk.boxSizing).toBe("content-box");
});

it("still says a draft is pending when the control cannot be pressed", () => {
    // Deliberate, and worth pinning because the combination looks like an
    // oversight. A draft is a fact about what an operator asked for on Setup;
    // whether the live control can be pressed right now is a different fact.
    // Hiding the pending line on a gated or readonly bar would lose the first
    // to the second, and an operator would find an unexplained change waiting
    // on Setup. Zero grabbable marks, and the line still shown.
    for (const props of [{ state: "gated", reason: "while auto exposure is aperture priority" },
                         { readonly: true }]) {
        const w = bar({ actual: 1800, requested: 2000, ...props });
        expect(w.findAll("[data-grab]"), "a bar that cannot be pressed offers no handle").toHaveLength(0);
        expect(w.text(), "but the draft is still declared").toContain("Pending");
    }
});
});
