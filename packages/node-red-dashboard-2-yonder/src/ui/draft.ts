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
 * **A value equal to the applied one is not pending.** Setting brightness to
 * what it already is leaves nothing to apply, and an operator who nudges a
 * control back to where it started should see the pending mark disappear
 * rather than be asked to apply a change that changes nothing. `set` takes
 * the camera's currently-applied state alongside the requested value for
 * exactly this comparison — read only, never written — compared by
 * `String()` the same way the blueprint's own `setDraft` does, because a
 * bar's value arrives as a number while a report can carry the same field
 * as a string.
 *
 * **On `set`'s fourth parameter.** The brief's own interface line abbreviates
 * this to `set(camera, path, value)`. A three-argument `set` cannot honour
 * the guarantee above — there is no other channel by which this module
 * could ever learn what is currently applied, and without it "equal to
 * applied" has nothing to compare against. `applied` is that channel: the
 * camera's whole current control state, not just the one field at `path`,
 * so that a test can also prove `set` reads it and never writes it.
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
  /** The camera's whole draft, path to requested value. `{}` if nothing is pending. */
  get(camera: string): Record<string, DraftValue>;
  /**
   * Stage `value` at `path` for `camera`. `applied` is that camera's current
   * (device-reported) control state — read only, to decide whether this
   * edit is a no-op. Equal to applied withdraws any existing draft at
   * `path` rather than recording one. Never posts anywhere; never writes to
   * `applied`.
   */
  set(camera: string, path: string, value: DraftValue, applied: Record<string, DraftValue>): void;
  /** What is pending for `camera`, in the order it was staged. */
  pending(camera: string): PendingEdit[];
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

    set(camera, path, value, applied) {
      if (String(value) === String(applied[path])) {
        cameras.get(camera)?.delete(path);
        return;
      }
      let draft = cameras.get(camera);
      if (!draft) {
        draft = new Map();
        cameras.set(camera, draft);
      }
      draft.set(path, value);
    },

    pending(camera) {
      const draft = cameras.get(camera);
      if (!draft) return [];
      return Array.from(draft, ([path, requested]) => ({ path, requested }));
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
