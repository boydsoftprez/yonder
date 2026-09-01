// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { apProfile, clientProfile, ethernetProfile, AP_CONNECTION, CLIENT_CONNECTION } from "./profiles.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

function settingsOf(p: { settings: string[][] }): Record<string, string> {
  return Object.fromEntries(p.settings.map(([k, v]) => [k, v]));
}

describe("apProfile", () => {
  it("declares a wifi access point on the given interface", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "secretpsk123", "wlan0"));
    expect(s["type"]).toBe("wifi");
    expect(s["ifname"]).toBe("wlan0");
    expect(s["802-11-wireless.mode"]).toBe("ap");
    expect(s["802-11-wireless.ssid"]).toBe("yonder");
  });

  it("uses WPA-PSK with the resolved secret, never a literal from config", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "secretpsk123", "wlan0"));
    expect(s["802-11-wireless-security.key-mgmt"]).toBe("wpa-psk");
    expect(s["802-11-wireless-security.psk"]).toBe("secretpsk123");
    expect(JSON.stringify(s)).not.toContain("ap_psk");
  });

  it("takes the static address from config and shares the connection", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "p", "wlan0"));
    expect(s["ipv4.method"]).toBe("shared");
    expect(s["ipv4.addresses"]).toBe("192.168.77.1/24");
  });

  it("honours a changed address and ssid", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.ssid = "field-unit";
    c.network.ap.address = "10.9.0.1/24";
    const s = settingsOf(apProfile(c, "p", "wlan0"));
    expect(s["802-11-wireless.ssid"]).toBe("field-unit");
    expect(s["ipv4.addresses"]).toBe("10.9.0.1/24");
  });

  it("does not autoconnect: the access point is brought up deliberately", () => {
    expect(apProfile(DEFAULT_CONFIG, "p", "wlan0").autoconnect).toBe(false);
  });

  it("is named consistently", () => {
    expect(apProfile(DEFAULT_CONFIG, "p", "wlan0").name).toBe(AP_CONNECTION);
  });
});

describe("clientProfile", () => {
  it("returns null when no client ssid is configured", () => {
    expect(clientProfile(DEFAULT_CONFIG, null, "wlan0")).toBeNull();
  });

  it("builds an infrastructure profile when an ssid is set", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    const p = clientProfile(c, "homesecret", "wlan0");
    expect(p).not.toBeNull();
    const s = settingsOf(p!);
    expect(p!.name).toBe(CLIENT_CONNECTION);
    expect(s["802-11-wireless.mode"]).toBe("infrastructure");
    expect(s["802-11-wireless.ssid"]).toBe("HomeNetwork");
    expect(s["802-11-wireless-security.psk"]).toBe("homesecret");
    expect(s["ipv4.method"]).toBe("auto");
    expect(p!.autoconnect).toBe(true);
  });

  it("builds an open-network profile when there is no key", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "OpenGuest";
    c.network.client.psk = null;
    const s = settingsOf(clientProfile(c, null, "wlan0")!);
    expect(s["802-11-wireless-security.key-mgmt"]).toBeUndefined();
  });

  it("keeps an ssid containing a colon intact", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "Guest:Wifi";
    c.network.client.psk = null;
    expect(settingsOf(clientProfile(c, null, "wlan0")!)["802-11-wireless.ssid"]).toBe("Guest:Wifi");
  });
});

describe("ethernetProfile", () => {
  it("uses DHCP by default and autoconnects", () => {
    const p = ethernetProfile(DEFAULT_CONFIG, "eth0");
    const s = settingsOf(p);
    expect(s["type"]).toBe("ethernet");
    expect(s["ifname"]).toBe("eth0");
    expect(s["ipv4.method"]).toBe("auto");
    expect(p.autoconnect).toBe(true);
  });
});
