// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.js";
import { saveConfig } from "./save.js";
import { ConfigError } from "./errors.js";
import { DEFAULT_CONFIG } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it("round-trips a saved config", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  });

  it("throws ConfigError with a readable message on invalid YAML", () => {
    const p = join(dir, "bad.yaml");
    writeFileSync(p, "version: 1\n  bad indent:\n");
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });

  it("names the offending field when validation fails", () => {
    const p = join(dir, "invalid.yaml");
    writeFileSync(p, "version: 1\nnetwork:\n  ap:\n    address: nonsense\n");
    try {
      loadConfig(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join(" ")).toContain("network.ap.address");
    }
  });

  it("throws ConfigError when the file is missing", () => {
    expect(() => loadConfig(join(dir, "nope.yaml"))).toThrow(ConfigError);
  });
});

describe("saveConfig", () => {
  it("writes YAML a human can read", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(readFileSync(p, "utf8")).toContain("version: 1");
  });

  it("leaves no temporary file behind", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("leaves the original byte-identical when the write cannot be completed", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    const original = readFileSync(p);

    // Occupy the temp path the atomic write depends on. A writer that opens
    // the live file directly never touches it and would truncate the only
    // good copy of the configuration on the device.
    mkdirSync(`${p}.tmp`);
    const other = structuredClone(DEFAULT_CONFIG);
    other.system.hostname = "clobbered";

    expect(() => saveConfig(p, other)).toThrow(ConfigError);
    expect(readFileSync(p)).toEqual(original);
  });
});
