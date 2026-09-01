// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
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
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, this.path);
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
    try { unlinkSync(this.path); } catch { /* already gone */ }
  }
}
