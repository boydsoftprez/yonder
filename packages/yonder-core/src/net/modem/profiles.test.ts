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

  it.each(["auto", "appliance"])("keeps retrying a slow modem in %s mode (R-CEL-06)", (mode) => {
    const p = modemProfile(withModem({ enabled: true, mode }), null, "usb0");
    expect(settings(p!)["connection.autoconnect-retries"]).toBe("0");
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

  /**
   * **A setting the configuration no longer holds is named for removal**
   * (R-CFG-13). Omitting it is what a profile used to do, and
   * `nmcli connection modify` writes only what it is given — so a cleared APN
   * left the stored one in place and dialling, with `config.yaml` saying there
   * was none.
   */
  it("names every bearer setting the configuration does not hold", () => {
    const p = modemProfile(withModem({ enabled: true }), null, "cdc-wdm0");
    expect(p?.clear?.slice().sort())
      .toEqual(["gsm.apn", "gsm.number", "gsm.password", "gsm.username"]);
  });

  it("names for removal only what it is not also writing", () => {
    const p = modemProfile(
      withModem({ enabled: true, apn: "ereseller", username: "u", dial: "*99#" }), "pw", "cdc-wdm0");
    expect(p?.clear).toEqual([]);
  });

  it("clears the credential when the configuration says there is none", () => {
    // `password: null` is the file's own word for "there is no credential",
    // and `resolve` throws on a reference to a row the store does not have —
    // so a null arriving here can only ever mean the configuration said so,
    // never that a secret went missing.
    const p = modemProfile(withModem({ enabled: true, apn: "a", username: "u" }), null, "cdc-wdm0");
    expect(p?.clear).toContain("gsm.password");
    expect(p?.clear).not.toContain("gsm.username");
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

  /**
   * A bearer setting being **removed** is a change to the bearer exactly as
   * one being altered is, and it is the one the comparison could not see: a
   * property absent from the desired profile is a property `bearerChanges`
   * never asks nmcli about, so clearing an APN wrote the reset and left the
   * modem dialled on the old bearer (R-CEL-09).
   */
  it("counts a setting being cleared as a setting to dial again", () => {
    const p = modemProfile(withModem({ enabled: true }), null, "cdc-wdm0");
    expect(redialSettings(p!.settings, p!.clear).map(([n]) => n).sort())
      .toEqual(["gsm.apn", "gsm.number", "gsm.password", "gsm.username"]);
    // With an empty value, which is what makes `bearerChanges` see a stored
    // `ereseller` as a difference rather than never asking about it.
    expect(redialSettings(p!.settings, p!.clear).every(([, v]) => v === "")).toBe(true);
  });

  it("is empty for a modem that dials for itself", () => {
    // An appliance is a network adapter to this board, so nothing here is
    // ever cycled by the re-dial mechanism (R-CEL-11).
    const p = modemProfile(
      withModem({ enabled: true, mode: "appliance", interface: "usb0" }), null, "usb0");
    expect(redialSettings(p!.settings, p!.clear ?? [])).toEqual([]);
  });
});

describe("bearerChanges", () => {
  it.each(["", "configured-secret"])("does not redial for a masked password when wanted is %j", (password) => {
    expect(bearerChanges(
      [["gsm.apn", "ereseller"], ["gsm.password", password]],
      "gsm.apn:ereseller\ngsm.password:<hidden>\n",
    )).toEqual([]);
    expect(bearerChanges(
      [["gsm.apn", "new-apn"], ["gsm.password", password]],
      "gsm.apn:ereseller\ngsm.password:<hidden>\n",
    )).toEqual(["gsm.apn"]);
  });

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
