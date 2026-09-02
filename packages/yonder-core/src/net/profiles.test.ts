// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apProfile, clientProfile, ethernetProfile, desiredProfiles, radioPlan, wifiMode,
  AP_CONNECTION, CLIENT_CONNECTION, DEFAULT_AP_PASSPHRASE,
} from "./profiles.js";
import { MODEM_CONNECTION } from "./modem/profiles.js";
import { SecretStore } from "../secrets/store.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-prof-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function settingsOf(p: { settings: string[][] }): Record<string, string> {
  return Object.fromEntries(p.settings.map(([k, v]) => [k, v]));
}

/**
 * A secret store good for exactly what `desiredProfiles` needs when a wifi
 * interface is present: `ap_psk` always resolves, because the access point's
 * profile is written whenever there is a radio, even in client mode.
 */
function fakeSecrets(): SecretStore {
  const store = new SecretStore(join(dir, `secrets-${Math.random().toString(36).slice(2)}.yaml`));
  store.ensureValue("ap_psk", "test-ap-psk");
  return store;
}

describe("DEFAULT_AP_PASSPHRASE", () => {
  /**
   * ADR-0007: published, documented, the same on every device. A value the
   * radio would refuse is not a joinable device, and this one is quoted in
   * the README and in the setup procedure, so it has to be typeable.
   */
  it("is a pre-shared key WPA2 will accept", () => {
    expect(DEFAULT_AP_PASSPHRASE.length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_AP_PASSPHRASE.length).toBeLessThanOrEqual(63);
    expect(DEFAULT_AP_PASSPHRASE).toMatch(/^[\x20-\x7e]+$/);
  });

  it("is the value the documentation publishes", () => {
    expect(DEFAULT_AP_PASSPHRASE).toBe("yonder1234");
  });
});

describe("apProfile", () => {
  it("declares a wifi access point on the given interface", () => {
    const p = apProfile(DEFAULT_CONFIG, "secretpsk123", "wlan0");
    expect(p.type).toBe("wifi");
    expect(p.ifname).toBe("wlan0");
    const s = settingsOf(p);
    expect(s["802-11-wireless.mode"]).toBe("ap");
    expect(s["802-11-wireless.ssid"]).toBe("yonder");
  });

  /**
   * `type` and `ifname` are `connection add` common options, not properties.
   * A settings pair named either of them would be sent to
   * `connection modify` too, which rejects it — and a connection's type
   * cannot be changed at all. Every settings pair has to be a fully-qualified
   * setting.property that modify will accept.
   */
  it("carries no add-only option among its settings", () => {
    const withClient: Config = structuredClone(DEFAULT_CONFIG);
    withClient.network.client.ssid = "HomeNetwork";
    for (const p of [
      apProfile(DEFAULT_CONFIG, "p", "wlan0"),
      clientProfile(withClient, "p", "wlan0")!,
      ethernetProfile(DEFAULT_CONFIG, "eth0"),
    ]) {
      for (const [key] of p.settings) {
        expect(key).not.toBe("type");
        expect(key).not.toBe("ifname");
        expect(key, `${key} is not a fully-qualified setting.property`).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
      }
    }
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

  /**
   * Asserted on the pair that actually reaches nmcli. The profile used to
   * carry a separate `autoconnect` boolean as well, which nothing read: this
   * assertion held while the live setting was flipped to "yes".
   */
  it("does not autoconnect: the access point is brought up deliberately", () => {
    expect(settingsOf(apProfile(DEFAULT_CONFIG, "p", "wlan0"))["connection.autoconnect"]).toBe("no");
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
    expect(s["connection.autoconnect"]).toBe("yes");
    expect(p!.type).toBe("wifi");
    expect(p!.ifname).toBe("wlan0");
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
    expect(p.type).toBe("ethernet");
    expect(p.ifname).toBe("eth0");
    const s = settingsOf(p);
    expect(s["ipv4.method"]).toBe("auto");
    expect(s["connection.autoconnect"]).toBe("yes");
  });
});

/**
 * The arbitration K-13 says nothing used to do (Task 5 of M1b-2).
 *
 * One radio can be an access point or a client, not both. These tests are
 * about which, and in what order — the decision, tested without an nmcli,
 * because the decision is the part that has to be readable.
 */
describe("wifiMode", () => {
  it("is the access point when no client network is configured", () => {
    expect(wifiMode(DEFAULT_CONFIG)).toBe("ap");
  });

  /**
   * There is no reading of "I entered an SSID and a passphrase" under which
   * the access point is what the operator wanted. They get it back
   * automatically when the join does not work, which is the rollback engine
   * and the fallback doing their jobs — not a second interpretation of the
   * configuration.
   */
  it("is the client whenever one is configured, whatever the access point says", () => {
    for (const apEnabled of [true, false]) {
      const config = structuredClone(DEFAULT_CONFIG);
      config.network.ap.enabled = apEnabled;
      config.network.client.ssid = "HomeNetwork";
      expect(wifiMode(config), `ap.enabled=${apEnabled}`).toBe("client");
    }
  });

  it("treats an empty ssid as no client, the same as a null one", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "";
    expect(wifiMode(config)).toBe("ap");
  });
});

describe("radioPlan", () => {
  it("raises the access point when that is the mode and it is enabled", () => {
    expect(radioPlan(DEFAULT_CONFIG)).toEqual([{ action: "up", connection: AP_CONNECTION }]);
  });

  it("takes the access point down when it is disabled and no client is configured", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.ap.enabled = false;
    expect(radioPlan(config)).toEqual([{ action: "down", connection: AP_CONNECTION }]);
  });

  /**
   * Lower before raise, and the order is not a preference.
   *
   * This asserted the opposite, with a reason that read well: the operator is
   * talking to the device over the radio being retuned, so a board that fails
   * to associate should not already have thrown away the thing they are
   * talking through. A Raspberry Pi 4 refused:
   *
   *     nmcli connection up yonder-wifi
   *     Error: Connection activation failed: The Wi-Fi network could not be found
   *
   * — while that radio was beaconing as `yonder` on channel 6. One radio can
   * scan in AP mode; it cannot associate. The access point has to come down
   * to free it, and the operator does lose the page at that moment.
   *
   * The test passed for as long as it did because the fake nmcli underneath it
   * activates whatever it is asked to.
   */
  it("takes the access point down before it raises the client", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "HomeNetwork";
    expect(radioPlan(config)).toEqual([
      { action: "down", connection: AP_CONNECTION },
      { action: "up", connection: CLIENT_CONNECTION },
    ]);
  });

  /**
   * `ap.enabled` decides what happens in access-point mode, which is the only
   * mode where there is a choice. In client mode the radio cannot serve both,
   * so leaving the access point up is not an option the hardware offers.
   */
  it("takes the access point down in client mode even when it is enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "HomeNetwork";
    config.network.ap.enabled = true;
    expect(radioPlan(config).filter((s) => s.connection === AP_CONNECTION))
      .toEqual([{ action: "down", connection: AP_CONNECTION }]);
  });

  it("never raises two things on one radio", () => {
    for (const [ssid, enabled] of [["HomeNetwork", true], ["HomeNetwork", false], [null, true], [null, false]] as const) {
      const config = structuredClone(DEFAULT_CONFIG);
      config.network.client.ssid = ssid;
      config.network.ap.enabled = enabled;
      expect(radioPlan(config).filter((s) => s.action === "up").length,
        `ssid=${String(ssid)} ap.enabled=${enabled}`).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The half of the arbitration that must not be "tidied up" later. Deleting
 * the access point's profile when a client is configured would look like the
 * cleaner fix and would leave `nmcli connection up yonder-ap` — the fallback
 * watchdog's only action — naming a profile nothing had created, which is
 * K-16's failure: a device unreachable until a power cycle (R-NET-07).
 */
describe("the access point's profile in client mode", () => {
  it("is still written, so the fallback has something to raise", () => {
    const store = new SecretStore(join(dir, "secrets.yaml"));
    store.ensureValue("ap_psk", "a-passphrase");
    store.ensureValue("wifi_psk", "another-one");
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "HomeNetwork";
    config.network.client.psk = { secret: "wifi_psk" };
    config.network.ap.enabled = false;

    const names = desiredProfiles(config, store, { wifi: "wlan0", ethernet: null, modem: null })
      .map((p) => p.name);
    expect(names).toContain(AP_CONNECTION);
    expect(names).toContain(CLIENT_CONNECTION);
  });
});

describe("desiredProfiles with a modem", () => {
  it("writes the modem profile when a modem interface was found", () => {
    const config = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" },
      },
    };
    const names = desiredProfiles(config, fakeSecrets(), {
      wifi: "wlan0", ethernet: "eth0", modem: "cdc-wdm0",
    }).map((p) => p.name);
    expect(names).toContain(MODEM_CONNECTION);
  });

  it("writes nothing for a modem on a board that has none", () => {
    const names = desiredProfiles(DEFAULT_CONFIG, fakeSecrets(), {
      wifi: "wlan0", ethernet: "eth0", modem: null,
    }).map((p) => p.name);
    expect(names).not.toContain(MODEM_CONNECTION);
  });
});
