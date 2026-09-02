// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NmcliClient } from "./nmcli/client.js";
import type { CommandResult, CommandRunner } from "./runner.js";
import { scanForNetworks, ssidOptions } from "./scan.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "nmcli", "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** An nmcli that answers each subcommand with whatever the test hands it. */
function stubNmcli(answers: Record<string, Partial<CommandResult>>): {
  runner: CommandRunner; calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: (argv) => {
      calls.push(argv);
      const key = argv.slice(1).find((a) => a in answers) ?? argv.join(" ");
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...(answers[key] ?? {}) });
    },
  };
}

/** `device status` says wlan0 exists; `device wifi list` answers with `stdout`. */
function clientReturning(stdout: string, deviceStatus = fixture("device-status.txt")): {
  client: NmcliClient; calls: string[][];
} {
  const { runner, calls } = stubNmcli({
    status: { stdout: deviceStatus },
    list: { stdout },
  });
  return { client: new NmcliClient(runner), calls };
}

describe("scanForNetworks", () => {
  it("scans the board's wifi radio and reports what is in the air", async () => {
    const { client, calls } = clientReturning(fixture("wifi-scan.txt"));
    const result = await scanForNetworks(client);
    expect(result.interface).toBe("wlan0");
    expect(result.networks).toEqual([
      { ssid: "HomeNetwork", signal: 78, security: "WPA2" },
      { ssid: "Guest:Wifi", signal: 42, security: "WPA2" },
    ]);
    // The interface comes from the device list, not from a constant.
    expect(calls.some((c) => c.includes("ifname") && c.includes("wlan0"))).toBe(true);
  });

  /**
   * `device wifi list` is one row per BSS. A house with a mesh reports the
   * same SSID three times at different strengths, and a form listing all of
   * them asks an operator to choose between identical entries.
   */
  it("folds a mesh into one row, keeping the strongest sighting", async () => {
    const { client } = clientReturning([
      "Mesh:41:WPA2",
      "Mesh:88:WPA2",
      "Mesh:63:WPA2",
      "Other:50:WPA2",
      "",
    ].join("\n"));
    const result = await scanForNetworks(client);
    expect(result.networks).toEqual([
      { ssid: "Mesh", signal: 88, security: "WPA2" },
      { ssid: "Other", signal: 50, security: "WPA2" },
    ]);
  });

  it("orders strongest first, and breaks a tie by name so the list does not reshuffle", async () => {
    const { client } = clientReturning([
      "beta:50:WPA2",
      "alpha:50:WPA2",
      "gamma:90:WPA2",
      "",
    ].join("\n"));
    expect((await scanForNetworks(client)).networks.map((n) => n.ssid))
      .toEqual(["gamma", "alpha", "beta"]);
  });

  /**
   * A hidden network broadcasts an empty SSID. `NmcliClient.scan` drops those
   * already; asserted here because a blank row in a list of networks to join
   * is a row that cannot be joined.
   */
  it("does not list a network with no name", async () => {
    const { client } = clientReturning(fixture("wifi-scan.txt"));
    expect((await scanForNetworks(client)).networks.map((n) => n.ssid)).not.toContain("");
  });

  it("reports a board with no radio as having none, rather than failing", async () => {
    const { client, calls } = clientReturning("", "lo:loopback:connected:lo\neth0:ethernet:connected:yonder-eth\n");
    expect(await scanForNetworks(client)).toEqual({ interface: null, networks: [] });
    // And it does not go on to scan an interface it does not have.
    expect(calls.some((c) => c.includes("list"))).toBe(false);
  });

  /**
   * The list is public by construction — anything with a radio can see it —
   * and the shape is what makes that structural rather than a promise.
   */
  it("carries no credential of any kind", async () => {
    const { client } = clientReturning(fixture("wifi-scan.txt"));
    const result = await scanForNetworks(client);
    for (const network of result.networks) {
      expect(Object.keys(network).sort()).toEqual(["security", "signal", "ssid"]);
    }
    expect(JSON.stringify(result)).not.toMatch(/psk|password|passphrase/i);
  });

  /**
   * A scan that did not run is not a neighbourhood with no Wi-Fi in it. The
   * failure travels, and the daemon's catch-all turns it into a generic 500
   * with the detail in the journal rather than nmcli's stderr in a body.
   */
  it("lets a refused scan fail rather than reporting an empty air", async () => {
    const { runner } = stubNmcli({
      status: { stdout: fixture("device-status.txt") },
      list: { code: 2, stderr: "Error: Device 'wlan0' not found." },
    });
    await expect(scanForNetworks(new NmcliClient(runner))).rejects.toThrow(/nmcli exited 2/);
  });
});

/**
 * The join form offers what the scan found.
 *
 * It used to be a free-text SSID box beside a table of networks: the scan told
 * you the name and then you typed it back in. Reported from a phone on the
 * access point — "I scan, the list populates, I click a network and nothing
 * happens" — and it is the feature defeating itself, because the reason to
 * scan is not knowing the name. On a phone a mistyped SSID costs five minutes
 * of no access point while the apply fails and rolls back.
 */
describe("ssidOptions", () => {
  const scan = {
    interface: "wlan0",
    networks: [
      { ssid: "Field", signal: 74, security: "WPA2" },
      { ssid: "Barn", signal: 31, security: "WPA2" },
    ],
  };

  it("offers one option per network, in the order the scan gave", () => {
    const opts = ssidOptions(scan);
    expect(opts.map((o) => o.value)).toEqual(["Field", "Barn"]);
  });

  it("submits the SSID alone, whatever the label says", () => {
    // The label carries the signal so two networks with one name can be told
    // apart. What is submitted has to be the name and nothing else.
    for (const o of ssidOptions(scan)) {
      expect(scan.networks.map((n) => n.ssid)).toContain(o.value);
      expect(o.label).toContain(o.value);
    }
  });

  it("drops networks with no name rather than offering a blank row", () => {
    const opts = ssidOptions({ interface: "wlan0", networks: [
      { ssid: "", signal: 50, security: "WPA2" },
      { ssid: "Real", signal: 50, security: "WPA2" },
    ] });
    expect(opts.map((o) => o.value)).toEqual(["Real"]);
  });

  it("survives a board with no radio, and a scan that never answered", () => {
    expect(ssidOptions({ interface: null, networks: [] })).toEqual([]);
    expect(ssidOptions(null)).toEqual([]);
    expect(ssidOptions(undefined)).toEqual([]);
  });
});
