// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { MODEM_CONNECTION, bearerChanges, modemProfile, redialSettings } from "./profiles.js";

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

describe("redialSettings", () => {
  it("keeps the bearer's settings and nothing else", () => {
    // The narrowness is the safety property. A route metric changes whenever
    // a path is stood down or `network.priority` is edited, and it is taken
    // up in place — cycling a working cellular link over one is the thing
    // that must not happen on an aircraft.
    const p = modemProfile(
      withModem({ enabled: true, apn: "ereseller", username: "u", dial: "*99#" }), "pw", "cdc-wdm0");
    expect(redialSettings(p!.settings).map(([n]) => n).sort())
      .toEqual(["gsm.apn", "gsm.number", "gsm.password", "gsm.username"]);
  });

  it("is empty for a modem that dials for itself", () => {
    // An appliance is a network adapter to this board, so nothing here is
    // ever cycled by the re-dial mechanism (R-CEL-11).
    const p = modemProfile(
      withModem({ enabled: true, mode: "appliance", interface: "usb0" }), null, "usb0");
    expect(redialSettings(p!.settings)).toEqual([]);
  });
});

describe("bearerChanges", () => {
  it("names the setting a live bearer would not pick up", () => {
    // The measured defect: dialled on `ereseller`, `config.yaml` now says
    // `nxtgenphone`, and NetworkManager will not re-dial for a profile write.
    expect(bearerChanges([["gsm.apn", "nxtgenphone"]], "gsm.apn:ereseller\n"))
      .toEqual(["gsm.apn"]);
  });

  it("is empty when what is wanted is what is dialled", () => {
    expect(bearerChanges([["gsm.apn", "ereseller"]], "gsm.apn:ereseller\n")).toEqual([]);
  });

  it("treats a value nmcli will not report as no difference", () => {
    // `gsm.password` is not printed without `--show-secrets`, and reading a
    // credential back to compare it puts it one accident away from a log
    // line. Unreadable must mean "cannot tell": treating it as *changed*
    // would cycle the link on every single render.
    expect(bearerChanges(
      [["gsm.apn", "ereseller"], ["gsm.password", "hunter2"]],
      "gsm.apn:ereseller\ngsm.password:\n",
    )).toEqual([]);
    // Absent from the output entirely, and `--`, are the same answer.
    expect(bearerChanges([["gsm.number", "*99#"]], "")).toEqual([]);
    expect(bearerChanges([["gsm.number", "*99#"]], "gsm.number:--\n")).toEqual([]);
  });

  it("reads a value containing a colon as nmcli escaped it", () => {
    expect(bearerChanges([["gsm.apn", "a:b"]], "gsm.apn:a\\:b\n")).toEqual([]);
    expect(bearerChanges([["gsm.apn", "a:b"]], "gsm.apn:a\\:c\n")).toEqual(["gsm.apn"]);
  });
});
