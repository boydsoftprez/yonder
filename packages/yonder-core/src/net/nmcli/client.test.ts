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

  const AP_SPEC = {
    type: "wifi",
    ifname: "wlan0",
    settings: [["802-11-wireless.ssid", "yonder"]],
  };

  it("adds a connection when it does not exist", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok(""),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", AP_SPEC);
    const add = calls.find((c) => c[1] === "connection" && c[2] === "add");
    // `type` and `ifname` are common options: valid here, and only here.
    expect(add).toEqual([
      "nmcli", "connection", "add", "con-name", "yonder-ap",
      "type", "wifi", "ifname", "wlan0",
      "802-11-wireless.ssid", "yonder",
    ]);
  });

  /**
   * The second render, and every render after it, on a real board. `modify`
   * takes `[+|-]setting.property value` and nothing else — sending it the
   * `type` and `ifname` common options that belong to `add` made every render
   * after the first fail, which rolled the apply back and left renderCurrent()
   * failing on every boot after the first.
   */
  it("modifies a connection that already exists rather than adding a duplicate", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", AP_SPEC);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    const mod = calls.find((c) => c[2] === "modify");
    expect(mod).toEqual([
      "nmcli", "connection", "modify", "yonder-ap",
      "connection.interface-name", "wlan0",
      "802-11-wireless.ssid", "yonder",
    ]);
  });

  it("never sends an add-only option to modify", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", AP_SPEC);
    const mod = calls.find((c) => c[2] === "modify")!;
    // A connection's type cannot be changed at all, so it is not offered.
    expect(mod).not.toContain("type");
    expect(mod).not.toContain("ifname");
  });

  it("throws NmcliError with the redacted argv on a non-zero exit", async () => {
    const { run } = fake({
      "nmcli connection up yonder-ap": { code: 4, stdout: "", stderr: "Error: activation failed" },
    });
    const client = new NmcliClient(run);
    await expect(client.up("yonder-ap")).rejects.toThrow(NmcliError);
    await expect(client.up("yonder-ap")).rejects.toThrow(/activation failed/);
  });

  /**
   * NmcliError travels: into the journal, into an apply's failure, and into
   * whatever the daemon does with a 500. Every field of it has to be safe on
   * its own — inspecting only the log lines left `this.argv = redactArgv(argv)`
   * reducible to `this.argv = argv` with the whole suite green.
   */
  it("carries no secret in any field of the error it throws", async () => {
    const psk = "hunter2hunter2";
    const { run } = fake({
      // nmcli quotes the value it rejected back at you.
      [`nmcli connection modify yonder-ap connection.interface-name wlan0 802-11-wireless-security.psk ${psk}`]:
        { code: 1, stdout: "", stderr: `Error: invalid property: '${psk}' is not a valid psk.` },
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    const failure = await new NmcliClient(run).addOrModify("yonder-ap", {
      type: "wifi",
      ifname: "wlan0",
      settings: [["802-11-wireless-security.psk", psk]],
    }).then(() => null, (e: unknown) => e as NmcliError);

    expect(failure).toBeInstanceOf(NmcliError);
    expect(failure!.argv.join(" ")).not.toContain(psk);
    expect(failure!.argv).toContain("<redacted>");
    expect(failure!.stderr).not.toContain(psk);
    expect(failure!.message).not.toContain(psk);
    expect(JSON.stringify(failure)).not.toContain(psk);
  });

  it("keeps secrets out of the log and out of the error", async () => {
    const lines: string[] = [];
    const { run } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run, (l) => lines.push(l)).addOrModify("yonder-ap", {
      type: "wifi",
      ifname: "wlan0",
      settings: [["wifi-sec.psk", "hunter2hunter2"]],
    });
    expect(lines.join("\n")).not.toContain("hunter2hunter2");
    expect(lines.join("\n")).toContain("<redacted>");
  });

  /**
   * The probe behind the access-point fallback. `device show` takes
   * section-qualified fields — `GENERAL.DEVICE`, not the bare `DEVICE` that
   * belongs to `device status` — and emits a stream of `FIELD:value` lines
   * rather than one record per device.
   */
  it("asks device show for section-qualified fields", async () => {
    const { run, calls } = fake({});
    await new NmcliClient(run).activeIpv4();
    expect(calls[0]).toEqual([
      "nmcli", "-t", "-f", "GENERAL.DEVICE,IP4.ADDRESS", "device", "show",
    ]);
  });

  it("reports active IPv4 addresses per device", async () => {
    const { run } = fake({
      "nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show": ok(
        "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nGENERAL.DEVICE:wlan0\n",
      ),
    });
    expect(await new NmcliClient(run).activeIpv4()).toEqual([
      { device: "eth0", address: "192.168.1.50/24" },
    ]);
  });

  it("reports each address separately when a device holds several", async () => {
    const { run } = fake({
      "nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show": ok(
        "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nIP4.ADDRESS[2]:10.42.0.1/24\n",
      ),
    });
    expect(await new NmcliClient(run).activeIpv4()).toEqual([
      { device: "eth0", address: "192.168.1.50/24" },
      { device: "eth0", address: "10.42.0.1/24" },
    ]);
  });

  it("reports nothing when no device holds an address", async () => {
    const { run } = fake({
      "nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show":
        ok("GENERAL.DEVICE:eth0\nGENERAL.DEVICE:wlan0\n"),
    });
    expect(await new NmcliClient(run).activeIpv4()).toEqual([]);
  });
});
