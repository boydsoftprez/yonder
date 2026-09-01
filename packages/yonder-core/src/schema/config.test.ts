// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";

describe("ConfigSchema", () => {
  it("accepts the default config", () => {
    expect(ConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    const bad = { ...DEFAULT_CONFIG, nonsense: true };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a version it does not understand", () => {
    const bad = { ...DEFAULT_CONFIG, version: 99 };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("requires an access point address in CIDR form", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "192.168.77.1";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults the access point fallback to enabled at 90 seconds", () => {
    const parsed = ConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.network.ap.fallback.enabled).toBe(true);
    expect(parsed.network.ap.fallback.timeout).toBe(90);
  });

  it("rejects an egress priority containing an unknown interface", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.priority = ["ethernet", "carrier_pigeon"] as never;
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an address whose octets are not octets", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "999.1.1.1/24";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a prefix length no subnet has", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "192.168.77.1/64";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("does not seed an administrator password reference by default", () => {
    // R-SEC-09: it does not exist until the operator sets one, and a shipped
    // default that names a secret nothing ever creates is a reference the
    // first eager resolver breaks on.
    expect(DEFAULT_CONFIG.ui.editor.password).toBeNull();
  });

  it("still understands a password reference once one is set", () => {
    const set = structuredClone(DEFAULT_CONFIG);
    set.ui.editor.password = { secret: "editor_password" };
    expect(ConfigSchema.safeParse(set).success).toBe(true);
  });

  /**
   * The DHCP pool is gone, and this schema is strict, so a config.yaml
   * carrying the key an earlier build seeded is now rejected rather than
   * quietly ignored (K-14). Stated as a test because "rejected" is a
   * deliberate answer here and not an oversight: a key that decided nothing
   * should not go on looking as though it decides something, and `GET
   * /config` names the offending path so an operator can see which two lines
   * to delete.
   */
  it("rejects an access-point DHCP pool, which no longer decides anything", () => {
    const network = DEFAULT_CONFIG.network;
    const seededByAnEarlierBuild = {
      ...DEFAULT_CONFIG,
      network: {
        ...network,
        ap: { ...network.ap, dhcp: { start: "192.168.77.2", end: "192.168.77.50", lease: "12h" } },
      },
    };
    expect(ConfigSchema.safeParse(seededByAnEarlierBuild).success).toBe(false);
  });
});
