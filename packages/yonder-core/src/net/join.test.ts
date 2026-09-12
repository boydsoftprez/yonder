// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CLIENT_PSK_SECRET, joinNetwork, leaveNetwork } from "./join.js";
import { wifiMode } from "./profiles.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";


describe("joinNetwork", () => {
  it("produces a configuration that puts the radio into client mode", () => {
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" });
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
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretPatch).toEqual({ [CLIENT_PSK_SECRET]: "a-passphrase" });
    expect(result.config.network.client.psk).toEqual({ secret: CLIENT_PSK_SECRET });
    expect(JSON.stringify(result.config)).not.toContain("a-passphrase");
  });

  it("leaves everything else exactly as it was", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    const result = joinNetwork(before, { ssid: "HomeNetwork", psk: "a-passphrase" });
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
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk: "a-passphrase" });
    expect(result.ok && result.config.network.ap.enabled).toBe(true);
  });

  it("allows an open network, which is a real kind of network", () => {
    const result = joinNetwork(DEFAULT_CONFIG, { ssid: "OpenGuest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.client.psk).toBeNull();
    expect(result.secretPatch).toEqual({});
  });

  /**
   * WPA2's own limits, checked here so an operator finds out immediately
   * rather than by watching a five-minute confirmation window expire on a
   * board that was never going to associate.
   */
  it("refuses a passphrase no access point would accept", () => {
    for (const psk of ["short", "1234567", "x".repeat(64)]) {
      const result = joinNetwork(DEFAULT_CONFIG, { ssid: "HomeNetwork", psk });
      expect(result.ok, psk).toBe(false);
      expect(result.ok === false && result.error).toContain("passphrase must be");
    }
  });

  it("refuses an ssid that is not one", () => {
    for (const ssid of ["", "x".repeat(33), undefined, null, 42, {}]) {
      const result = joinNetwork(DEFAULT_CONFIG, { ssid });
      expect(result.ok, JSON.stringify(ssid)).toBe(false);
    }
    expect(joinNetwork(DEFAULT_CONFIG, undefined).ok).toBe(false);
  });

  it("does not echo what was submitted back into the refusal", () => {
    const result = joinNetwork(
      DEFAULT_CONFIG,
      { ssid: "<script>alert(1)</script>".repeat(3), psk: "hunter2" },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toContain("script");
    expect(result.ok === false && result.error).not.toContain("hunter2");
  });

  it("stores nothing at all when the request is refused", () => {
    expect(joinNetwork(DEFAULT_CONFIG, { ssid: "", psk: "a-passphrase" }).ok).toBe(false);
  });
});

/**
 * The way back.
 *
 * Joining was a one-way door: the console could take the radio onto a network
 * and had no control to bring it back, so an operator who joined the wrong
 * one had no way to say so from the interface that put them there.
 */
describe("leaveNetwork", () => {
  function joined(): Config {
    const c = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    return c;
  }

  it("clears the network, which is what puts the radio back on the access point", () => {
    const left = leaveNetwork(joined());
    expect(left.network.client.ssid).toBeNull();
  });

  it("drops the passphrase reference with it", () => {
    // A secret still pointing at a network this device is not on is a stale
    // reference waiting to resolve against the wrong thing.
    expect(leaveNetwork(joined()).network.client.psk).toBeNull();
  });

  it("changes nothing else", () => {
    const from = joined();
    const left = leaveNetwork(from);
    const expected = structuredClone(from);
    expected.network.client = { ssid: null, psk: null };
    expect(left).toEqual(expected);
  });

  it("never touches the configuration it was given", () => {
    const from = joined();
    const before = structuredClone(from);
    leaveNetwork(from);
    expect(from).toEqual(before);
  });

  it("is safe to ask for when the device is already on its access point", () => {
    expect(leaveNetwork(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });
});
