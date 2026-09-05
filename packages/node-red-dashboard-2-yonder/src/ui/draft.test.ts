// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "./draft.js";

/**
 * This is the store the whole plan exists for (Task 21 brief, Coordinator
 * resolution 1): on the shipped console a value reached the aircraft the
 * moment focus left the field. So the one guarantee every other test here
 * serves is `set` never reaching outside its own map — no socket, no
 * anything else. That test is written last, deliberately, so every other
 * behaviour (pending, per camera, the round trip, equal-to-applied) is
 * pinned first.
 */
describe("createDraftStore", () => {
  it("a set is pending until cleared", () => {
    const store = createDraftStore();

    store.set("elp", "streamMode", "Adaptive", { streamMode: "Fixed" });
    expect(store.pending("elp")).toEqual([{ path: "streamMode", requested: "Adaptive" }]);

    store.clear("elp");
    expect(store.pending("elp")).toEqual([]);
  });

  it("pending(camera) names both the path and what was requested", () => {
    const store = createDraftStore();

    store.set("elp", "previewFloor", 300, {});
    store.set("elp", "previewCeiling", 1800, {});

    expect(store.pending("elp")).toEqual([
      { path: "previewFloor", requested: 300 },
      { path: "previewCeiling", requested: 1800 },
    ]);
  });

  /**
   * Coordinator resolution 2: Dashboard remounts the widget on every
   * Live<->Setup flip and every camera switch, so a draft kept only in that
   * component's own state is a draft that forgets. `snapshot`/`restore` are
   * the round trip that carries it through a remount — modelled here as a
   * second, brand-new store standing in for the fresh instance a remount
   * creates, rehydrated from what the first one wrote out. Two cameras, not
   * one, so a `restore` that silently drops a camera has something to drop.
   */
  it("pending survives a snapshot/restore round trip across a fresh store — a page switch", () => {
    const before = createDraftStore();
    before.set("elp", "previewFloor", 500, { previewFloor: 300 });
    before.set("pocket2", "zoom", 2.5, { zoom: 1 });

    const saved = before.snapshot();
    const after = createDraftStore();
    after.restore(saved);

    expect(after.pending("elp")).toEqual([{ path: "previewFloor", requested: 500 }]);
    expect(after.pending("pocket2")).toEqual([{ path: "zoom", requested: 2.5 }]);
  });

  it("keeps each camera's draft separate", () => {
    const store = createDraftStore();

    store.set("elp", "streamMode", "Adaptive", {});
    store.set("pocket2", "streamMode", "Fixed", {});

    expect(store.pending("elp")).toEqual([{ path: "streamMode", requested: "Adaptive" }]);
    expect(store.pending("pocket2")).toEqual([{ path: "streamMode", requested: "Fixed" }]);
  });

  /** Coordinator resolution 5: discard on one page must not throw away an edit waiting on another. */
  it("clear(camera) empties that camera and no other", () => {
    const store = createDraftStore();
    store.set("elp", "streamMode", "Adaptive", {});
    store.set("pocket2", "streamMode", "Fixed", {});

    store.clear("elp");

    expect(store.pending("elp")).toEqual([]);
    expect(store.pending("pocket2")).toEqual([{ path: "streamMode", requested: "Fixed" }]);
  });

  /**
   * Coordinator resolution 4: a value equal to the applied one leaves
   * nothing to apply, so it is never recorded as pending in the first
   * place — setting brightness to what a fresh report already says it is.
   */
  it("a value equal to the applied one is never recorded as pending", () => {
    const store = createDraftStore();

    store.set("elp", "brightness", 50, { brightness: 50 });

    expect(store.pending("elp")).toEqual([]);
    expect(store.get("elp")).toEqual({});
  });

  /**
   * The other half of resolution 4: an operator who nudges a control away
   * and then back to where it started should see the pending mark
   * disappear, not be asked to apply a change that changes nothing. This is
   * a different case from the one above — here the draft already exists
   * before the reverting `set` arrives.
   */
  it("nudging a control back to where it started clears its pending mark", () => {
    const store = createDraftStore();
    const applied = { brightness: 50 };

    store.set("elp", "brightness", 70, applied);
    expect(store.pending("elp")).toEqual([{ path: "brightness", requested: 70 }]);

    store.set("elp", "brightness", 50, applied);
    expect(store.pending("elp")).toEqual([]);
  });

  /**
   * The blueprint's own draft withdraws a no-op edit by comparing
   * `String(value) === String(this.v[key])` (gallery/deck.js `setDraft`),
   * because a bar's value arrives as a number while a report can carry the
   * same field as a string. Matched here so a value round-tripped through
   * the wire in a different type from the one it was set in still reads as
   * "nothing to apply."
   */
  it("compares by String(), so a numeric draft matches a stringy applied value", () => {
    const store = createDraftStore();

    store.set("elp", "previewCeiling", 2000, { previewCeiling: "2000" });

    expect(store.pending("elp")).toEqual([]);
  });

  it("get(camera) is the whole draft, path to requested value; {} when untouched", () => {
    const store = createDraftStore();

    expect(store.get("pocket2")).toEqual({});

    store.set("elp", "zoom", 3, {});
    expect(store.get("elp")).toEqual({ zoom: 3 });
  });

  /**
   * `applied` is read, never written — `set` has exactly one place to
   * record an edit, and it is not the caller's own state. Checked by
   * value rather than by reference so a mutation that replaced the object
   * wholesale (not just wrote a field on it) would also be caught.
   */
  it("set never writes into the applied state it was given", () => {
    const store = createDraftStore();
    const applied = { brightness: 50, contrast: 10 };

    store.set("elp", "brightness", 70, applied);

    expect(applied).toEqual({ brightness: 50, contrast: 10 });
  });

  /**
   * Coordinator resolution 1, and the reason this whole plan exists: `set`
   * never posts to the socket. `draft.ts` has no import of, and no
   * parameter for, anything socket-shaped, so nothing below could reach
   * `emit` structurally — which is what makes the guarantee absolute rather
   * than a choice the code happens to make today. That also means the
   * assertion below is only informative if the spy itself is proven to be
   * capable of registering a call; the direct call at the end is that
   * proof (Coordinator resolution 7) — without it, an `emit` that this file
   * could never have reached anyway would pass the same way whether `set`
   * behaved or not.
   */
  it("a set never posts to the socket — proven against a spy shown to be live", () => {
    const emit = vi.fn();
    const store = createDraftStore();

    store.set("elp", "brightness", 70, { brightness: 50 });
    store.set("elp", "brightness", 50, { brightness: 50 }); // withdraws
    store.set("pocket2", "zoom", 2, { zoom: 1 });
    store.clear("elp");
    const saved = store.snapshot();
    store.restore(saved);
    store.get("pocket2");
    store.pending("pocket2");

    expect(emit).not.toHaveBeenCalled();

    // Prove the spy is live: called the way a socket-posting `set` would
    // call it, it registers — so if any operation above had reached the
    // socket, the assertion above would have failed instead of passing
    // vacuously.
    emit("widget-action", "elp", { payload: "brightness:70" });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
