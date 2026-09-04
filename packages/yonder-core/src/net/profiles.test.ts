// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apProfile, clientProfile, ethernetProfile, desiredProfiles, radioPlan, wifiMode,
  AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, DEFAULT_AP_PASSPHRASE,
  publishableApPassphrase,
} from "./profiles.js";
import { MODEM_CONNECTION, STOOD_DOWN_METRIC, metricFor, modemProfile } from "./modem/profiles.js";
import type { PathName, StandingView } from "./reach/standing.js";
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

/**
 * The one rule R-UI-18 turns on: an operator's passphrase is theirs, and the
 * published one is not a secret at all (ADR-0007, R-SEC-10).
 */
describe("publishableApPassphrase", () => {
  it("publishes the default while the device is still on it", () => {
    expect(publishableApPassphrase(DEFAULT_AP_PASSPHRASE)).toBe(DEFAULT_AP_PASSPHRASE);
  });

  it("withholds one the operator has set", () => {
    expect(publishableApPassphrase("something-they-chose")).toBeNull();
  });

  /**
   * The property that makes a leak unreachable rather than merely absent: no
   * argument produces an answer that is not either the module's own constant
   * or null. A caller cannot get a stored credential out of this function by
   * passing one in — which is what "redaction happens where the value is
   * captured" means when the value is a comparison rather than a log line.
   */
  it("answers with the constant or with nothing, whatever it is given", () => {
    for (const stored of [
      DEFAULT_AP_PASSPHRASE, "yonder1235", "", " yonder1234", "YONDER1234",
      "an-operators-own-passphrase", undefined,
    ]) {
      const answer = publishableApPassphrase(stored);
      expect(answer === DEFAULT_AP_PASSPHRASE || answer === null).toBe(true);
    }
  });

  /**
   * A near miss is not the default. Case, whitespace and one wrong character
   * are all passphrases somebody chose, and each of them would join a
   * different access point.
   */
  it("treats a near miss as the operator's own", () => {
    for (const near of ["yonder1234 ", " yonder1234", "Yonder1234", "yonder123", ""]) {
      expect(publishableApPassphrase(near)).toBeNull();
    }
  });

  /**
   * No row at all means the store could not be read — the seeding in
   * `daemon/server.ts` runs before anything serves, so a running device
   * always has one. Nothing in that state has an operator's passphrase to
   * leak, and answering `null` would tell an operator who has never changed
   * anything that their way back in is a passphrase they have never seen.
   */
  it("names the published value when there is no row to read", () => {
    expect(publishableApPassphrase(undefined)).toBe(DEFAULT_AP_PASSPHRASE);
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
 * R-NET-06: `network.priority` is the operator's order, and route metrics are
 * how it reaches the kernel.
 *
 * These are about the *relation* between the profiles rather than the
 * literals, because the literals are NetworkManager's own defaults and the
 * thing that has to hold is that a path earlier in `network.priority` sorts
 * ahead of one later in it. `net/reach/monitor.ts` derives which path is
 * carrying traffic from exactly this premise, so a profile without a metric
 * is not untidiness — it makes `pathInUse` name the wrong interface, and the
 * watch then reads the wrong device's counters.
 */
describe("route metrics follow network.priority", () => {
  const eth = (c: Config) => settingsOf(ethernetProfile(c, "eth0"));
  const wifi = (c: Config) => settingsOf(clientProfile(c, null, "wlan0")!);
  const modem = (c: Config) => settingsOf(modemProfile(c, null, "cdc-wdm0")!);

  function board(priority: Config["network"]["priority"]): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.priority = priority;
    c.network.client.ssid = "HomeNetwork";
    c.network.modem.enabled = true;
    return c;
  }

  it("sorts every path the way the operator ordered it", () => {
    const c = board(["ethernet", "modem", "wifi_client"]);
    // The shipped default. Left alone, NetworkManager gives Wi-Fi 600 and the
    // modem 700, so the radio outranks the modem while the configuration says
    // the opposite.
    expect(Number(eth(c)["ipv4.route-metric"]))
      .toBeLessThan(Number(modem(c)["ipv4.route-metric"]));
    expect(Number(modem(c)["ipv4.route-metric"]))
      .toBeLessThan(Number(wifi(c)["ipv4.route-metric"]));
  });

  it("puts the modem ahead of ethernet when that is what was asked for", () => {
    const c = board(["modem", "wifi_client", "ethernet"]);
    expect(Number(modem(c)["ipv4.route-metric"]))
      .toBeLessThan(Number(wifi(c)["ipv4.route-metric"]));
    expect(Number(wifi(c)["ipv4.route-metric"]))
      .toBeLessThan(Number(eth(c)["ipv4.route-metric"]));
  });

  it("gives ethernet and the Wi-Fi client the same metric on v4 and v6", () => {
    const c = board(["ethernet", "modem", "wifi_client"]);
    expect(eth(c)["ipv6.route-metric"]).toBe(String(metricFor(c, "ethernet")));
    expect(wifi(c)["ipv6.route-metric"]).toBe(String(metricFor(c, "wifi_client")));
  });

  it("gives the access point no metric at all", () => {
    // `ipv4.method shared` — the access point hands out addresses and
    // masquerades for its clients. It is not a way out of this board, and a
    // metric on it would enter it into an ordering it does not belong to.
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "p", "wlan0"));
    expect(s["ipv4.route-metric"]).toBeUndefined();
    expect(s["ipv6.route-metric"]).toBeUndefined();
  });
});

/**
 * R-NET-13's second half, at the layer that generates the numbers: **a path
 * that stops reaching anything is stood down, and traffic moves to the next
 * path that works.**
 *
 * The standing is an input to generating the metric, never a second writer of
 * one. `network.priority` still says what outranks what; all a demotion does
 * is push one path out of the running, which is why it is expressed as a
 * number added to the generated metric rather than as a disconnect.
 */
describe("route metrics take standing into account", () => {
  const saying = (...down: PathName[]): StandingView => {
    const set = new Set<PathName>(down);
    return { isStoodDown: (path) => set.has(path) };
  };

  function board(priority: Config["network"]["priority"]): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.priority = priority;
    c.network.client.ssid = "HomeNetwork";
    c.network.modem.enabled = true;
    return c;
  }

  it("gives a stood-down path a metric no healthy path can lose to", () => {
    // The case the milestone is named for, one layer down: a cable plugged
    // into something with no route out keeps its carrier and its metric of
    // 100 and wins, while a working cellular link sits at 700 doing nothing.
    const c = board(["ethernet", "modem", "wifi_client"]);
    const demoted = metricFor(c, "ethernet", saying("ethernet"));
    expect(demoted).toBeGreaterThan(metricFor(c, "modem"));
    expect(demoted).toBeGreaterThan(metricFor(c, "wifi_client"));
    expect(demoted).toBeGreaterThanOrEqual(STOOD_DOWN_METRIC);
  });

  it("gives the configured metric straight back when the path recovers", () => {
    const c = board(["ethernet", "modem", "wifi_client"]);
    expect(metricFor(c, "ethernet", saying())).toBe(metricFor(c, "ethernet"));
  });

  it("does not disturb the paths that are still working", () => {
    const c = board(["ethernet", "modem", "wifi_client"]);
    const standing = saying("ethernet");
    expect(metricFor(c, "modem", standing)).toBe(metricFor(c, "modem"));
    expect(metricFor(c, "wifi_client", standing)).toBe(metricFor(c, "wifi_client"));
  });

  it("keeps the operator's order between two paths that are both stood down", () => {
    // Otherwise they tie, the kernel breaks the tie however it likes, and
    // `pathInUse`'s premise — that the metrics follow network.priority —
    // stops holding on the board where it matters most.
    const c = board(["ethernet", "modem", "wifi_client"]);
    const standing = saying("ethernet", "modem");
    expect(metricFor(c, "ethernet", standing))
      .toBeLessThan(metricFor(c, "modem", standing));
  });

  it("writes the losing metric into the profile itself, on both families", () => {
    const c = board(["ethernet", "modem", "wifi_client"]);
    const standing = saying("ethernet");
    const s = settingsOf(ethernetProfile(c, "eth0", standing));
    expect(s["ipv4.route-metric"]).toBe(String(metricFor(c, "ethernet", standing)));
    expect(s["ipv6.route-metric"]).toBe(s["ipv4.route-metric"]);
    expect(Number(s["ipv4.route-metric"]))
      .toBeGreaterThan(Number(settingsOf(modemProfile(c, null, "cdc-wdm0", standing)!)["ipv4.route-metric"]));
  });

  it("carries the demotion through desiredProfiles, and never onto the access point", () => {
    // A full render must not undo a demotion, and must not touch the one
    // connection an operator with no way out is reaching the board through.
    const c = board(["ethernet", "modem", "wifi_client"]);
    const standing = saying("ethernet");
    const profiles = desiredProfiles(c, fakeSecrets(), { wifi: "wlan0", ethernet: "eth0", modem: "cdc-wdm0" }, standing);
    const byName = Object.fromEntries(profiles.map((p) => [p.name, settingsOf(p)]));
    expect(byName[ETHERNET_CONNECTION]?.["ipv4.route-metric"])
      .toBe(String(metricFor(c, "ethernet", standing)));
    expect(byName[AP_CONNECTION]?.["ipv4.route-metric"]).toBeUndefined();
    expect(byName[AP_CONNECTION]?.["ipv6.route-metric"]).toBeUndefined();
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
