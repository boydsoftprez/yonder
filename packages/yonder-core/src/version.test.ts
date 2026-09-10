// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { VERSION } from "./index.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("yonder-core", () => {
  it("exports the assembled application's npm-compatible monthly CalVer", () => {
    expect(VERSION).toMatch(/^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/);
    expect(VERSION).toBe(manifest("package.json").version);
    expect(VERSION).toBe(manifest("packages/yonder-core/package.json").version);
  });

  it("ships matching first-party package and lockfile versions", () => {
    const lock = manifest("package-lock.json");
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[""].version).toBe(VERSION);
    for (const name of readdirSync(join(root, "packages"))) {
      const path = `packages/${name}/package.json`;
      if (!existsSync(join(root, path))) continue;
      const pkg = manifest(path);
      expect(pkg.version, path).toBe(VERSION);
      expect(lock.packages[`packages/${name}`].version, path).toBe(VERSION);
      if (pkg.dependencies?.["yonder-core"]) expect(pkg.dependencies["yonder-core"]).toBe(VERSION);
    }
    for (const folder of ["packages/yonder-core", "installer/console"]) {
      expect(manifest(`${folder}/package.json`).version).toBe(VERSION);
      expect(manifest(`${folder}/package-lock.json`).packages[""].version).toBe(VERSION);
    }
  });

  it("rejects an invalid calendar month before changing release metadata", () => {
    const before = readFileSync(join(root, "package.json"), "utf8");
    expect(() => execFileSync(process.execPath, [join(root, "scripts/version.mjs"), "2026.13.0"], { stdio: "pipe" })).toThrow();
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });
});
