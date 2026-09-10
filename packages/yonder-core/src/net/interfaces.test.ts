// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { defaultRouteDevice, interfaceSnapshot, parseRoutes, readInterfaces } from "./interfaces.js";
import { networkState } from "./state.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
describe("current interface observations", () => {
  const nm = [
    { device: "eth0", type: "ethernet", connection: "yonder-eth", state: "connected" },
    { device: "wlan0", type: "wifi", connection: "yonder-wifi", state: "connected" },
  ];
  it("shows Ethernet and IPv6 and selects the observed metric, independent of interface order", () => {
    const routes = parseRoutes([{ dst: "default", dev: "eth0", metric: 800 }, { dst: "default", dev: "wwan0", metric: 700, gateway: "10.0.0.1" }], 4);
    const snapshot = interfaceSnapshot([
      { ifname: "eth0", flags: ["UP", "LOWER_UP"], mtu: 1500, addr_info: [{ local: "192.168.1.2", prefixlen: 24, scope: "global" }] },
      { ifname: "wlan0", flags: ["UP", "LOWER_UP"], addr_info: [{ local: "2001:db8::1", prefixlen: 64, scope: "global" }] },
      { ifname: "lo", addr_info: [] },
    ], routes, nm, 123);
    expect(snapshot.interfaces).toHaveLength(2);
    expect(snapshot.interfaces[0]!.addresses[0]!.address).toBe("192.168.1.2");
    expect(snapshot.interfaces[1]!.addresses[0]!.family).toBe(6);
    expect(snapshot.defaultRoutes[0]!.device).toBe("wwan0");
    expect(snapshot.sampledAt).toBe(123);
  });
  it("drops old DHCP addresses when a link loses them and does not invent an AP address", () => {
    const observed = interfaceSnapshot([{ ifname: "wlan0", operstate: "DOWN", flags: ["NO-CARRIER"], addr_info: [] }], [], nm, 200);
    expect(observed.interfaces[0]!.addresses).toEqual([]);
    expect(observed.interfaces[0]!.carrier).toBe(false);
    expect(networkState(DEFAULT_CONFIG, [{ ...nm[1]!, connection: "yonder-ap" }], []).address).toBeNull();
  });
  it("does not display tentative/expired IPv6 addresses", () => {
    const snapshot = interfaceSnapshot([{ ifname: "wlan0", addr_info: [
      { local: "2001:db8::1", prefixlen: 64, tentative: true },
      { local: "2001:db8::2", prefixlen: 64, valid_life_time: 0 },
    ] }], [], nm, 0);
    expect(snapshot.interfaces[0]!.addresses).toEqual([]);
  });
  it("fails the observation on a kernel read error, never serves a cached snapshot", async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: "[]", stderr: "" }));
    await expect(readInterfaces(runner, async () => nm)).rejects.toThrow();
    await expect(defaultRouteDevice(runner)).rejects.toThrow();
    expect(await defaultRouteDevice(async () => ({ code: 0, stdout: "[]", stderr: "" }))).toBeNull();
  });
});
