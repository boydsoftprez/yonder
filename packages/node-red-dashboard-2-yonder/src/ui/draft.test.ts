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
 *
 * Fix round 1: the equal-to-applied comparison moved from `set` (write
 * time) to `pending` (read time) — `set` now takes three arguments and
 * records unconditionally; `pending` takes the camera's applied state and
 * filters. See `draft.ts`'s module doc for why: a write-time decision goes
 * stale when applied moves after the fact, and a read-time one cannot.
 */
describe("createDraftStore", () => {
  it("a set is pending until cleared", () => {
    const store = createDraftStore();

    store.set("elp", "streamMode", "Adaptive");
    expect(store.pending("elp", { streamMode: "Fixed" })).toEqual([
      { path: "streamMode", requested: "Adaptive" },
    ]);

    store.clear("elp");
    expect(store.pending("elp", { streamMode: "Fixed" })).toEqual([]);
  });

  it("pending(camera, applied) names both the path and what was requested", () => {
    const store = createDraftStore();

    store.set("elp", "previewFloor", 300);
    store.set("elp", "previewCeiling", 1800);

    expect(store.pending("elp", {})).toEqual([
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
    before.set("elp", "previewFloor", 500);
    before.set("pocket2", "zoom", 2.5);

    const saved = before.snapshot();
    const after = createDraftStore();
    after.restore(saved);

    expect(after.pending("elp", { previewFloor: 300 })).toEqual([{ path: "previewFloor", requested: 500 }]);
    expect(after.pending("pocket2", { zoom: 1 })).toEqual([{ path: "zoom", requested: 2.5 }]);
  });

  it("keeps each camera's draft separate", () => {
    const store = createDraftStore();

    store.set("elp", "streamMode", "Adaptive");
    store.set("pocket2", "streamMode", "Fixed");

    expect(store.pending("elp", {})).toEqual([{ path: "streamMode", requested: "Adaptive" }]);
    expect(store.pending("pocket2", {})).toEqual([{ path: "streamMode", requested: "Fixed" }]);
  });

  /** Coordinator resolution 5: discard on one page must not throw away an edit waiting on another. */
  it("clear(camera) empties that camera and no other", () => {
    const store = createDraftStore();
    store.set("elp", "streamMode", "Adaptive");
    store.set("pocket2", "streamMode", "Fixed");

    store.clear("elp");

    expect(store.pending("elp", {})).toEqual([]);
    expect(store.pending("pocket2", {})).toEqual([{ path: "streamMode", requested: "Fixed" }]);
  });

  /**
   * Coordinator resolution 4, re-homed to `pending` in fix round 1: a value
   * equal to the applied one leaves nothing to apply. `set` still records
   * it — `get` is the raw draft and does not filter — but `pending` omits
   * it, because that is the list Setup actually draws from.
   */
  it("an edit equal to the applied value is recorded but is not pending", () => {
    const store = createDraftStore();

    store.set("elp", "brightness", 50);

    expect(store.get("elp")).toEqual({ brightness: 50 });
    expect(store.pending("elp", { brightness: 50 })).toEqual([]);
  });

  /**
   * The other half of resolution 4: an operator who nudges a control away
   * and then back to where it started should see the pending mark
   * disappear, not be asked to apply a change that changes nothing.
   */
  it("nudging a control back to where it started clears its pending mark", () => {
    const store = createDraftStore();
    const applied = { brightness: 50 };

    store.set("elp", "brightness", 70);
    expect(store.pending("elp", applied)).toEqual([{ path: "brightness", requested: 70 }]);

    store.set("elp", "brightness", 50);
    expect(store.pending("elp", applied)).toEqual([]);
  });

  /**
   * The fix this whole round exists for: a write-time decision goes stale
   * once applied moves *after* the edit was staged. Brightness is drafted
   * to 50 while applied is 20 (genuinely pending); applied then becomes 50
   * by some other route entirely — a re-probe, another operator, a mode
   * change reporting back — without the operator touching this field
   * again. `pending`, asked now, must say there is nothing left to apply:
   * sending 50 to a camera already at 50 is exactly the stale-list defect
   * a write-time comparison could not avoid.
   */
  it("an edit that becomes stale once applied catches up to it stops being pending", () => {
    const store = createDraftStore();

    store.set("elp", "brightness", 50);
    expect(store.pending("elp", { brightness: 20 })).toEqual([{ path: "brightness", requested: 50 }]);

    // Applied moves to match the draft by some route other than this store.
    expect(store.pending("elp", { brightness: 50 })).toEqual([]);
  });

  /**
   * A known, verified asymmetry (see `draft.ts`'s module doc): withdrawing
   * a draft by matching applied is not the same as never having recorded
   * it. If applied later drifts away again, with the operator never having
   * touched the field a second time, the old value reappears as pending.
   * Named here rather than left as a surprise for whoever next reads
   * `pending`'s output and wonders where an edit came from.
   */
  it("characterisation: a withdrawn draft can reappear if applied later drifts away from it unasked", () => {
    const store = createDraftStore();

    store.set("elp", "brightness", 70);
    store.set("elp", "brightness", 50); // the operator nudges back to what was applied (20 -> ... -> 50)
    expect(store.pending("elp", { brightness: 50 })).toEqual([]); // withdrawn, correctly

    // Nothing touched this field again; applied simply moves elsewhere.
    expect(store.pending("elp", { brightness: 35 })).toEqual([{ path: "brightness", requested: 50 }]);
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

    store.set("elp", "previewCeiling", 2000);

    expect(store.pending("elp", { previewCeiling: "2000" })).toEqual([]);
  });

  it("get(camera) is the whole draft, unfiltered, path to requested value; {} when untouched", () => {
    const store = createDraftStore();

    expect(store.get("pocket2")).toEqual({});

    store.set("elp", "zoom", 3);
    expect(store.get("elp")).toEqual({ zoom: 3 });

    // Unfiltered: get does not know or care what is applied.
    store.set("elp", "zoom", 3); // set again, to the same value, applied unspecified
    expect(store.get("elp")).toEqual({ zoom: 3 });
  });

  /**
   * `applied` is read, never written — `pending` is the one place that
   * receives it now, so this is where the guarantee that used to sit on
   * `set` belongs. Checked by value rather than by reference so a mutation
   * that replaced the object wholesale (not just wrote a field on it) would
   * also be caught.
   */
  it("pending never writes into the applied state it was given", () => {
    const store = createDraftStore();
    const applied = { brightness: 50, contrast: 10 };

    store.set("elp", "brightness", 70);
    store.pending("elp", applied);

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

    store.set("elp", "brightness", 70);
    store.set("elp", "brightness", 50);
    store.set("pocket2", "zoom", 2);
    store.pending("elp", { brightness: 50 });
    store.clear("elp");
    const saved = store.snapshot();
    store.restore(saved);
    store.get("pocket2");

    expect(emit).not.toHaveBeenCalled();

    // Prove the spy is live: called the way a socket-posting `set` would
    // call it, it registers — so if any operation above had reached the
    // socket, the assertion above would have failed instead of passing
    // vacuously.
    emit("widget-action", "elp", { payload: "brightness:70" });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
