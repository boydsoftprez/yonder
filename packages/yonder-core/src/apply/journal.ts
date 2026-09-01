// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import { ConfigSchema, type Config } from "../schema/config.js";
import { warn } from "../log.js";

export interface JournalEntry {
  id: string;
  previous: Config;
  startedAt: number;
  /**
   * True when `previous` is the shipped default substituted for a
   * config.yaml that could not be loaded when this apply started, rather
   * than the operator's actual previous configuration (K-14, see
   * ApplyEngine.apply). Defaults to false so a journal written by a daemon
   * build that predates this field still reads as the ordinary case.
   */
  previousIsDefault: boolean;
}

/**
 * The on-disk shape is validated on the way back in, not merely cast. The
 * entry is the rollback target: handing an unvalidated `previous` to
 * saveConfig would write whatever the file happened to contain over a working
 * configuration, and a `previous` that is missing altogether would throw out
 * of recover() on every start.
 */
const JournalEntrySchema = z.object({
  id: z.string().min(1),
  previous: ConfigSchema,
  startedAt: z.number().finite(),
  previousIsDefault: z.boolean().default(false),
});

/**
 * A durable note that an apply is in flight. If the daemon dies between
 * writing this and confirmation, recover() finds it on next start and
 * reverts — which is the whole reason the engine lives outside the console.
 */
export class Journal {
  constructor(private readonly path: string) {}

  write(entry: JournalEntry): void {
    // Durability matters more here than anywhere else in the daemon: this is
    // the record that says "put the old configuration back". If it is still in
    // the page cache when the battery goes, the machine comes up holding an
    // unconfirmed change with nothing left to undo it.
    writeFileDurable(this.path, JSON.stringify(entry), 0o600);
  }

  /** The entry, or null if there is none or it cannot be trusted. */
  read(): JournalEntry | null {
    if (!existsSync(this.path)) return null;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      warn(`cannot read the apply journal ${this.path}: ${(e as Error).message}`);
      return null;
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return this.discard("it is not valid JSON");
    }

    const parsed = JournalEntrySchema.safeParse(doc);
    if (!parsed.success) {
      return this.discard("it does not hold a valid configuration to roll back to");
    }
    return parsed.data;
  }

  clear(): void {
    unlinkDurable(this.path);
  }

  /**
   * An unusable journal is treated as no journal: nothing can be rolled back
   * to, so the alternative to dropping it is a daemon that refuses to start.
   * It is removed rather than left to fail identically on every boot, and said
   * loudly because it means a change may have gone unreverted.
   */
  private discard(why: string): null {
    warn(`discarding the apply journal ${this.path}: ${why}. An unconfirmed change may still be in effect.`);
    try {
      this.clear();
    } catch (e) {
      warn(`could not remove ${this.path}: ${(e as Error).message}`);
    }
    return null;
  }
}
