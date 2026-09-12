// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeStorageMode } from "./storage-mode.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(pi = false) {
  const root = mkdtempSync(join(tmpdir(), "storage-mode-")); roots.push(root);
  const marker = join(root, "layout");
  const modePath = join(root, "mode");
  const mountInfoPath = join(root, "mountinfo");
  writeFileSync(marker, `TARGET=${pi ? "rpi" : "radxa-zero3w"}\n`, { mode: 0o644 });
  const input = { markers: [marker], modePath, mountInfoPath, ownerUid: process.getuid!() };
  function set(mode: string, rootMode: string, bootMode = rootMode) {
    writeFileSync(modePath, mode, { mode: 0o644 });
    writeFileSync(mountInfoPath, `1 0 179:2 / / ${rootMode},relatime - ext4 /dev/mmcblk0p2 ${rootMode}\n`
      + (pi ? `2 1 179:1 / /boot/firmware ${bootMode},relatime - vfat /dev/mmcblk0p1 ${bootMode}\n` : ""));
  }
  return { input, set, marker, root };
}
describe("managed boot mode observation", () => {
  it("checks protected and writable system mounts instead of assuming a protected boot", () => {
    const f = fixture();
    f.set("maintenance\n", "rw"); expect(observeStorageMode(f.input)).toBe("maintenance");
    f.set("protected\n", "ro"); expect(observeStorageMode(f.input)).toBe("protected");
    f.set("protected\n", "rw"); expect(() => observeStorageMode(f.input)).toThrow("could not be verified");
    f.set("maintenance\n", "ro"); expect(() => observeStorageMode(f.input)).toThrow();
  });
  it("requires Pi FAT and root to agree with the boot record", () => {
    const f = fixture(true);
    f.set("maintenance\n", "rw", "ro"); expect(() => observeStorageMode(f.input)).toThrow();
    f.set("protected\n", "ro", "rw"); expect(() => observeStorageMode(f.input)).toThrow();
    f.set("maintenance\n", "rw"); expect(observeStorageMode(f.input)).toBe("maintenance");
  });
  it("rejects absent, malformed, oversized, writable and symlink boot records", () => {
    const f = fixture(); expect(() => observeStorageMode(f.input)).toThrow();
    for (const value of ["protected", "protected\nextra", "x".repeat(100)]) {
      f.set(value, "ro"); expect(() => observeStorageMode(f.input)).toThrow();
    }
    f.set("protected\n", "ro"); chmodSync(f.input.modePath, 0o666);
    expect(() => observeStorageMode(f.input)).toThrow();
    rmSync(f.input.modePath); symlinkSync(f.marker, f.input.modePath);
    expect(() => observeStorageMode(f.input)).toThrow();
  });
  it("does not require an initramfs record on a conventional install", () => {
    const f = fixture(); rmSync(f.marker);
    expect(observeStorageMode(f.input)).toBe("protected");
  });
});
