// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether the saved configuration has actually moved since the console last
 * drew it (R-UI-20, R-CFG-03).
 *
 * **The defect this exists for.** Every value on the console that comes from
 * `config.yaml` was read once, when the flows were deployed, and never again.
 * An operator changed *where MAVLink is accepted from* — the setting deciding
 * whether anything that can reach the board can command the aircraft
 * (R-MAV-07) — the daemon took the change, and the page went on reading
 * `Accepting from: Loopback only` with `THIS DEVICE` lit. That is K-25 on a
 * control where being wrong is dangerous rather than untidy.
 *
 * **Why the obvious fix is worse than the defect.** The same read seeds ten
 * boxes an operator types into — ground-station addresses, ports, the mobile
 * APN. Re-seeding those on a clock overwrites what somebody is halfway
 * through typing, which is why the read was made a one-shot in the first
 * place. So the *read* repeats and the *re-seed* does not: a poller asks the
 * daemon every couple of seconds, and this is what tells it whether the
 * answer is news. A form is disturbed exactly when the setting under it
 * genuinely changed, which is the one moment R-UI-17 wants it disturbed.
 *
 * **Why not watch the apply state instead.** `GET /status` reports when an
 * apply reached a terminal state, and waiting for that was the tempting
 * shape. It is wrong for this page: R-CFG-12 names `mavlink.ingest` as
 * deliberately *not* exempt from the confirmation window, so opening ingest
 * pends — and the new configuration is in force for the whole window, up to
 * five minutes (R-CFG-10). A console that waited for the terminal state would
 * hold `Loopback only` on screen for five minutes while the board was in fact
 * accepting MAVLink from the network. Watching the document says the truth as
 * soon as it is true, and it also catches a change nobody's apply made — a
 * rollback the device performed by itself, or a daemon restarted onto a
 * different file.
 *
 * Pure, and no timer: this holds one string and answers one question about
 * it. Whatever does the polling owns its own clock and can be stopped.
 */

/**
 * A JSON value with its object keys in a fixed order.
 *
 * The daemon serialises the same document the same way every time, so plain
 * `JSON.stringify` would very nearly do. *Very nearly* is the problem: a key
 * order that changed for any reason — a loader that starts filling in a
 * defaulted field, a schema key reordered — would read as a changed document
 * on every single poll, and re-seed every form on the console every two
 * seconds. That is the failure this whole module exists to prevent, arriving
 * by the back door. Sorting costs nothing and closes it.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) ordered[key] = canonical(source[key]);
  return ordered;
}

/**
 * One document, as a string two reads can be compared by.
 *
 * **Never logged, never put in a node status and never sent to a page.** The
 * configuration carries `SecretRef`s and, whatever they are, a fingerprint of
 * a document is not a summary of it — it is the document. It exists to be
 * compared with the previous one and for nothing else.
 *
 * `undefined` has no JSON form, so it gets its own token rather than being
 * allowed to collapse into the `undefined` that `JSON.stringify` returns
 * for it, which is not a string at all and would compare equal to nothing.
 */
export function configFingerprint(value: unknown): string {
  // `absent` cannot collide with a real answer: JSON serialises every value
  // to something beginning with `{`, `[`, `"`, a digit, `-`, `t`, `f` or `n`.
  return value === undefined ? "absent" : JSON.stringify(canonical(value));
}

/**
 * The one fact a re-seeding poller has to remember.
 *
 * Starts having seen nothing, so the **first** successful read is a change:
 * that read is what seeds the console when it opens (R-UI-17), and a watch
 * that stayed quiet until the second poll would leave every box empty until
 * something happened to move.
 *
 * A failed read is not offered here at all. Nothing calls `changed()` for
 * one, because a daemon that did not answer has not told us the configuration
 * changed — and blanking a form on a lost socket looks exactly like a device
 * that has forgotten its own settings.
 */
export class ConfigWatch {
  private seen: string | undefined;

  /**
   * Whether this document differs from the last one accepted, adopting it
   * either way.
   *
   * Adopting on the same call is deliberate: a caller that had to remember to
   * confirm afterwards is a caller that can forget, and forgetting means
   * re-seeding every form on every poll for ever.
   */
  changed(value: unknown): boolean {
    const print = configFingerprint(value);
    const news = print !== this.seen;
    this.seen = print;
    return news;
  }

  /** Whether anything has been read yet. For a node's own status line. */
  get started(): boolean {
    return this.seen !== undefined;
  }
}
