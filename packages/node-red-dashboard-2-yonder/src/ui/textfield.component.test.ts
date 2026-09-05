// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderTextField from "./YonderTextField.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderTextField` is not one of those: what it emits, and what it caps a
 * value to, are decisions made in this component's own `onInput`, and
 * getting either wrong is invisible in the gallery — a specimen renders a
 * box with text in it whether or not typing past the limit is actually
 * refused. So both are asserted here, against a real `input` event, rather
 * than inferred from the source.
 *
 * A part (`docs/superpowers/plans/2026-09-04-console-instrument-library.md`'s
 * File Structure table), not a Node-RED widget in its own right — no `id`,
 * no `$dataTracker`, no `$store`. A future node composes it the way
 * `field()` below does: plain props, nothing else.
 */
function field(props: { label?: string; value?: string; placeholder?: string; hint?: string; max?: number }) {
  return mount(YonderTextField, { props });
}

describe("mounting", () => {
  it("mounts the .vue file and renders the label and the current value", () => {
    const w = field({ label: "Name", value: "Cam 1" });
    expect(w.find(".y-tf__label").text()).toBe("Name");
    expect((w.find("input").element as HTMLInputElement).value).toBe("Cam 1");
  });

  it("omits the label row when none is configured", () => {
    expect(field({ value: "Cam 1" }).find(".y-tf__label").exists()).toBe(false);
  });
});

/**
 * The coordinator's own resolution, verbatim (task-15-brief.md's
 * "Coordinator's resolutions" §1). Mine to use, not to rewrite.
 */
describe("typing — every keystroke, capped, counted while focused", () => {
  it("the text field emits on every keystroke, caps at 24, and shows n/24 while focused", async () => {
    const w = field({ value: "Cam 1", max: 24 });
    const input = w.find("input");
    await input.setValue("Nose");
    expect(w.emitted("update:value")!.at(-1)).toEqual(["Nose"]);
    await input.trigger("focus");
    expect(w.text()).toContain("4/24");
    await input.setValue("x".repeat(40));
    expect((input.element as HTMLInputElement).value).toHaveLength(24);
    expect(w.emitted("update:value")!.at(-1)![0]).toHaveLength(24);
  });

  /**
   * The verbatim test above always types through a field whose *starting*
   * value is short. A cap enforced only in `onInput` would leave a value
   * that already exceeds `max` at mount time — one arriving from a stored
   * configuration written before `max` was tightened, say — displayed in
   * full and only trimmed on the next keystroke. Mutation-checked (see
   * task-15-report.md): dropping the cap from the component's own initial
   * `local` turns this test red while the verbatim test above stays green.
   */
  it("caps a value that already exceeds max when the field is first mounted", () => {
    const w = field({ value: "x".repeat(40), max: 24 });
    expect((w.find("input").element as HTMLInputElement).value).toHaveLength(24);
  });

  /**
   * **What the verbatim test above cannot tell apart, and this does.**
   * `@vue/test-utils`'s own `setValue()` triggers `input` *and* `change` on
   * every call (source: it exists to also support `v-model.lazy`), so a
   * component wired to `@change` instead of `@input` — which in a real
   * browser fires only on blur or Enter, not per keystroke, exactly the
   * "only commits when you leave the field" bug "every keystroke" rules
   * out — passes the verbatim test above unchanged. Mutation-checked (see
   * task-15-report.md): switching the template's `@input` to `@change`
   * left all five other tests in this file green. This test fires a bare
   * `input` event with no accompanying `change`, so only a handler truly
   * bound to `input` can answer it.
   */
  it("emits from the input event itself, not only from the change event setValue() also fires", async () => {
    const w = field({ value: "", max: 24 });
    const input = w.find("input");
    (input.element as HTMLInputElement).value = "N";
    await input.trigger("input");
    expect(w.emitted("update:value")?.at(-1)).toEqual(["N"]);
  });

  it("shows no counter until the field is focused, and hides it again on blur", async () => {
    const w = field({ value: "Cam 1", max: 24 });
    const input = w.find("input");
    expect(w.find(".y-tf__count").exists()).toBe(false);
    await input.trigger("focus");
    expect(w.find(".y-tf__count").exists()).toBe(true);
    await input.trigger("blur");
    expect(w.find(".y-tf__count").exists()).toBe(false);
  });
});
