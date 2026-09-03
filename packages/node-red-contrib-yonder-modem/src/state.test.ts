// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageFor } from "./state.js";
import type { ModemState, ReachState } from "yonder-core";

const MODEM: ModemState = {
  mode: "connected", summary: "Connected to Dark Star",
  operator: "Dark Star", technology: "lte", registration: "home",
  apn: "ereseller", address: "10.16.166.223", mtu: 1430,
  signal: { rssi: -71, rsrq: -12, rsrp: -99, snr: 16 },
  ports: ["cdc-wdm0 (mbim)", "wwan0 (net)"], reportsSignal: true,
};

const REACH: ReachState = {
  inUse: "ethernet", carrying: true,
  paths: [
    { path: "ethernet", device: "eth0", standing: "in-use", since: null, detail: "Carrying traffic" },
    { path: "modem", device: "wwan0", standing: "standing-by", since: null, detail: "Ready — traffic is not going out over cellular" },
  ],
};

describe("messageFor", () => {
  it("carries the four signal numbers with their units", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.signal.strength).toBe("-99 dBm");
    expect(p.signal.quality).toBe("16 dB");
    expect(p.signal.rssi).toBe("-71 dBm");
    expect(p.signal.rsrq).toBe("-12 dB");
  });

  it("reports the raw numbers too, because a gauge needs a number", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.gauges.strength).toBe(-99);
    expect(p.gauges.quality).toBe(16);
  });

  it("says an appliance modem cannot report signal, rather than showing none", () => {
    // R-CEL-11. Four dashes read as a fault; "this kind of modem does not
    // report it" does not.
    const p = messageFor({ ...MODEM, reportsSignal: false }, REACH).payload;
    expect(p.reportsSignal).toBe(false);
  });

  it("names every path in the operator's order for the Way out panel", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.paths.map((x) => x.name)).toEqual(["Ethernet", "Cellular"]);
    expect(p.paths[1].detail).toBe("Ready — traffic is not going out over cellular");
  });

  it("gives Status one word for how the device is reachable", () => {
    expect(messageFor(MODEM, REACH).payload.reachableBy).toBe("ETHERNET");
    expect(messageFor(MODEM, { ...REACH, inUse: "modem" }).payload.reachableBy).toBe("CELLULAR");
  });

  it("says so when nothing is carrying traffic at all", () => {
    const p = messageFor(MODEM, { ...REACH, inUse: null, carrying: false }).payload;
    expect(p.reachableBy).toBe("NOTHING");
  });
});
