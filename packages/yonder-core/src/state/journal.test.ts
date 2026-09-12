// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { StateJournal } from "./journal.js";
import type { DurableState } from "./types.js";

let temporary: string;
let root: string;
const state: DurableState = {
  config: DEFAULT_CONFIG,
  secrets: { ap_psk: "private-passphrase" },
  linuxOwner: null,
  zeroTier: null,
};

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "yonder-journal-"));
  root = join(temporary, "transactions");
});
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

describe("private generation journal", () => {
  it("creates root-owned private directories and files", () => {
    const journal = new StateJournal(root);
    const { generation } = journal.ensureInitialized(state);
    for (const directory of [root, join(root, "generations"), join(root, "generations", generation)]) {
      const info = statSync(directory);
      expect(info.mode & 0o777).toBe(0o700);
      expect(info.uid).toBe(process.geteuid?.() ?? info.uid);
    }
    for (const file of ["ownership.json", "active.json", "receipts.json"])
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
    for (const file of ["state.json", "manifest.json"])
      expect(statSync(join(root, "generations", generation, file)).mode & 0o777).toBe(0o600);
  });

  it("rejects checksum corruption without returning state contents", () => {
    const journal = new StateJournal(root);
    const { generation } = journal.ensureInitialized(state);
    const path = join(root, "generations", generation, "state.json");
    writeFileSync(path, `${readFileSync(path, "utf8")} `, { mode: 0o600 });
    expect(() => journal.readGeneration(generation)).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
  });

  it("rejects a symlink or widened mode in an owned generation", () => {
    const journal = new StateJournal(root);
    const { generation } = journal.ensureInitialized(state);
    const path = join(root, "generations", generation, "state.json");
    chmodSync(path, 0o644);
    expect(() => journal.readGeneration(generation)).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
    chmodSync(path, 0o600);
    unlinkSync(path);
    symlinkSync(join(root, "active.json"), path);
    expect(() => journal.readGeneration(generation)).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
  });

  it("keeps only the newest 64 response-loss receipts", () => {
    const journal = new StateJournal(root);
    const { generation } = journal.ensureInitialized(state);
    const ids: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const id = randomUUID();
      ids.push(id);
      journal.writeReceipt({
        id,
        kind: "restore",
        outcome: "committed",
        generation,
        previousGeneration: generation,
        completedAt: index,
      });
    }
    expect(journal.readReceipt(ids[0] as string)).toBeNull();
    expect(journal.readReceipt(ids[6] as string)).not.toBeNull();
    expect(JSON.parse(readFileSync(join(root, "receipts.json"), "utf8")).receipts).toHaveLength(64);
  });

  it("bounds the boot-consumed operation record and requires an integer timestamp", () => {
    const journal = new StateJournal(root);
    const { generation } = journal.ensureInitialized(state);
    const operation = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      kind: "maintenance" as const,
      phase: "awaiting-maintenance-reboot" as const,
      previousGeneration: generation,
      maintenance: { schemaVersion: 1 as const, mode: "writable-next-boot" as const },
      startedAt: 1789160000000,
    };
    journal.writeOperation(operation);
    expect(journal.readOperation()).toEqual(operation);
    writeFileSync(join(root, "operation.json"), "x".repeat(513), { mode: 0o600 });
    expect(() => journal.readOperation()).toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
    expect(() => journal.writeOperation({ ...operation, startedAt: 1.5 }))
      .toThrowError(expect.objectContaining({ code: "STATE_UNAVAILABLE" }));
  });
});
