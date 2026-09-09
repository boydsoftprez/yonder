// SPDX-License-Identifier: GPL-3.0-or-later

/** Browser-local camera drafts. Editing never sends a device command.
 * Reports are compared at read time. Only an explicit successful Apply/Keep
 * acknowledges submitted values; edits made afterward remain pending.
 * Dashboard's store survives navigation, and sessionStorage survives re-login
 * or refresh in the same tab. Neither mechanism replays an Apply automatically.
 */

/** A staged value: whatever a control on this console can be set to. */
export type DraftValue = string | number | boolean;

/** One edit the Camera workspace should list: what changed, and what it was changed to. */
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
  /** Retire confirmed submitted values; retain edits made afterward. */
  acknowledge(camera: string, submitted: Record<string, DraftValue>): void;
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
    acknowledge(camera, submitted) {
      const held = cameras.get(camera);
      if (!held) return;
      for (const [path, value] of Object.entries(submitted)) if (held.get(path) === value) held.delete(path);
      if (held.size === 0) cameras.delete(camera);
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


export const CAMERA_DRAFT_STORAGE = 'yonder:camera-drafts:v1';
export function readCameraDrafts(): DraftSnapshot | null {
  try {
    const text = sessionStorage.getItem(CAMERA_DRAFT_STORAGE);
    if (!text || text.length > 256000) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const fields of Object.values(value)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
      if (!Object.values(fields).every(v => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v))) return null;
    }
    return value;
  } catch { return null; }
}
export function saveCameraDrafts(value: DraftSnapshot): void {
  try { sessionStorage.setItem(CAMERA_DRAFT_STORAGE, JSON.stringify(value)); } catch { /* In-memory drafts remain available. */ }
}
