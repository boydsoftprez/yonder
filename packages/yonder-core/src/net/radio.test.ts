// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  enableWifiRadio, radioWanted, RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON,
} from "./radio.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "./runner.js";

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

/** Records every argv and answers each one from `answers`, or 0 by default. */
function fake(answers: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return answers[argv.join(" ")] ?? ok;
  };
  return { run, calls };
}

/** The configuration with the access point, the client and the fallback all off. */
function noWifi(): Config {
  const c: Config = structuredClone(DEFAULT_CONFIG);
  c.network.ap.enabled = false;
  c.network.ap.fallback.enabled = false;
  c.network.client.ssid = null;
  return c;
}

describe("radioWanted", () => {
  it("is true for the shipped default, which raises an access point", () => {
    expect(radioWanted(DEFAULT_CONFIG)).toBe(true);
  });

  it("is true for a configuration that only joins a network as a client", () => {
    const c = noWifi();
    c.network.client.ssid = "HomeNetwork";
    expect(radioWanted(c)).toBe(true);
  });

  it("treats an empty client ssid as no client, the same as null", () => {
    const c = noWifi();
    c.network.client.ssid = "";
    expect(radioWanted(c)).toBe(false);
  });

  /**
   * R-NET-07: the fallback raises the access point *regardless of
   * configuration*, and `nmcli connection up yonder-ap` cannot do that on a
   * radio the kernel has blocked. So a configuration that keeps the fallback
   * still needs a usable radio, whatever it says about the access point.
   */
  it("is true when only the access-point fallback still wants a radio", () => {
    const c = noWifi();
    c.network.ap.fallback.enabled = true;
    expect(radioWanted(c)).toBe(true);
  });

  it("is false only when nothing at all wants wifi, fallback included", () => {
    expect(radioWanted(noWifi())).toBe(false);
  });
});

describe("enableWifiRadio", () => {
  /**
   * Two locks, cleared in this order. They are independent — the kernel's
   * rfkill soft block and NetworkManager's own persistent `WirelessEnabled`
   * flag — and a board with either one set reports `wlan0` as `unavailable`.
   * rfkill first, because NetworkManager re-reads the killswitch when its own
   * flag is turned on.
   */
  it("clears the kernel block and then NetworkManager's own flag", async () => {
    const { run, calls } = fake();
    await enableWifiRadio(run);
    expect(calls).toEqual([RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON]);
  });

  it("issues the same two commands however many times it is called", async () => {
    // Both are no-ops on a radio that is already enabled, which is what makes
    // running them on every render safe rather than merely tolerable.
    const { run, calls } = fake();
    await enableWifiRadio(run);
    await enableWifiRadio(run);
    expect(calls).toEqual([
      RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON,
      RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON,
    ]);
  });

  /**
   * `rfkill` is a separate binary from `nmcli` and is simply not on some
   * boards. `systemRunner` reports a missing one as exit 127. A render must
   * not fail over it, and NetworkManager's flag must still be cleared — the
   * second lock is the one a Raspberry Pi's state file holds.
   */
  it("carries on to nmcli when rfkill is not installed", async () => {
    const { run, calls } = fake({
      [RFKILL_UNBLOCK_WIFI.join(" ")]: { code: 127, stdout: "", stderr: "rfkill: not found" },
    });
    const lines: string[] = [];
    await expect(enableWifiRadio(run, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(calls).toEqual([RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON]);
    expect(lines.join("\n")).toContain("rfkill unblock wifi");
    expect(lines.join("\n")).toContain("127");
  });

  it("says so and carries on when NetworkManager will not answer", async () => {
    const lines: string[] = [];
    const { run } = fake({
      [NMCLI_RADIO_WIFI_ON.join(" ")]: { code: 8, stdout: "", stderr: "Error: NetworkManager is not running." },
    });
    await expect(enableWifiRadio(run, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("NetworkManager is not running");
  });

  it("survives a runner that rejects rather than reporting an exit code", async () => {
    const lines: string[] = [];
    const run: CommandRunner = async () => { throw new Error("spawn failed"); };
    await expect(enableWifiRadio(run, (l) => lines.push(l))).resolves.toBeUndefined();
    // Both attempts are logged: one failing to spawn says nothing about the other.
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("spawn failed");
  });

  it("says nothing when both commands succeed", async () => {
    const lines: string[] = [];
    const { run } = fake();
    await enableWifiRadio(run, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });
});
