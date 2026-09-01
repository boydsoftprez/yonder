// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * node:fs is wrapped, not replaced. These tests are about the *order* of real
 * filesystem calls — fresh temp file, fsync the data, rename, fsync the
 * directory — and no assertion on the resulting bytes can see that order. A
 * write that lands in the page cache and a write that reaches the platter
 * produce identical files right up until the power goes.
 */
const rec = vi.hoisted(() => ({ ops: [] as string[], paths: new Map<number, string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const named = (fd: number): string => rec.paths.get(fd) ?? `fd${fd}`;
  return {
    ...actual,
    default: actual,
    openSync: (path: string, flags: string, mode?: number) => {
      const fd = actual.openSync(path, flags, mode);
      rec.paths.set(fd, String(path));
      rec.ops.push(`open ${String(path)} ${String(flags)}`);
      return fd;
    },
    writeSync: (fd: number, ...rest: unknown[]) => {
      rec.ops.push(`write ${named(fd)}`);
      return (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    },
    fsyncSync: (fd: number) => {
      rec.ops.push(`fsync ${named(fd)}`);
      return actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      rec.ops.push(`rename ${String(from)} -> ${String(to)}`);
      return actual.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      rec.ops.push(`unlink ${String(path)}`);
      return actual.unlinkSync(path);
    },
  };
});

const { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } =
  await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { writeFileDurable } = await import("./durable.js");
const { saveConfig } = await import("../config/save.js");
const { Journal } = await import("../apply/journal.js");
const { SecretStore } = await import("../secrets/store.js");
const { DEFAULT_CONFIG } = await import("../schema/config.js");

let dir: string;

/** Start recording afresh, so set-up writes are not mistaken for the act under test. */
function watch(): string[] {
  rec.ops.length = 0;
  return rec.ops;
}

/** The recorded steps of a durable write to `path`, in the order they happened. */
function expectDurableWrite(ops: string[], path: string): void {
  const tmp = `${path}.tmp`;
  const parent = dir;
  expect(ops).toContain(`open ${tmp} wx`);
  expect(ops).toContain(`fsync ${tmp}`);
  expect(ops).toContain(`rename ${tmp} -> ${path}`);
  expect(ops).toContain(`fsync ${parent}`);
  const wrote = ops.indexOf(`write ${tmp}`);
  const synced = ops.indexOf(`fsync ${tmp}`);
  const renamed = ops.indexOf(`rename ${tmp} -> ${path}`);
  const syncedDir = ops.lastIndexOf(`fsync ${parent}`);
  expect(wrote).toBeGreaterThanOrEqual(0);
  expect(synced).toBeGreaterThan(wrote);
  expect(renamed).toBeGreaterThan(synced);
  expect(syncedDir).toBeGreaterThan(renamed);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-dur-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeFileDurable", () => {
  it("writes through a temp file, forces it to media, renames, then forces the directory", () => {
    const p = join(dir, "thing");
    const ops = watch();
    writeFileDurable(p, "hello", 0o600);
    expectDurableWrite(ops, p);
    expect(readFileSync(p, "utf8")).toBe("hello");
  });

  it("applies the requested mode whatever the umask, and leaves no temp file", () => {
    const p = join(dir, "thing");
    writeFileDurable(p, "hello", 0o600);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it("does not inherit a wider mode from a temp file left by an earlier crash", () => {
    const p = join(dir, "thing");
    writeFileSync(`${p}.tmp`, "stale", { mode: 0o666 });
    writeFileDurable(p, "fresh", 0o600);
    expect(readFileSync(p, "utf8")).toBe("fresh");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("saveConfig", () => {
  it("is durable, not merely atomic", () => {
    const p = join(dir, "config.yaml");
    const ops = watch();
    saveConfig(p, DEFAULT_CONFIG);
    expectDurableWrite(ops, p);
  });
});

describe("Journal", () => {
  it("forces the entry to media before write() returns", () => {
    const p = join(dir, "apply.json");
    const ops = watch();
    new Journal(p).write({ id: "abc", previous: DEFAULT_CONFIG, startedAt: 0 });
    expectDurableWrite(ops, p);
  });

  it("forces the directory after clearing, so a cleared journal cannot come back", () => {
    const p = join(dir, "apply.json");
    const journal = new Journal(p);
    journal.write({ id: "abc", previous: DEFAULT_CONFIG, startedAt: 0 });
    const ops = watch();
    journal.clear();
    const removed = ops.indexOf(`unlink ${p}`);
    const syncedDir = ops.indexOf(`fsync ${dir}`);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(syncedDir).toBeGreaterThan(removed);
  });
});

describe("SecretStore", () => {
  it("forces a generated secret to media before reporting it as created", () => {
    const p = join(dir, "secrets.yaml");
    const ops = watch();
    const created = new SecretStore(p).ensure("ap_psk", "psk");
    expect(created.created).toBe(true);
    expectDurableWrite(ops, p);
  });
});
