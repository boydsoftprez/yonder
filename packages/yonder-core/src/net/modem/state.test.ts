// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { modemState } from "./state.js";
import type { BearerInfo, ModemInfo, SignalReading } from "./mmcli/client.js";

const NO_SIGNAL: SignalReading = { rssi: null, rsrq: null, rsrp: null, snr: null };
const SIGNAL: SignalReading = { rssi: -71, rsrq: -9, rsrp: -100, snr: 19 };

const modem = (over: Partial<ModemInfo> = {}): ModemInfo => ({
  path: "/m/0", manufacturer: "Quectel", model: "EC25", state: "connected",
  failedReason: null, powerState: "on", accessTechnology: "lte",
  operatorName: "Dark Star", operatorCode: "310410", registration: "home",
  imei: "357014749990990",
  ports: { control: "cdc-wdm0", net: "wwan0" },
  portList: ["cdc-wdm0 (mbim)", "wwan0 (net)"], bearerPaths: ["/b/1"], ...over,
});

const bearer = (over: Partial<BearerInfo> = {}): BearerInfo => ({
  path: "/b/1", connected: true, interface: "wwan0", apn: "ereseller",
  ipType: "ipv4v6", address: "10.31.95.33", gateway: "10.31.95.34", mtu: 1430, ...over,
});

const enabled = {
  ...DEFAULT_CONFIG,
  network: { ...DEFAULT_CONFIG.network, modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" } },
};

describe("modemState", () => {
  it("says absent when there is no modem", () => {
    const s = modemState(enabled, null, null, NO_SIGNAL);
    expect(s.mode).toBe("absent");
    expect(s.summary).toBe("No modem found");
  });

  it("says a modem was found and is not configured", () => {
    // A stick plugged into a board with nothing in config.yaml. Not a fault,
    // and not something to hide: it is the one thing the operator needs told.
    const s = modemState(DEFAULT_CONFIG, modem(), null, NO_SIGNAL);
    expect(s.mode).toBe("unconfigured");
    expect(s.summary).toBe("Modem found — not configured");
  });

  it("reports the operator, the technology and the address when connected", () => {
    const s = modemState(enabled, modem(), bearer(), SIGNAL);
    expect(s.mode).toBe("connected");
    expect(s.operator).toBe("Dark Star");
    expect(s.technology).toBe("lte");
    expect(s.apn).toBe("ereseller");
    expect(s.address).toBe("10.31.95.33");
    expect(s.mtu).toBe(1430);
    expect(s.signal).toEqual(SIGNAL);
  });

  it("reports the APN of the connected bearer, not the one configured", () => {
    // The two can disagree while an apply is in flight, and what is true is
    // what the link is actually using.
    const s = modemState(enabled, modem(), bearer({ apn: "something-else" }), SIGNAL);
    expect(s.apn).toBe("something-else");
  });

  it("says waiting when the modem is registered but no bearer is up", () => {
    const s = modemState(enabled, modem({ state: "registered" }), null, NO_SIGNAL);
    expect(s.mode).toBe("waiting");
  });

  it("says joining while the modem is still searching", () => {
    const s = modemState(enabled, modem({ state: "searching", registration: "idle" }), null, NO_SIGNAL);
    expect(s.mode).toBe("joining");
  });

  it("carries the failure reason when the modem failed", () => {
    const s = modemState(enabled, modem({ state: "failed", failedReason: "sim-missing" }), null, NO_SIGNAL);
    expect(s.mode).toBe("failed");
    expect(s.summary).toContain("sim-missing");
  });

  it("says an appliance cannot report signal, rather than reporting none", () => {
    // R-CEL-11: the absence is a property of that kind of modem, not data
    // that failed to arrive, and a page must be able to tell them apart.
    const appliance = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, mode: "appliance" as const, interface: "usb0" },
      },
    };
    const s = modemState(appliance, null, null, NO_SIGNAL);
    expect(s.reportsSignal).toBe(false);
    expect(s.mode).not.toBe("absent");
  });
});
