// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { MODEM_CONNECTION, modemProfile } from "./profiles.js";

const withModem = (over: Record<string, unknown>) => ({
  ...DEFAULT_CONFIG,
  network: { ...DEFAULT_CONFIG.network, modem: { ...DEFAULT_CONFIG.network.modem, ...over } },
});

const settings = (p: { settings: string[][] }) => Object.fromEntries(p.settings);

describe("modemProfile", () => {
  it("is null when no modem is configured", () => {
    expect(modemProfile(DEFAULT_CONFIG, null, "cdc-wdm0")).toBeNull();
  });

  it("builds a gsm connection bound to the control port", () => {
    // NetworkManager binds cdc-wdm0. wwan0 is where the traffic goes and is
    // not what a connection names.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(p?.name).toBe(MODEM_CONNECTION);
    expect(p?.type).toBe("gsm");
    expect(p?.ifname).toBe("cdc-wdm0");
    expect(settings(p!)["gsm.apn"]).toBe("ereseller");
  });

  it("comes up by itself, so a modem that drops comes back", () => {
    // R-CEL-06. Reconnection is NetworkManager's, not a loop of Yonder's.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(settings(p!)["connection.autoconnect"]).toBe("yes");
  });

  it("sets a route metric from the operator's order", () => {
    // R-NET-06's mechanism: ethernet 100, modem 700 were the measured
    // defaults, and the metric is what decides which default route wins.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(settings(p!)["ipv4.route-metric"]).toBe("700");
    expect(settings(p!)["ipv6.route-metric"]).toBe("700");
  });

  it("passes a username and password only when they are set", () => {
    const bare = modemProfile(withModem({ enabled: true, apn: "a" }), null, "cdc-wdm0");
    expect(settings(bare!)["gsm.password"]).toBeUndefined();
    const full = modemProfile(withModem({ enabled: true, apn: "a", username: "u" }), "pw", "cdc-wdm0");
    expect(settings(full!)["gsm.username"]).toBe("u");
    expect(settings(full!)["gsm.password"]).toBe("pw");
  });

  it("passes a dial string only when one is configured", () => {
    // Empty on every modem measured: a QMI or MBIM bearer has no dial step.
    const none = modemProfile(withModem({ enabled: true, apn: "a" }), null, "cdc-wdm0");
    expect(settings(none!)["gsm.number"]).toBeUndefined();
    const dialed = modemProfile(withModem({ enabled: true, apn: "a", dial: "*99#" }), null, "cdc-wdm0");
    expect(settings(dialed!)["gsm.number"]).toBe("*99#");
  });

  it("builds an ethernet connection for a modem the operator named", () => {
    const p = modemProfile(
      withModem({ enabled: true, mode: "appliance", interface: "usb0" }), null, "usb0");
    expect(p?.type).toBe("ethernet");
    expect(p?.ifname).toBe("usb0");
    expect(settings(p!)["ipv4.method"]).toBe("auto");
  });
});
