// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDnsmasqConf, writeDnsmasqConf } from "./dnsmasq.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-dns-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("renderDnsmasqConf", () => {
  it("emits the configured pool and lease", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG))
      .toContain("dhcp-range=192.168.77.2,192.168.77.50,12h");
  });

  it("follows a changed pool", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.dhcp = { start: "10.9.0.10", end: "10.9.0.20", lease: "1h" };
    expect(renderDnsmasqConf(c)).toContain("dhcp-range=10.9.0.10,10.9.0.20,1h");
  });

  it("is authoritative, so a client with a stale lease is corrected", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toContain("dhcp-authoritative");
  });

  it("carries a header saying it is generated", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toMatch(/^#/);
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toContain("config.yaml");
  });

  it("is deterministic", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toBe(renderDnsmasqConf(DEFAULT_CONFIG));
  });
});

describe("writeDnsmasqConf", () => {
  it("writes the file world-readable and creates missing parents", () => {
    const p = join(dir, "dnsmasq-shared.d", "yonder.conf");
    writeDnsmasqConf(p, DEFAULT_CONFIG);
    expect(readFileSync(p, "utf8")).toContain("dhcp-range=");
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });

  it("overwrites cleanly when the pool changes", () => {
    const p = join(dir, "yonder.conf");
    writeDnsmasqConf(p, DEFAULT_CONFIG);
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.dhcp.end = "192.168.77.99";
    writeDnsmasqConf(p, c);
    const text = readFileSync(p, "utf8");
    expect(text).toContain("192.168.77.99");
    expect(text).not.toContain("192.168.77.50");
  });
});
