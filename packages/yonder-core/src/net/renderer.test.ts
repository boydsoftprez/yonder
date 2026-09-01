// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRenderer } from "./renderer.js";
import { NmcliClient } from "./nmcli/client.js";
import { SecretStore } from "../secrets/store.js";
import { AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION } from "./profiles.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "./runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-rend-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

const DEVICES = "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n";

function harness(overrides: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const responses: Record<string, CommandResult> = {
    "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status": ok(DEVICES),
    "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok(""),
    ...overrides,
  };
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return responses[argv.join(" ")] ?? ok();
  };
  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  secrets.ensure("ap_psk", "psk");
  const renderer = new NetworkRenderer({
    client: new NmcliClient(run),
    secrets,
    dnsmasqPath: join(dir, "yonder.conf"),
  });
  return { renderer, calls, secrets };
}

const argvOf = (calls: string[][], verb: string, name: string) =>
  calls.find((c) => c[1] === "connection" && c[2] === verb && c[3] === name);

describe("NetworkRenderer", () => {
  it("creates the access point and the ethernet profile", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    // The original brief assertion here (`argvOf(calls, "add", undefined as never)`)
    // relies on a connection name landing at argv[3] for the "add" verb. It
    // never does: NmcliClient.addOrModify's add path is
    // ["nmcli", "connection", "add", "con-name", name, ...flat], so argv[3]
    // is always the literal "con-name" and argvOf(..., "add", anything)
    // always misses, making that half of the `??` dead code. Simplified to
    // what it clearly intends: both connection names were issued to nmcli.
    expect(calls.some((c) => c.includes(AP_CONNECTION)) && calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(true);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("writes the DHCP drop-in", async () => {
    const { renderer } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(existsSync(join(dir, "yonder.conf"))).toBe(true);
    expect(readFileSync(join(dir, "yonder.conf"), "utf8")).toContain("dhcp-range=");
  });

  it("does not create a client profile when no ssid is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(CLIENT_CONNECTION))).toBe(false);
  });

  it("creates a client profile when an ssid is configured", async () => {
    const { renderer, calls, secrets } = harness();
    secrets.ensure("wifi_psk", "psk");
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    await renderer.render(c);
    expect(calls.some((c2) => c2.includes(CLIENT_CONNECTION))).toBe(true);
  });

  it("removes a client profile that config no longer asks for", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok(`${CLIENT_CONNECTION}:u-2:802-11-wireless:wlan0\n`),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", CLIENT_CONNECTION)).toBeDefined();
  });

  it("never deletes a connection it does not own", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("Wired connection 1:u-9:802-3-ethernet:eth0\n"),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });

  it("brings the access point up when it is enabled", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeDefined();
  });

  it("takes the access point down when config disables it", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok(`eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:${AP_CONNECTION}\n`),
    });
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeDefined();
  });

  it("skips wifi entirely on a board with no wifi device", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok("eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n"),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("rejects when nmcli fails, so the apply engine rolls back", async () => {
    const { renderer } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        { code: 1, stdout: "", stderr: "NetworkManager is not running" },
    });
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not running/);
  });

  it("is idempotent: a second render of the same config adds nothing", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok(`${AP_CONNECTION}:u-1:802-11-wireless:\n${ETHERNET_CONNECTION}:u-3:802-3-ethernet:eth0\n`),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(calls.some((c) => c[2] === "modify")).toBe(true);
  });

  it("keeps the pre-shared key out of its log", async () => {
    const lines: string[] = [];
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push(argv);
      if (argv.join(" ") === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") return ok(DEVICES);
      return ok();
    };
    const secrets = new SecretStore(join(dir, "s.yaml"));
    const psk = secrets.ensure("ap_psk", "psk").value;
    const renderer = new NetworkRenderer({
      client: new NmcliClient(run, (l) => lines.push(l)),
      secrets,
      dnsmasqPath: join(dir, "y.conf"),
      log: (l) => lines.push(l),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(lines.join("\n")).not.toContain(psk);
  });
});
