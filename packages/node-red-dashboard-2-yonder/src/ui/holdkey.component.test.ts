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

function mountKey(payload?: unknown, configured: Record<string, unknown> = {}) {
  const emit = vi.fn();
  const wrapper = mount(YonderHoldKey, {
    props: {
      id: "n1",
      props: { label: LABEL, action: ACTION, ...configured },
    },
    global: {
      provide: {
        $socket: { emit },
        $dataTracker: () => {},
      },
      // Where Dashboard puts what the flow sent this widget. Absent is the
      // state before the first message, which is what the editor field is
      // the fall-back for.
      mocks: payload === undefined
        ? { $store: undefined }
        : { $store: { state: { data: { messages: { n1: { payload } } } } } },
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

/**
 * **What holding this costs, and whether it can be held at all** (R-VID-11,
 * R-UI-20).
 *
 * Both were editor fields and nothing else: the cost was one configuration's
 * number frozen at deploy time, and the key was drawn whether or not the
 * stream it asks for exists.
 */
describe("the cost, and whether there is anything to hold", () => {
  /**
   * **Both defaults used to fail open.** `sent.available !== false` read
   * `undefined` as available, and an empty configured cost meant
   * `v-if="cost"` drew nothing at all — so for the couple of seconds before
   * the first read, a camera with no RTSP output was pressable and looked
   * exactly like one that was ready. "Not known yet" and "this camera
   * cannot" are different facts; only the second one means pressing is a 404
   * waiting to happen, and the honest state before either is known is
   * unavailable.
   */
  it("is disabled, and says 'not known yet', before any message has arrived", () => {
    const { wrapper, emit } = mountKey();
    expect(wrapper.attributes("disabled")).toBeDefined();
    expect(wrapper.find(".y-hold__cost").text()).toBe("not known yet");

    // Belt as well as the attribute, as the known-unavailable case below
    // does: this component must not be relying on the browser alone.
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerup");
    expect(emit).not.toHaveBeenCalled();
  });

  it("is enabled with its cost once a message names both", () => {
    const { wrapper, emit } = mountKey({ available: true, cost: "2.07 Mb/s while held" });
    expect(wrapper.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".y-hold__cost").text()).toBe("2.07 Mb/s while held");

    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("draws the configured cost before a message has arrived", () => {
    const { wrapper } = mountKey(undefined, { cost: "2.07 Mb/s while held" });
    expect(wrapper.find(".y-hold__cost").text()).toBe("2.07 Mb/s while held");
  });

  it("prefers what the flow sent, because the configured one cannot move", () => {
    // Raise the camera's bitrate and this must move with it, or the page
    // contradicts the readout strip beside it and the operator acts on the
    // wrong one of the two.
    const { wrapper } = mountKey(
      { cost: "8.27 Mb/s while held", available: true },
      { cost: "2.07 Mb/s while held" },
    );
    expect(wrapper.find(".y-hold__cost").text()).toBe("8.27 Mb/s while held");
  });

  it("refuses to act, and says why, when there is no stream to ask for", () => {
    const { wrapper, emit } = mountKey({
      available: false,
      cost: "no full-rate stream on this camera; add an RTSP output",
    });
    expect(wrapper.find(".y-hold__cost").text()).toContain("no full-rate stream");
    expect(wrapper.attributes("disabled")).toBeDefined();

    // Belt as well as the attribute: a disabled button does not fire pointer
    // events in a browser, and this component must not be the thing relying
    // on that.
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerup");
    expect(emit).not.toHaveBeenCalled();
  });

  it("acts when the flow says the stream is there", () => {
    const { wrapper, emit } = mountKey({ available: true, cost: "2.07 Mb/s while held" });
    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// `{ available: true }` throughout this file from here on: these tests are
// about the press/release state machine, not about R-UI-20's guard, and the
// guard above now fails closed by default — a bare `mountKey()` would leave
// every `down()` below a no-op.
describe("one press, one release", () => {
  it("a press emits exactly one down, with the action:down payload", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("widget-action", "n1", { payload: "fullrate:down", topic: LABEL });
  });

  it("pointerup releases, with the action:up payload", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerup");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("pointercancel releases — the browser taking the gesture away", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointercancel");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("pointerleave releases — a finger or cursor dragged off the key while held", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerleave");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });

  it("a genuine visibilitychange to hidden releases, with no explicit release", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    goHidden();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });
});

describe("duplicate edges collapse", () => {
  it("two release events for one press emit exactly one up", () => {
    const { wrapper, emit } = mountKey({ available: true });
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
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    fire(wrapper, "pointerdown");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("widget-action", "n1", { payload: "fullrate:down", topic: LABEL });
  });
});

describe("teardown", () => {
  it("a component torn down mid-hold still releases", () => {
    const { wrapper, emit } = mountKey({ available: true });
    fire(wrapper, "pointerdown");
    wrapper.unmount();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("widget-action", "n1", { payload: "fullrate:up", topic: LABEL });
  });
});
