// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { NmcliClient, NmcliError } from "./client.js";
import type { CommandRunner, CommandResult } from "../runner.js";

function fake(responses: Record<string, CommandResult>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = argv.join(" ");
    const hit = responses[key];
    if (hit === undefined) return { code: 0, stdout: "", stderr: "" };
    return hit;
  };
  return { run, calls };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("NmcliClient", () => {
  it("lists devices with pinned fields", async () => {
    const { run, calls } = fake({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok("eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\n"),
    });
    const devices = await new NmcliClient(run).devices();
    expect(devices).toEqual([
      { device: "eth0", type: "ethernet", state: "connected", connection: "Wired connection 1" },
      { device: "wlan0", type: "wifi", state: "disconnected", connection: "" },
    ]);
    expect(calls[0]).toEqual(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
  });

  it("lists connections", async () => {
    const { run } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    expect(await new NmcliClient(run).connections()).toEqual([
      { name: "yonder-ap", uuid: "u-1", type: "802-11-wireless", device: "" },
    ]);
  });

  it("scans and keeps an SSID containing a colon intact", async () => {
    const { run, calls } = fake({
      "nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes":
        ok("Guest\\:Wifi:42:WPA2\nHome:78:WPA2\n"),
    });
    const aps = await new NmcliClient(run).scan("wlan0");
    expect(aps[0]).toEqual({ ssid: "Guest:Wifi", signal: 42, security: "WPA2" });
    expect(calls[0]).toContain("--rescan");
  });

  it("drops hidden (empty-SSID) networks from a scan", async () => {
    const { run } = fake({
      "nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes":
        ok(":31:--\nHome:78:WPA2\n"),
    });
    expect(await new NmcliClient(run).scan("wlan0")).toEqual([
      { ssid: "Home", signal: 78, security: "WPA2" },
    ]);
  });

  it("adds a connection when it does not exist", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok(""),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", [
      ["type", "wifi"],
      ["ifname", "wlan0"],
      ["ssid", "yonder"],
    ]);
    const add = calls.find((c) => c[1] === "connection" && c[2] === "add");
    expect(add).toBeDefined();
    expect(add).toContain("con-name");
    expect(add).toContain("yonder-ap");
  });

  it("modifies a connection that already exists rather than adding a duplicate", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", [["ssid", "yonder"]]);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    const mod = calls.find((c) => c[2] === "modify");
    expect(mod).toEqual(["nmcli", "connection", "modify", "yonder-ap", "ssid", "yonder"]);
  });

  it("throws NmcliError with the redacted argv on a non-zero exit", async () => {
    const { run } = fake({
      "nmcli connection up yonder-ap": { code: 4, stdout: "", stderr: "Error: activation failed" },
    });
    const client = new NmcliClient(run);
    await expect(client.up("yonder-ap")).rejects.toThrow(NmcliError);
    await expect(client.up("yonder-ap")).rejects.toThrow(/activation failed/);
  });

  it("keeps secrets out of the log and out of the error", async () => {
    const lines: string[] = [];
    const { run } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run, (l) => lines.push(l)).addOrModify("yonder-ap", [
      ["wifi-sec.psk", "hunter2hunter2"],
    ]);
    expect(lines.join("\n")).not.toContain("hunter2hunter2");
    expect(lines.join("\n")).toContain("<redacted>");
  });

  it("reports active IPv4 addresses per device", async () => {
    const { run } = fake({
      "nmcli -t -f DEVICE,IP4.ADDRESS device show":
        ok("eth0:192.168.1.50/24\nwlan0:\n"),
    });
    expect(await new NmcliClient(run).activeIpv4()).toEqual([
      { device: "eth0", address: "192.168.1.50/24" },
    ]);
  });
});
