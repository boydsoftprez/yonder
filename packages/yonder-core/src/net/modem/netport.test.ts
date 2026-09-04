// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModemNetPort } from "./netport.js";
import { MmcliClient } from "./mmcli/client.js";
import type { CommandRunner } from "../runner.js";
import type { Config } from "../../schema/config.js";
import { DEFAULT_CONFIG } from "../../schema/config.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "mmcli", "fixtures", `${name}.txt`), "utf8");

const MODEM_0 = "/org/freedesktop/ModemManager1/Modem/0";
const MODEM_1 = "/org/freedesktop/ModemManager1/Modem/1";

/** What `mmcli -L` prints. No modems at all is an ordinary answer, not an error. */
const listing = (...paths: string[]): string =>
  [`modem-list.length   : ${paths.length}`,
    ...paths.map((p, i) => `modem-list.value[${i + 1}] : ${p}`)].join("\n") + "\n";

/** The same modem, claimed by ModemManager before its net port exists. */
function withoutNetPort(show: string): string {
  return show
    .split("\n").filter((line) => !line.includes("(net)")).join("\n")
    .replace(/(modem\.generic\.ports\.length\s*:\s*)6/, "$15");
}

/**
 * A board whose modem can be taken away between readings.
 *
 * The real `MmcliClient` on a fake runner, not a stub of the client: the point
 * of asking ModemManager is what ModemManager says, and a hand-written stub
 * would assert about the parse this file does not own. Nothing here reaches a
 * real command.
 */
function board(present: () => string[]) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (argv[1] === "-L") return ok(listing(...present()));
    if (argv[1] === "-m") {
      // Modem/1 is a second stick, up on a second net port.
      if (!present().includes(argv[2] ?? "")) {
        return { code: 1, stdout: "", stderr: "error: couldn't find modem" };
      }
      return ok(argv[2] === MODEM_1
        ? fixture("modem-show").replace(/wwan0/g, "wwan1")
        : fixture("modem-show"));
    }
    return ok("");
  };
  return {
    port: new ModemNetPort(new MmcliClient(runner)),
    calls,
    reads: () => calls.filter((a) => a[1] === "-m").length,
    listings: () => calls.filter((a) => a[1] === "-L").length,
  };
}

/** A configured automatic modem — the only shape that asks ModemManager anything. */
const AUTO: Config = {
  ...DEFAULT_CONFIG,
  network: {
    ...DEFAULT_CONFIG.network,
    modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, mode: "auto", apn: "ereseller" },
  },
};

describe("ModemNetPort", () => {
  it("reads the net port rather than the port NetworkManager binds", async () => {
    const { port } = board(() => [MODEM_0]);
    // cdc-wdm0 is the control port and has no entry under /sys/class/net at
    // all; wwan0 is what holds the address and carries every byte.
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });

  it("asks the modem for its port layout once, and not again", async () => {
    // `mmcli -m` is a screenful of keys and the layout does not change under a
    // modem that is still there. This is the half that may be remembered.
    const { port, reads } = board(() => [MODEM_0]);
    for (let i = 0; i < 5; i++) expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    expect(reads()).toBe(1);
  });

  it("asks whether the modem is still there on every reading", async () => {
    const { port, listings } = board(() => [MODEM_0]);
    for (let i = 0; i < 3; i++) await port.interfaceFor(AUTO);
    expect(listings()).toBe(3);
  });

  /**
   * R-CEL-12, and the defect this class was extracted for.
   *
   * The old cache kept the name for the life of the daemon, so `pathDevices`
   * went on being handed `wwan0` after the modem was unplugged, `/reach/state`
   * kept serving a cellular path, and the console drew a ready lamp over "No
   * modem found".
   */
  it("forgets the interface when ModemManager says the modem has gone", async () => {
    let plugged = true;
    const { port } = board(() => (plugged ? [MODEM_0] : []));
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    plugged = false;
    expect(await port.interfaceFor(AUTO)).toBeNull();
  });

  it("finds the modem again when it comes back", async () => {
    // R-CEL-06: a disconnect and reconnect costs the operator nothing. The
    // layout is read again because the absence cleared what was remembered.
    let plugged = true;
    const { port, reads } = board(() => (plugged ? [MODEM_0] : []));
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    plugged = false;
    expect(await port.interfaceFor(AUTO)).toBeNull();
    plugged = true;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    expect(reads()).toBe(2);
  });

  it("does not give a new modem the port layout of the one before it", async () => {
    // Swapped sticks, same socket. A remembered layout keyed on nothing would
    // report the departed modem's port for the new one's traffic.
    let paths = [MODEM_0];
    const { port } = board(() => paths);
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    paths = [MODEM_1];
    expect(await port.interfaceFor(AUTO)).toBe("wwan1");
  });

  it("keeps the name it has when ModemManager cannot be asked at all", async () => {
    // A question that could not be asked is not an answer. Dropping to the
    // control port here would probe cdc-wdm0 on a working link, and three of
    // those stand a modem down that is carrying traffic.
    let mmcliWorks = true;
    const runner: CommandRunner = async (argv) => {
      if (!mmcliWorks) return { code: 1, stdout: "", stderr: "error: cannot connect to D-Bus" };
      if (argv[1] === "-L") return { code: 0, stdout: listing(MODEM_0), stderr: "" };
      return { code: 0, stdout: fixture("modem-show"), stderr: "" };
    };
    const port = new ModemNetPort(new MmcliClient(runner));
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    mmcliWorks = false;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });

  it("has nothing to fall back on when mmcli never worked", async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    expect(await new ModemNetPort(new MmcliClient(runner)).interfaceFor(AUTO)).toBeNull();
  });

  it("keeps asking while a modem that has been claimed has no net port yet", async () => {
    // A modem is claimed before it is ready. Remembering the absence would
    // leave this asking NetworkManager for the control port for the life of
    // the daemon, which is the failure the net port exists to avoid.
    let ready = false;
    const runner: CommandRunner = async (argv) => {
      if (argv[1] === "-L") return { code: 0, stdout: listing(MODEM_0), stderr: "" };
      const show = fixture("modem-show");
      return { code: 0, stderr: "", stdout: ready ? show : withoutNetPort(show) };
    };
    const port = new ModemNetPort(new MmcliClient(runner));
    expect(await port.interfaceFor(AUTO)).toBeNull();
    ready = true;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });

  it("asks ModemManager nothing when no modem is configured", async () => {
    // The default. A board with a stick plugged in and nothing in config.yaml
    // brings up no cellular connection, and pays for no reading either.
    const { port, calls } = board(() => [MODEM_0]);
    expect(await port.interfaceFor(DEFAULT_CONFIG)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("asks ModemManager nothing about an appliance", async () => {
    // R-CEL-11: an appliance is named as the adapter it is, and that adapter
    // is where its bytes go. There is no second name to reconcile.
    const appliance: Config = {
      ...AUTO,
      network: {
        ...AUTO.network,
        modem: { ...AUTO.network.modem, mode: "appliance", interface: "usb0" },
      },
    };
    const { port, calls } = board(() => [MODEM_0]);
    expect(await port.interfaceFor(appliance)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
