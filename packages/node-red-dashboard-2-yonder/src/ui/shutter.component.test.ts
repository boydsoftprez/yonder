// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import YonderShutter from "./YonderShutter.vue";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing.
 *
 * `YonderShutter` is not one of those, and it is the one part in this
 * whole task that starts something on the aircraft (R-CAM-17, coordinator
 * resolution 7): a press is a MAVLink-relayed record or capture command,
 * and this project's own rule is that Yonder relays commands and never
 * originates them (CLAUDE.md rule 4) — which makes a second, unasked-for
 * emission of the same command a small violation of that rule by this
 * component's own hand, not merely a cosmetic double-count. That guard, and
 * the mode-to-caption-to-event mapping beside it, are what this file tests
 * against a real mount rather than a read of the source.
 *
 * A plain part (`docs/superpowers/plans/2026-09-04-console-instrument-
 * library.md`'s File Structure table), not a Node-RED widget in its own
 * right — no `id`, no `$dataTracker`, no `$store`. A future node composes
 * it the way `key()` below does: plain props, nothing else.
 */
function key(props: {
  mode?: string;
  recording?: { since: number } | null;
  destination?: string;
  pending?: boolean;
} = {}) {
  return mount(YonderShutter, { props });
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The coordinator's own resolution (task-19-brief.md §7), verbatim: "reads
 * `RECORD` in video mode and `PHOTO` in photo mode, and emits accordingly."
 */
it("reads RECORD in video mode and PHOTO in photo mode; press emits record or photo", async () => {
  const video = key({ mode: "video" });
  expect(video.text()).toContain("RECORD");
  expect(video.text()).not.toContain("PHOTO");
  await video.find(".y-shutter__btn").trigger("click");
  expect(video.emitted("record")).toHaveLength(1);
  expect(video.emitted("photo")).toBeUndefined();

  const photo = key({ mode: "photo" });
  expect(photo.text()).toContain("PHOTO");
  expect(photo.text()).not.toContain("RECORD");
  await photo.find(".y-shutter__btn").trigger("click");
  expect(photo.emitted("photo")).toHaveLength(1);
  expect(photo.emitted("record")).toBeUndefined();
});

/**
 * The coordinator's own resolution, verbatim: "While recording it lights
 * and counts up from `recording.since`, with the destination beneath."
 *
 * Fake timers, not a real `setTimeout`: the counting is this component's
 * own `setInterval` advancing reactive state, and asserting it without
 * controlling the clock would make the test's own runtime the thing
 * deciding whether it passes.
 */
it("lights and counts from recording.since; the destination line beneath", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
  const since = Date.now() - 47_000; // 47 s of recording so far
  const w = key({ mode: "video", recording: { since }, destination: "to this board · 41 GB free" });

  expect(w.find(".y-shutter").classes()).toContain("is-recording");
  expect(w.text()).toContain("00:00:47");
  expect(w.find(".y-shutter__dest").text()).toBe("to this board · 41 GB free");

  // "Counts", not "shows a value once": the same mount, later, without a
  // second `recording.since` — the timer inside this component is what
  // has to move the reading on its own.
  vi.advanceTimersByTime(3000);
  await w.vm.$nextTick();
  expect(w.text()).toContain("00:00:50");
});

it("draws neither the lit ring nor a counter while not recording", () => {
  const w = key({ mode: "video", recording: null, destination: "to this board · 41 GB free" });
  expect(w.find(".y-shutter").classes()).not.toContain("is-recording");
  expect(w.text()).not.toMatch(/\d\d:\d\d:\d\d/);
  // The destination is a fact about where a press would go, independent of
  // whether one is under way — it stays visible either way.
  expect(w.find(".y-shutter__dest").text()).toBe("to this board · 41 GB free");
});

/**
 * Not one of the coordinator's three, and found only by mutation: dropping
 * `this.mode === 'video' &&` from `isRecording` left every test above
 * green, because none of them ever hands a `recording` object to a photo-
 * mode mount. Photo capture has no ongoing duration to light a ring or
 * count up for (§8.3) — a caller should never pass one in photo mode, but
 * this component does not have to trust that.
 */
it("never shows the recording ring or counter in photo mode, even if handed a recording object", () => {
  const w = key({ mode: "photo", recording: { since: Date.now() - 5000 } });
  expect(w.find(".y-shutter").classes()).not.toContain("is-recording");
  expect(w.text()).not.toMatch(/\d\d:\d\d:\d\d/);
});

/**
 * The coordinator's own resolution, verbatim: "A second press while a
 * press is pending emits nothing." Two independent guards, isolated the
 * way `segmented.component.test.ts` isolates `disabled` from `pick()`'s
 * own internal check (that file's own comment records why: crediting
 * either one alone with carrying it, on a mutation that only removed the
 * other, tells the opposite story from the one actually run) — real
 * workflow order: a press succeeds, the caller sets `pending` while it
 * awaits acknowledgement, and only *then* does a second press have
 * anything to be guarded against.
 */
describe("pending — the one guard in this whole task that stops an aircraft command", () => {
  it("a second press while pending emits nothing", async () => {
    const w = key({ mode: "video", pending: false });
    await w.find(".y-shutter__btn").trigger("click");
    expect(w.emitted("record")).toHaveLength(1);

    await w.setProps({ pending: true });
    await w.find(".y-shutter__btn").trigger("click");
    // Still exactly the one emit from before pending was set — not two.
    expect(w.emitted("record")).toHaveLength(1);
  });

  it("the disabled attribute alone stops the press", () => {
    const w = key({ mode: "video", pending: true });
    expect(w.find(".y-shutter__btn").attributes("disabled")).toBeDefined();
  });

  it("the guard inside press() stops it even reaching a handler", async () => {
    // A real browser delivers a *dispatched* click to a disabled button's
    // own listener even though `.click()` will not (the same fact
    // `setbar.component.test.ts` and `segmented.component.test.ts` each
    // record for their own controls) — dispatch it the way a browser
    // would, not through `.trigger()`, which `@vue/test-utils` makes skip
    // a disabled element entirely.
    const w = key({ mode: "video", pending: true });
    w.find(".y-shutter__btn").element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    await w.vm.$nextTick();
    expect(w.emitted("record")).toBeUndefined();
  });

  it("a press while merely recording (not pending) still emits — pending is its own fact", async () => {
    const w = key({ mode: "video", recording: { since: Date.now() }, pending: false });
    await w.find(".y-shutter__btn").trigger("click");
    expect(w.emitted("record")).toHaveLength(1);
  });
});
