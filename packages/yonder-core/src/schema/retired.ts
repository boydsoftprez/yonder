// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Keys Yonder used to understand and no longer does.
 *
 * `ConfigSchema` is `.strict()` and has to stay that way. A misspelled key —
 * `ssdi` for `ssid` — that is quietly ignored leaves an operator believing
 * they configured something they did not, and on this device the thing they
 * think they configured is often how they reach it. Strictness is the only
 * thing that catches that, so removing it is not on the table.
 *
 * Strictness on its own, though, rejects the whole document over a key that
 * *used to be real*. A Raspberry Pi upgraded past the build that removed
 * `network.ap.dhcp` still carried that key in `/etc/yonder/config.yaml`, so
 * every read of the file failed: the network was never rendered, the fallback
 * watchdog could not read the configuration either and ran on defaults, and
 * the board was reachable only because it happened to have an Ethernet cable
 * in it. On an aircraft that is a card reader and a bench (R-CFG-09).
 *
 * The two cases are told apart by **knowledge, not by shape**. There is no
 * property of the text `dhcp` that distinguishes it from `ssdi`; the
 * difference is that this project once shipped one of them and never shipped
 * the other. A key we deliberately removed is a key we can name. A typo is
 * not. So the removed ones are named here, exactly, one line each, and *only*
 * these are dropped. Anything else the schema has never heard of still fails
 * validation with the same message it produced before.
 *
 * That makes retiring a key a deliberate act with a paper trail: take it out
 * of the schema, add one line here saying what became of it. Forgetting the
 * line is not silent — it strands every device already carrying that key,
 * which is what happened once and is what R-CFG-09 now forbids.
 *
 * Two things this list deliberately does not do:
 *
 *   - **It does not rename.** Every entry here is a removal. A rename is two
 *     operations that must both be right — drop the old key *and* carry its
 *     value to a new key whose shape may differ — and getting the second one
 *     wrong writes an operator's old value into a setting that means
 *     something else. That is a silent misconfiguration on something that
 *     flies, which is worse than the loud failure it replaced. Nothing has
 *     been renamed yet, so no machinery for it exists yet; when something is,
 *     the honest interim is to retire the old name here (loudly dropped) and
 *     let the operator set the new one. `RetiredKey` is a record rather than
 *     a bare string so that adding a `renamedTo` later is an additive change
 *     to this one file.
 *   - **It does not rewrite the file.** Loading a configuration is a read.
 *     The key stays on disk, ignored and logged, until the next save writes
 *     the validated document back without it.
 */

/** One key this project used to accept, and the reason it no longer does. */
export interface RetiredKey {
  /**
   * The full dotted path the key occupied, e.g. `network.ap.dhcp`.
   *
   * A path, never a bare name: `dhcp` on its own would also match
   * `network.ethernet.dhcp`, which is a live setting. Retirement is exact, or
   * it silently discards configuration that still works.
   */
  path: string;
  /** What became of it, in one clause. Printed with the key, so an operator reads it once and knows. */
  note: string;
}

/**
 * Every key retired so far, oldest first.
 *
 * Entries are never removed from this list. A device flashed years ago is
 * still a device that has to boot.
 */
export const RETIRED_KEYS: readonly RetiredKey[] = [
  {
    path: "network.ap.dhcp",
    note:
      "the access point's DHCP range is not configurable; NetworkManager derives it from "
      + "network.ap.address, so this key decided nothing (K-15)",
  },
];

/** A plain mapping — not an array, not null. Retired paths address the object tree only. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove one dotted path, returning a new document rather than editing the
 * one it was handed.
 *
 * The caller's object is never mutated: `loadConfig` is a read, and
 * `ApplyEngine.apply` is handed a body it does not own. Only the spine down
 * to the removed key is copied — everything else is shared with the original,
 * so this costs a handful of objects rather than a deep clone of the whole
 * configuration.
 */
function dropPath(node: unknown, segments: string[]): { node: unknown; dropped: boolean } {
  const [head, ...rest] = segments;
  if (head === undefined || !isMapping(node)) return { node, dropped: false };
  // Own properties only: `"toString" in node` is true of every object, and a
  // retired path must not match something the prototype provides.
  if (!Object.prototype.hasOwnProperty.call(node, head)) return { node, dropped: false };

  if (rest.length === 0) {
    const copy = { ...node };
    delete copy[head];
    return { node: copy, dropped: true };
  }

  const inner = dropPath(node[head], rest);
  if (!inner.dropped) return { node, dropped: false };
  return { node: { ...node, [head]: inner.node }, dropped: true };
}

/**
 * Strip every retired key from a document about to be validated.
 *
 * Returns what was dropped so the caller can say so out loud. Dropping a key
 * without a log line is data loss, which is its own failure — see
 * `retirementNotice`.
 */
export function withoutRetiredKeys(doc: unknown): { doc: unknown; dropped: RetiredKey[] } {
  let current = doc;
  const dropped: RetiredKey[] = [];
  for (const retired of RETIRED_KEYS) {
    const result = dropPath(current, retired.path.split("."));
    if (result.dropped) {
      current = result.node;
      dropped.push(retired);
    }
  }
  return { doc: current, dropped };
}

/**
 * The half of the log line that is the same wherever a key is dropped. The
 * caller adds the half that depends on where the document came from — a file
 * that is left as it is, or a body that was just posted.
 *
 * `source` names the document: a path, or a phrase describing the request.
 */
export function retirementNotice(source: string, dropped: RetiredKey): string {
  return `${source}: '${dropped.path}' is no longer used by Yonder and has been ignored: ${dropped.note}`;
}
