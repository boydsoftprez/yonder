// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";
import { formatIssues } from "../config/errors.js";

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
});

/**
 * The rule none of the fields can state on its own. Changing the access point
 * to another subnet while the pool stays behind renders *successfully* — a
 * `connection modify` and a file write, both reporting success — so the apply
 * engine has nothing to roll back, and the operator's existing lease keeps
 * them connected long enough to confirm it. The device only becomes
 * unreachable at the next boot, and the fallback watchdog's one action is to
 * raise that same access point nobody can get an address from.
 */
describe("the DHCP pool against the access point's subnet", () => {
  function withPool(address: string, start: string, end: string) {
    const c = structuredClone(DEFAULT_CONFIG);
    c.network.ap.address = address;
    c.network.ap.dhcp.start = start;
    c.network.ap.dhcp.end = end;
    return ConfigSchema.safeParse(c);
  }

  it("accepts the shipped default", () => {
    expect(withPool("192.168.77.1/24", "192.168.77.2", "192.168.77.50").success).toBe(true);
  });

  it("rejects a pool left behind when the address moves to another subnet", () => {
    const r = withPool("10.0.0.1/24", "192.168.77.2", "192.168.77.50");
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!).join("\n")).toMatch(/inside the access point's subnet/);
  });

  it("rejects a pool that spills past the end of a narrow subnet", () => {
    // /28 is 192.168.77.0–15; .50 is outside it.
    expect(withPool("192.168.77.1/28", "192.168.77.2", "192.168.77.50").success).toBe(false);
  });

  it("accepts a pool that fits inside that narrow subnet", () => {
    expect(withPool("192.168.77.1/28", "192.168.77.2", "192.168.77.14").success).toBe(true);
  });

  it("rejects the network and broadcast addresses, which are not host addresses", () => {
    expect(withPool("192.168.77.1/24", "192.168.77.0", "192.168.77.50").success).toBe(false);
    expect(withPool("192.168.77.1/24", "192.168.77.2", "192.168.77.255").success).toBe(false);
  });

  it("rejects a pool containing the access point's own address", () => {
    const r = withPool("192.168.77.10/24", "192.168.77.2", "192.168.77.50");
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!).join("\n")).toMatch(/access point's own address/);
  });

  it("rejects a pool that ends before it starts", () => {
    const r = withPool("192.168.77.1/24", "192.168.77.50", "192.168.77.2");
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!).join("\n")).toMatch(/before it starts/);
  });

  it("names the field that is wrong, so the operator can fix it", () => {
    const r = withPool("10.0.0.1/24", "192.168.77.2", "192.168.77.50");
    expect(formatIssues(r.error!).join("\n")).toContain("network.ap.dhcp.start");
  });
});
