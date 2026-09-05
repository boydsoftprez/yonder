// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shared draft (spec §7 "Editing on Live and Setup") — a browser-session
 * store of edits an operator has made but not yet applied, one per camera.
 *
 * **This is why the console does not apply on blur, and that defect is the
 * reason this whole plan exists.** On the shipped console a number typed
 * into a field reached the aircraft the moment focus left it: no
 * confirmation, no way back — an operator glancing away mid-edit sent a
 * half-typed value to a camera in flight. This store is where an edit waits
 * instead: an operator changes something on Live, sees it marked pending,
 * and applies it deliberately on Setup. So `set` never reaches outside its
 * own map — no import of a socket, no parameter that could carry one in, by
 * construction rather than by choice (R-CFG-03, R-UI-05).
 *
 * **Per camera, and it survives a page switch.** Dashboard remounts the
 * widget on every Live<->Setup flip and every camera switch — the
 * blueprint's own `DRAFTS` (`docs/console/design/instrument-library/gallery/
 * deck.js`) is module-scoped for exactly that reason, so a component
 * remount never resets it. This store cannot borrow that trick — it is
 * created fresh per Dashboard client-store entry rather than once at module
 * load — so `snapshot`/`restore` are the round trip that stands in for it:
 * the deck reads `yonder.draft` (Dashboard's client store) into a fresh
 * `createDraftStore()` on mount via `restore`, and keeps `yonder.draft`
 * caught up with `snapshot()` as edits happen.
 *
 * **A value equal to the applied one is not pending — checked at read time,
 * not write time.** `set` records whatever the operator asked for,
 * unconditionally; `pending` is what decides whether that is still worth
 * showing, by comparing the recorded value against the camera's
 * currently-applied state every time it is asked. `get` does not filter —
 * it is the raw draft, exactly what has been recorded — so `get` and
 * `pending` can legitimately disagree about one path: `get` says a value is
 * recorded there, `pending` says there is nothing to apply, because the two
 * now happen to match.
 *
 * **Why the comparison lives in `pending` and not in `set` (revised from
 * this file's first version).** A write-time comparison goes stale: draft
 * brightness at 50 while applied is 20 (pending, correctly); then applied
 * becomes 50 by some other route — a re-probe, another operator, a mode
 * change reporting back — and a store that decided at write time would
 * still list the edit as pending, offering to send 50 to a camera already
 * at 50. Comparing at read time answers with what is true *now*, every time
 * `pending` is asked, however applied got there. `set` therefore takes only
 * three arguments, exactly as the plan declares it, and `pending` takes the
 * camera's currently-applied state — supplied by the caller, which is
 * rendering from the report at exactly the moment it asks what is pending,
 * and so already has it — read only, never written.
 *
 * A known asymmetry this leaves open, worth its own line rather than
 * silence: a draft that is *withdrawn* by matching applied at the moment it
 * is asked about is not the same as a draft that was never recorded — the
 * value is still sitting in the map, and if applied later drifts away from
 * it *without the operator touching that field again*, `pending` will
 * report it once more. Fixing that would need the store to distinguish "the
 * operator asked for this" from "this happened to coincide with applied,"
 * which is more than a comparison at either write or read time can tell on
 * its own.
 */

/** A staged value: whatever a control on this console can be set to. */
export type DraftValue = string | number | boolean;

/** One edit Setup should list: what changed, and what it was changed to. */
export interface PendingEdit {
  path: string;
  requested: DraftValue;
}

/** What `snapshot()` returns and `restore()` accepts — plain data, one record per camera. */
export type DraftSnapshot = Record<string, Record<string, DraftValue>>;

export interface DraftStore {
  /** The camera's whole draft, unfiltered, path to requested value. `{}` if nothing is recorded. */
  get(camera: string): Record<string, DraftValue>;
  /** Stage `value` at `path` for `camera`, unconditionally. Never posts anywhere. */
  set(camera: string, path: string, value: DraftValue): void;
  /**
   * What is pending for `camera`: every recorded edit whose value differs
   * from `applied` at the same path, in the order it was staged. `applied`
   * is that camera's current (device-reported) control state — read only,
   * never written. An edit equal to `applied` is recorded (`get` still
   * shows it) but is not pending, so it is omitted here.
   */
  pending(camera: string, applied: Record<string, DraftValue>): PendingEdit[];
  /** Discard every pending edit for `camera`. Every other camera is untouched. */
  clear(camera: string): void;
  /** The whole store, as plain data — for Dashboard's client store to hold across a remount. */
  snapshot(): DraftSnapshot;
  /** Replace the whole store's state with a previous `snapshot()`. */
  restore(snapshot: DraftSnapshot): void;
}

/** A fresh, empty draft store. Holds nothing until `set` is called. */
export function createDraftStore(): DraftStore {
  const cameras = new Map<string, Map<string, DraftValue>>();

  return {
    get(camera) {
      const draft = cameras.get(camera);
      return draft ? Object.fromEntries(draft) : {};
    },

    set(camera, path, value) {
      let draft = cameras.get(camera);
      if (!draft) {
        draft = new Map();
        cameras.set(camera, draft);
      }
      draft.set(path, value);
    },

    pending(camera, applied) {
      const draft = cameras.get(camera);
      if (!draft) return [];
      return Array.from(draft)
        .filter(([path, requested]) => String(requested) !== String(applied[path]))
        .map(([path, requested]) => ({ path, requested }));
    },

    clear(camera) {
      cameras.delete(camera);
    },

    snapshot() {
      const out: DraftSnapshot = {};
      for (const [camera, draft] of cameras) out[camera] = Object.fromEntries(draft);
      return out;
    },

    restore(snapshot) {
      cameras.clear();
      for (const [camera, entries] of Object.entries(snapshot)) {
        cameras.set(camera, new Map(Object.entries(entries)));
      }
    },
  };
}
