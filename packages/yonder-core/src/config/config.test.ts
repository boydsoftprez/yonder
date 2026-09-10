// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./load.js";
import { saveConfig } from "./save.js";
import { ConfigError } from "./errors.js";
import { DEFAULT_CONFIG, ConfigSchema } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it('reuses validation for identical bytes while giving every caller an independent nested copy', () => {
    const p=join(dir,'cached.yaml');saveConfig(p,DEFAULT_CONFIG);
    const validate=vi.spyOn(ConfigSchema,'safeParse');
    try {
      const first=loadConfig(p);first.network.ap.ssid='unsaved edit';
      const second=loadConfig(p);
      expect(second.network.ap.ssid).toBe(DEFAULT_CONFIG.network.ap.ssid);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(second).not.toBe(first);expect(second.network).not.toBe(first.network);
    } finally { validate.mockRestore(); }
  });

  it('sees an immediate same-length edit and rollback without a freshness timeout', () => {
    const p=join(dir,'current.yaml');saveConfig(p,DEFAULT_CONFIG);const raw=readFileSync(p,'utf8');
    expect(loadConfig(p).network.ap.ssid).toBe('yonder');
    writeFileSync(p,raw.replace('ssid: yonder','ssid: camera'));
    expect(loadConfig(p).network.ap.ssid).toBe('camera');
    writeFileSync(p,raw);expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  });

  it('never serves the cached configuration over a missing or invalid current file', () => {
    const p=join(dir,'current.yaml');saveConfig(p,DEFAULT_CONFIG);loadConfig(p);
    writeFileSync(p,'version: 1\nunknown_field: true\n');expect(()=>loadConfig(p)).toThrow(ConfigError);
    writeFileSync(p,'version: [bad\n');expect(()=>loadConfig(p)).toThrow(ConfigError);
    rmSync(p);expect(()=>loadConfig(p)).toThrow(ConfigError);
    saveConfig(p,DEFAULT_CONFIG);expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  });

  it('bounds cached paths instead of retaining every configuration ever read', () => {
    const paths=Array.from({length:9},(_,i)=>join(dir,`c${i}.yaml`));
    for(const p of paths)saveConfig(p,DEFAULT_CONFIG);
    const validate=vi.spyOn(ConfigSchema,'safeParse');
    try {
      for(const p of paths)loadConfig(p);
      loadConfig(paths[8]);expect(validate).toHaveBeenCalledTimes(9);
      loadConfig(paths[0]);expect(validate).toHaveBeenCalledTimes(10);
    } finally {validate.mockRestore();}
  });

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

/**
 * R-CFG-09. The failure this covers happened on a Raspberry Pi: a board
 * running an earlier build was upgraded past the commit that removed
 * `network.ap.dhcp`, and because the schema is strict, every read of its
 * `/etc/yonder/config.yaml` failed. The network was never rendered, the
 * fallback watchdog could not read the file either and ran on defaults, and
 * the only reason anyone reached the board was an Ethernet cable that
 * happened to be plugged in. On an aircraft that is a card reader.
 *
 * The fixture is not written from the description above — it is
 * `config/defaults/config.yaml` as of 5526cf9^, byte for byte: the file the
 * installer of that build seeded onto the card.
 */
describe("loadConfig, on a configuration an earlier version wrote", () => {
  const FIXTURE = join(
    dirname(fileURLToPath(import.meta.url)), "fixtures", "config-0.1.0-with-dhcp.yaml",
  );
  const seededByAnEarlierBuild = () => readFileSync(FIXTURE, "utf8");

  /** Capture the journal without letting the test's own output into it. */
  function journal(): { lines: () => string; restore: () => void } {
    let captured = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      captured += String(chunk);
      return true;
    });
    return { lines: () => captured, restore: () => { spy.mockRestore(); } };
  }

  it("loads, with the retired key gone from the result", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, seededByAnEarlierBuild());
    const log = journal();
    try {
      const config = loadConfig(p);
      // The whole document survives — this is not a fallback to defaults.
      expect(config.network.ap.ssid).toBe("yonder");
      expect(config.network.ap.address).toBe("192.168.77.1/24");
      expect(config.network.ap.fallback.timeout).toBe(90);
      // And the key that is no longer real is not in what the daemon holds.
      expect("dhcp" in config.network.ap).toBe(false);
      // The live setting of the same name is untouched.
      expect(config.network.ethernet.dhcp).toBe(true);
    } finally {
      log.restore();
    }
  });

  it("says so, naming the key", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, seededByAnEarlierBuild());
    const log = journal();
    try {
      loadConfig(p);
    } finally {
      log.restore();
    }
    // Dropping a setting in silence is its own failure: an operator would go
    // on believing they had configured a DHCP pool.
    expect(log.lines()).toContain("network.ap.dhcp");
    expect(log.lines()).toContain("no longer used by Yonder");
    expect(log.lines()).toContain(p);
  });

  it("does not rewrite the operator's file", () => {
    // Loading is a read. The daemon loads on every GET /config, at start-up
    // and again after the radio settles; a load that edited /etc would be
    // rewriting a file nobody asked it to touch, on a card that may be
    // read-only, while the operator is looking at something else.
    const p = join(dir, "config.yaml");
    writeFileSync(p, seededByAnEarlierBuild());
    const before = readFileSync(p);
    const log = journal();
    try {
      loadConfig(p);
    } finally {
      log.restore();
    }
    expect(readFileSync(p)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("drops the retired key from the file the next time it is saved", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, seededByAnEarlierBuild());
    const log = journal();
    try {
      saveConfig(p, loadConfig(p));
    } finally {
      log.restore();
    }
    const rewritten = readFileSync(p, "utf8");
    expect(rewritten).not.toContain("start:");
    expect(rewritten).not.toContain("lease:");
    // Loading the result is silent: there is nothing left to retire.
    const quiet = journal();
    try {
      expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
    } finally {
      quiet.restore();
    }
    expect(quiet.lines()).toBe("");
  });

  /**
   * The case that must never regress. `.strict()` exists because a key the
   * schema silently ignored would leave an operator sure they had set an
   * SSID they had not — on the radio that is how they reach the aircraft.
   * Tolerating retired keys buys nothing if it also swallows this.
   */
  it("still refuses a misspelling of a real key", () => {
    const p = join(dir, "config.yaml");
    // Both at once, on purpose: the retired key is dropped and the document
    // is *still* refused. Tolerance is per key, not an amnesty on the file.
    writeFileSync(p, seededByAnEarlierBuild().replace("ssid: yonder", "ssdi: yonder"));
    const log = journal();
    try {
      loadConfig(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("ssdi");
      expect((e as ConfigError).issues.join(" ")).toContain("network.ap");
    } finally {
      log.restore();
    }
  });

  it("still refuses a key nobody has ever retired", () => {
    const p = join(dir, "config.yaml");
    writeFileSync(p, seededByAnEarlierBuild().replace("ssid: yonder", "ssid: yonder\n    telepathy: true"));
    const log = journal();
    try {
      loadConfig(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("telepathy");
      expect((e as ConfigError).issues.join(" ")).toContain("network.ap");
    } finally {
      log.restore();
    }
  });
});
