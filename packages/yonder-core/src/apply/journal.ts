// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, existsSync } from "node:fs";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import type { Config } from "../schema/config.js";

export interface JournalEntry {
  id: string;
  previous: Config;
  startedAt: number;
}

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

  read(): JournalEntry | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as JournalEntry;
    } catch {
      return null;
    }
  }

  clear(): void {
    unlinkDurable(this.path);
  }
}
