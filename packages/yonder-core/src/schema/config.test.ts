// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";
import { withoutRetiredKeys } from "./retired.js";

/** A config.yaml as a build before the pool was removed would have written it. */
function seededByAnEarlierBuild(): unknown {
  const network = DEFAULT_CONFIG.network;
  return {
    ...DEFAULT_CONFIG,
    network: {
      ...network,
      ap: { ...network.ap, dhcp: { start: "192.168.77.2", end: "192.168.77.50", lease: "12h" } },
    },
  };
}

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
   * The DHCP pool is gone (K-14), and this schema still rejects it. That is
   * the half that has not changed and must not: strictness is what turns a
   * misspelled key into an error instead of a setting an operator wrongly
   * believes is in force.
   *
   * Tolerance lives one layer up, in `retired.ts`, and only for keys this
   * project can name. The two halves are asserted together here because they
   * are a pair: the schema knows nothing about history, and the loader knows
   * exactly one thing about it — the enumerated list. A device seeded by an
   * earlier build boots (R-CFG-09) without the schema going soft on typos.
   */
  it("rejects an access-point DHCP pool, which no longer decides anything", () => {
    expect(ConfigSchema.safeParse(seededByAnEarlierBuild()).success).toBe(false);
  });

  it("accepts that same configuration once the retired key is dropped", () => {
    const { doc, dropped } = withoutRetiredKeys(seededByAnEarlierBuild());
    expect(dropped.map((k) => k.path)).toEqual(["network.ap.dhcp"]);
    expect(ConfigSchema.safeParse(doc).success).toBe(true);
  });
});
