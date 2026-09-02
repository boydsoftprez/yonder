// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CLIENT_PSK_SECRET, joinNetwork, type SecretSink } from "./join.js";
import { wifiMode } from "./profiles.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";

function sink(): SecretSink & { stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  return { stored, put: (name, value) => { stored[name] = value; } };
}

describe("joinNetwork", () => {
  it("produces a configuration that puts the radio into client mode", () => {
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" }, sink());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.client.ssid).toBe("HomeNetwork");
    expect(wifiMode(result.config)).toBe("client");
    // And it is a configuration the schema accepts, which is what the apply
    // engine is about to be handed.
    expect(ConfigSchema.safeParse(result.config).success).toBe(true);
  });

  /**
   * config.yaml is 0644 and travels in a support bundle. secrets.yaml is 0600
   * root and does not. The passphrase goes in the second and the configuration
   * carries a reference — the same shape the access point's own passphrase has
   * had since M0.
   */
  it("puts the passphrase in the secret store and a reference in the configuration", () => {
    const secrets = sink();
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" }, secrets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(secrets.stored[CLIENT_PSK_SECRET]).toBe("a-passphrase");
    expect(result.config.network.client.psk).toEqual({ secret: CLIENT_PSK_SECRET });
    expect(JSON.stringify(result.config)).not.toContain("a-passphrase");
  });

  it("leaves everything else exactly as it was", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    const result = joinNetwork(before, { ssid: "HomeNetwork", psk: "a-passphrase" }, sink());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.ap).toEqual(before.network.ap);
    expect(result.config.ui).toEqual(before.ui);
    expect(result.config.system).toEqual(before.system);
    // And the caller's own document is untouched.
    expect(before).toEqual(DEFAULT_CONFIG);
  });

  /**
   * Whether the access point can stay up is a question about the radio, not
   * about this request. `radioPlan` answers it (K-13), and quietly disabling
   * the access point here would put a decision about reachability in the wrong
   * place — and leave it disabled after a rollback.
   */
  it("does not disable the access point", () => {
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" }, sink());
    expect(result.ok && result.config.network.ap.enabled).toBe(true);
  });

  it("allows an open network, which is a real kind of network", () => {
    const secrets = sink();
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "OpenGuest" }, secrets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.client.psk).toBeNull();
    expect(secrets.stored).toEqual({});
  });

  /**
   * WPA2's own limits, checked here so an operator finds out immediately
   * rather than by watching a five-minute confirmation window expire on a
   * board that was never going to associate.
   */
  it("refuses a passphrase no access point would accept", () => {
    for (const psk of ["short", "1234567", "x".repeat(64)]) {
      const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk }, sink());
      expect(result.ok, psk).toBe(false);
      expect(result.ok === false && result.error).toContain("passphrase must be");
    }
  });

  it("refuses an ssid that is not one", () => {
    for (const ssid of ["", "x".repeat(33), undefined, null, 42, {}]) {
      const result = joinNetwork(DEFAULT_CONFIG, { ssid }, sink());
      expect(result.ok, JSON.stringify(ssid)).toBe(false);
    }
    expect(joinNetwork(DEFAULT_CONFIG, undefined, sink()).ok).toBe(false);
  });

  it("does not echo what was submitted back into the refusal", () => {
    const result = joinNetwork(
      DEFAULT_CONFIG,
      { ssid: "<script>alert(1)</script>".repeat(3), psk: "hunter2" },
      sink(),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toContain("script");
    expect(result.ok === false && result.error).not.toContain("hunter2");
  });

  it("stores nothing at all when the request is refused", () => {
    const secrets = sink();
    joinNetwork(DEFAULT_CONFIG, { ssid: "", psk: "a-passphrase" }, secrets);
    expect(secrets.stored).toEqual({});
  });
});
