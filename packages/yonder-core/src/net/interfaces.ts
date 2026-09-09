// SPDX-License-Identifier: GPL-3.0-or-later
import { isIP } from "node:net";
import type { CommandRunner } from "./runner.js";
import type { DeviceInfo } from "./nmcli/client.js";

export interface InterfaceAddress { address: string; prefix: number; family: 4 | 6; scope: string }
export interface InterfaceRoute {
  family: 4 | 6; destination: string; device: string; gateway: string | null;
  source: string | null; metric: number; table: string;
}
export interface InterfaceState {
  device: string; kind: "ethernet" | "wifi" | "modem" | "zerotier" | "other";
  state: string; carrier: boolean | null; mtu: number | null;
  connection: string | null; addresses: InterfaceAddress[];
  defaultRoutes: InterfaceRoute[];
}
export interface InterfaceSnapshot {
  sampledAt: number; interfaces: InterfaceState[]; routes: InterfaceRoute[];
  defaultRoutes: InterfaceRoute[];
}
type RecordValue = Record<string, unknown>;
function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new Error("Invalid interface observation");
  return value.filter((v): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v));
}
export function parseRoutes(value: unknown, family: 4 | 6): InterfaceRoute[] {
  return records(value).filter(r => typeof r.dev === "string" && typeof r.dst === "string"
    && (!r.type || r.type === "unicast")).map(r => ({
    family, destination: String(r.dst), device: String(r.dev),
    gateway: typeof r.gateway === "string" ? r.gateway : null,
    source: typeof r.prefsrc === "string" ? r.prefsrc : null,
    metric: typeof r.metric === "number" ? r.metric : 0,
    table: typeof r.table === "string" || typeof r.table === "number" ? String(r.table) : "main",
  }));
}
/** Kernel observations, never saved DHCP addresses or inferred priority (R-NET-17). */
export function interfaceSnapshot(
  addresses: unknown, routes: InterfaceRoute[], devices: DeviceInfo[], sampledAt: number,
): InterfaceSnapshot {
  const interfaces = records(addresses).filter(r => r.ifname !== "lo" && typeof r.ifname === "string").map(r => {
    const device = String(r.ifname);
    const nm = devices.find(d => d.device === device);
    const flags = Array.isArray(r.flags) ? r.flags : [];
    const kind: InterfaceState["kind"] = device.startsWith("zt") ? "zerotier"
      : nm?.type === "wifi" ? "wifi"
      : nm?.type === "gsm" || /^(wwan|ppp|rmnet)/.test(device) ? "modem"
      : nm?.type === "ethernet" ? "ethernet" : "other";
    const held = records(r.addr_info ?? []).flatMap(a => {
      if (typeof a.local !== "string" || !isIP(a.local) || typeof a.prefixlen !== "number"
        || a.tentative === true || a.dadfailed === true || a.valid_life_time === 0) return [];
      return [{ address: a.local, prefix: a.prefixlen, family: isIP(a.local) as 4 | 6,
        scope: typeof a.scope === "string" ? a.scope : "unknown" }];
    });
    return {
      device, kind, state: nm?.state ?? String(r.operstate ?? "unknown").toLowerCase(),
      carrier: flags.includes("LOWER_UP") ? true : r.operstate === "DOWN" || flags.includes("NO-CARRIER") ? false : null,
      mtu: typeof r.mtu === "number" ? r.mtu : null,
      connection: nm?.connection || null, addresses: held,
      defaultRoutes: routes.filter(route => route.device === device && route.destination === "default"),
    };
  });
  // Main-table defaults are observations, not a claim about policy rules or a bound VPN socket.
  const defaultRoutes = ([4, 6] as const).flatMap(family => {
    const candidates = routes.filter(r => r.family === family && r.destination === "default" && r.table === "main");
    const metric = Math.min(...candidates.map(r => r.metric));
    return candidates.filter(r => r.metric === metric);
  });
  return { sampledAt, interfaces, routes, defaultRoutes };
}
export async function readInterfaces(runner: CommandRunner, devices: () => Promise<DeviceInfo[]>, now = Date.now): Promise<InterfaceSnapshot> {
  const [addr, v4, v6, nm] = await Promise.all([
    runner(["ip", "-j", "address", "show"]),
    runner(["ip", "-j", "-4", "route", "show", "table", "main"]),
    runner(["ip", "-j", "-6", "route", "show", "table", "main"]), devices(),
  ]);
  if ([addr, v4, v6].some(r => r.code !== 0)) throw new Error("Could not read current kernel interfaces");
  return interfaceSnapshot(JSON.parse(addr.stdout), [
    ...parseRoutes(JSON.parse(v4.stdout), 4), ...parseRoutes(JSON.parse(v6.stdout), 6),
  ], nm, now());
}

/** Main-table IPv4 default used by the existing IPv4 reachability monitor. */
export async function defaultRouteDevice(runner: CommandRunner): Promise<string | null> {
  const result = await runner(["ip", "-j", "-4", "route", "show", "default"]);
  if (result.code !== 0) throw new Error("Could not observe default route");
  const routes = parseRoutes(JSON.parse(result.stdout.trim() || "[]"), 4).filter(r => r.destination === "default");
  routes.sort((a, b) => a.metric - b.metric);
  return routes[0]?.device ?? null;
}
