// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import YonderHoldKey from "./YonderHoldKey.vue";

/**
 * `YonderHoldKey` carries a state machine — four release paths and two
 * duplicate-collapse guards — that the rest of this package's Vue components
 * do not have. `nodes.test.ts` explains why the other seven are not
 * unit-tested: they draw what they are given and decide nothing, so
 * asserting their output against a mocked Dashboard would only assert that
 * the mock behaves like the mock.
 *
 * This component decides. What is asserted below is `this.$socket.emit(...)`
 * — a call made by this component's own code, on its own `held` state, in
 * response to real DOM events dispatched at a really-mounted component. That
 * is our logic, not Dashboard's runtime, which is why a bare
 * `{ emit: vi.fn() }` standing in for `$socket` is both cheap and honest: it
 * is the entire surface this component touches on the object Dashboard
 * injects. Nothing here asserts what the component draws.
 *
 * None of this invents new behaviour. Task 12 watched every one of these
 * paths fire in a real browser on a real pointer surface; this file locks
 * that observation in place so a future edit cannot silently drop one the
 * way `pointercancel` and `pointerleave` already had, unnoticed, behind a
 * 32/32 green suite.
 */

const ACTION = "fullrate";
const LABEL = "Full rate";

function mountKey() {
  const emit = vi.fn();
  const wrapper = mount(YonderHoldKey, {
    props: {
      id: "n1",
      props: { label: LABEL, action: ACTION },
    },
    global: {
      provide: {
        $socket: { emit },
        $dataTracker: () => {},
      },
    },
  });
  return { wrapper, emit };
}

/**
 * Dispatched as a plain `Event`, not through `wrapper.trigger()` and not as
 * a `PointerEvent`. Vue's compiled template registers these handlers with
 * ordinary `addEventListener(type, …)`, which fires for any dispatched event
 * of that type regardless of which constructor built it — so a base `Event`
 * reaches the same listener a real pointer gesture would, without this
 * suite depending on the DOM environment's `Pointer*` fidelity.
 */
function fire(wrapper: VueWrapper, type: string): void {
  wrapper.element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

function goHidden(): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  // Leave `document.hidden` as later tests, and jsdom itself, expect it.
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("mounting", () => {
  it("mounts the .vue file and renders its label", () => {
    // Step 1: prove the harness — jsdom and the Vue plugin wired into
    // vitest.config.ts — works at all, before trusting it with a state
    // machine.
    const { wrapper } = mountKey();
    expect(wrapper.find(".y-hold__label").text()).toBe(LABEL);
  });
});

describe("one press, one release", () => {
  it("a press emits exactly one down, with the action:down payload", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("widget-action", "n1", { payload: "fullrate:down", topic: LABEL });
  });

  it("pointerup releases, with the action:up payload", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerup");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("pointercancel releases — the browser taking the gesture away", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointercancel");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("pointerleave releases — a finger or cursor dragged off the key while held", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerleave");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("a genuine visibilitychange to hidden releases, with no explicit release", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    goHidden();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });
});

describe("duplicate edges collapse", () => {
  it("two release events for one press emit exactly one up", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerleave");
    // The browser can still deliver the pointerup a moment after a
    // pointerleave already released — the up() guard is what stops that
    // becoming a second `up`.
    fire(wrapper, "pointerup");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("a second down with no release between does not emit twice", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("widget-action", "n1", { payload: "fullrate:down", topic: LABEL });
  });
});

describe("teardown", () => {
  it("a component torn down mid-hold still releases", () => {
    const { wrapper, emit } = mountKey();
    fire(wrapper, "pointerdown");
    wrapper.unmount();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });
});
