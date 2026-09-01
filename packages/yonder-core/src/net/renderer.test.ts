// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRenderer } from "./renderer.js";
import { NmcliClient } from "./nmcli/client.js";
import { SecretStore } from "../secrets/store.js";
import { AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, DEFAULT_AP_PASSPHRASE } from "./profiles.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "./runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-rend-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

const DEVICES = "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n";

/** Deliberately not the published default, so the two can be told apart. */
const OPERATOR_PSK = "an-operator-chose-this";

interface HarnessOptions {
  /** `nmcli device status` output. */
  devices?: string;
  /** Connection names NetworkManager already holds when the render starts. */
  connections?: string[];
  /** Replaces the result of `device status`, to make it fail. */
  deviceStatus?: CommandResult;
}

/**
 * A fake nmcli that **remembers what it was told**.
 *
 * A stateless fake replays the same `connection show` output however many
 * times the renderer asks, so a delete has no consequence and a second render
 * cannot tell that the first one happened. That is what let the ownership
 * rule be half-gated: `OWNED.has(name) && !wanted.has(name)` could be reduced
 * to `OWNED.has(name)` — delete everything we own, on every render, and
 * immediately recreate it — with every test still green. Here an add adds and
 * a delete deletes, so a second identical render is a real assertion.
 */
function harness(opts: HarnessOptions = {}) {
  const calls: string[][] = [];
  const names = new Set(opts.connections ?? []);
  const deviceStatus = opts.deviceStatus ?? ok(opts.devices ?? DEVICES);

  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = argv.join(" ");
    if (key === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") return deviceStatus;
    if (key === "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show") {
      return ok([...names].map((n) => `${n}:u-${n}:802-11-wireless:\n`).join(""));
    }
    if (argv[1] === "connection") {
      // add is ["nmcli","connection","add","con-name",<name>,…]; the rest put
      // the name at argv[3].
      if (argv[2] === "add") names.add(argv[4]);
      if (argv[2] === "delete") names.delete(argv[3]);
    }
    return ok();
  };

  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  secrets.ensureValue("ap_psk", OPERATOR_PSK);
  const renderer = new NetworkRenderer({
    client: new NmcliClient(run),
    secrets,
    dnsmasqPath: join(dir, "yonder.conf"),
  });
  return { renderer, calls, secrets, names };
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
    const { renderer, calls } = harness({ connections: [CLIENT_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", CLIENT_CONNECTION)).toBeDefined();
  });

  it("never deletes a connection it does not own", async () => {
    const { renderer, calls } = harness({ connections: ["Wired connection 1"] });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });

  /**
   * The other half of the ownership rule. "Only what we own" was already a
   * gate; "only what we no longer want" was not, because a stateless fake
   * could not tell one render from the next. A second identical render must
   * be a no-op — anything else is the renderer tearing down the access point
   * it just built, on every apply, every confirm and every boot.
   */
  it("deletes nothing it still wants, however many times it renders", async () => {
    const { renderer, calls, names } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.filter((c) => c[2] === "delete")).toEqual([]);
    expect([...names].sort()).toEqual([AP_CONNECTION, ETHERNET_CONNECTION].sort());
  });

  it("removes an unwanted connection once, and does not look for it again", async () => {
    const { renderer, calls, names } = harness({
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION],
    });
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.filter((c) => c[2] === "delete" && c[3] === CLIENT_CONNECTION)).toHaveLength(1);
    expect(names.has(CLIENT_CONNECTION)).toBe(false);
  });

  it("brings the access point up when it is enabled", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeDefined();
  });

  /**
   * The case Step 6 of the hardware procedure depends on: a configuration
   * with the access point disabled, on a board where it is not currently up,
   * must leave it down — otherwise the start-up render raises it and the
   * fallback watchdog is never the thing that brought it back.
   */
  it("does not raise a disabled access point that is not already up", async () => {
    const { renderer, calls } = harness();
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeUndefined();
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeUndefined();
  });

  /**
   * The passphrase reaching nmcli is the one in the secret store, which is
   * where an operator's changed value lives. A built-in default hardcoded
   * here would lock that operator out of their own device on the next render.
   */
  it("sends the passphrase from the secret store, not a value of its own", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    const ap = calls.find((c) => c[2] === "add" && c[4] === AP_CONNECTION);
    expect(ap).toBeDefined();
    expect(ap).toContain(OPERATOR_PSK);
    expect(ap).not.toContain(DEFAULT_AP_PASSPHRASE);
  });

  it("takes the access point down when config disables it", async () => {
    const { renderer, calls } = harness({
      devices: `eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:${AP_CONNECTION}\n`,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION],
    });
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeDefined();
  });

  it("skips wifi entirely on a board with no wifi device", async () => {
    const { renderer, calls } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n",
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("rejects when nmcli fails, so the apply engine rolls back", async () => {
    const { renderer } = harness({
      deviceStatus: { code: 1, stdout: "", stderr: "NetworkManager is not running" },
    });
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not running/);
  });

  it("is idempotent: a second render of the same config adds nothing", async () => {
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
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
