// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { renderDefaultConfig, seedConfigIfAbsent } from "./defaults.js";
import { loadConfig } from "./load.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";
import { formatIssues } from "./errors.js";

/** The file the installer copies to /etc/yonder/config.yaml on a clean board. */
const SHIPPED = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "config", "defaults", "config.yaml",
);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-def-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the shipped default configuration", () => {
  it("is a configuration the schema accepts", () => {
    const parsed = ConfigSchema.safeParse(parse(readFileSync(SHIPPED, "utf8")));
    const issues = parsed.success ? [] : formatIssues(parsed.error);
    expect(issues, `config/defaults/config.yaml is not valid:\n  ${issues.join("\n  ")}`)
      .toEqual([]);
  });

  it("is exactly what the generator produces", () => {
    // The committed file is generated, never hand-written. If this fails, run
    // `npm run defaults -w yonder-core` and commit the result — the shipped
    // default has drifted from DEFAULT_CONFIG and would ship a shape the
    // schema no longer describes.
    expect(readFileSync(SHIPPED, "utf8")).toBe(renderDefaultConfig());
  });

  it("carries no value the model does not", () => {
    expect(ConfigSchema.parse(parse(readFileSync(SHIPPED, "utf8")))).toEqual(DEFAULT_CONFIG);
  });
});

describe("seedConfigIfAbsent", () => {
  it("writes a loadable configuration where there was none", () => {
    const path = join(dir, "config.yaml");
    expect(seedConfigIfAbsent(path)).toBe(true);
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("creates the directory a fresh device does not have yet", () => {
    const path = join(dir, "etc", "yonder", "config.yaml");
    expect(seedConfigIfAbsent(path)).toBe(true);
    expect(loadConfig(path).network.ap.ssid).toBe("yonder");
  });

  it("never overwrites a configuration that already exists", () => {
    const path = join(dir, "config.yaml");
    // Deliberately not a valid configuration: an operator's file is theirs
    // even when it is broken. Silently replacing it with defaults would
    // discard the only record of what they meant.
    writeFileSync(path, "version: 1\nmine: true\n");
    expect(seedConfigIfAbsent(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("version: 1\nmine: true\n");
  });

  it("is what the installer copies", () => {
    const path = join(dir, "config.yaml");
    seedConfigIfAbsent(path);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(SHIPPED, "utf8"));
  });
});
