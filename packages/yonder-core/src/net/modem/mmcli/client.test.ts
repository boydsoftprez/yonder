// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MmcliClient, controlPort } from "./client.js";
import type { CommandRunner } from "../../runner.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

/** A runner that answers from fixtures and records every argv it was given. */
function fakeRunner(answers: Record<string, string>) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
    if (key === undefined) return { code: 1, stdout: "", stderr: "no such fixture" };
    return { code: 0, stdout: answers[key], stderr: "" };
  };
  return { runner, calls };
}

describe("MmcliClient.modems", () => {
  it("lists the modem paths", async () => {
    const { runner, calls } = fakeRunner({ "-L": fixture("modem-list") });
    expect(await new MmcliClient(runner).modems())
      .toEqual(["/org/freedesktop/ModemManager1/Modem/0"]);
    expect(calls[0]).toEqual(["mmcli", "-L", "--output-keyvalue"]);
  });

  it("is empty, not an error, when no modem is present", async () => {
    // A board with no modem is an ordinary board, not a fault.
    const { runner } = fakeRunner({ "-L": "modem-list.length : 0\n" });
    expect(await new MmcliClient(runner).modems()).toEqual([]);
  });
});

describe("MmcliClient.modem", () => {
  it("reads what the modem says about itself", async () => {
    const { runner } = fakeRunner({ "-m": fixture("modem-show") });
    const m = await new MmcliClient(runner).modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(m.model).toBe("EC25");
    expect(m.state).toBe("connected");
    expect(m.accessTechnology).toBe("lte");
    expect(m.operatorName).toBe("Dark Star");
    expect(m.registration).toBe("home");
  });

  it("separates the port that is configured from the port that carries traffic", async () => {
    // The device NetworkManager binds is cdc-wdm0; the address and every byte
    // are on wwan0. Both names are correct for different questions.
    const { runner } = fakeRunner({ "-m": fixture("modem-show") });
    const m = await new MmcliClient(runner).modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(m.ports.control).toBe("cdc-wdm0");
    expect(m.ports.net).toBe("wwan0");
  });
});

/**
 * R-CEL-03: *detect which mode a connected modem needs, and say which it
 * chose.* The rule for which port answers that lives here once, because the
 * console answers the same question off the port list `/modem/state` carries
 * and a second copy is the copy that stops matching.
 */
describe("controlPort", () => {
  it("finds the control port and the mode it came up in", () => {
    expect(controlPort([
      "cdc-wdm0 (mbim)", "ttyUSB0 (ignored)", "ttyUSB1 (gps)",
      "ttyUSB2 (at)", "ttyUSB3 (at)", "wwan0 (net)",
    ])).toEqual({ name: "cdc-wdm0", kind: "mbim" });
  });

  it("reads QMI too, because both give a data path", () => {
    expect(controlPort(["cdc-wdm0 (qmi)", "wwan0 (net)"]))
      .toEqual({ name: "cdc-wdm0", kind: "qmi" });
  });

  /**
   * The arrangement the install role's full udev re-trigger exists to
   * prevent: a modem claimed with `ttyUSB2 (at)` primary and `wwan0
   * (ignored)` — PPP and no data port. There is no mode to report, and
   * saying `AT` would name one nothing was built on.
   */
  it("is null when no port says which mode it is", () => {
    expect(controlPort(["ttyUSB2 (at)", "wwan0 (ignored)"])).toBeNull();
    expect(controlPort([])).toBeNull();
  });
});

describe("MmcliClient.connectedBearer", () => {
  it("returns the bearer that is connected, not the first one listed", async () => {
    // Bearer 0 is the network's initial bearer: not connected, and carrying an
    // APN nobody configured. It is listed second here and is index 0 there.
    const runner: CommandRunner = async (argv) => {
      const line = argv.join(" ");
      if (line.includes("Bearer/1")) return { code: 0, stdout: fixture("bearer-connected"), stderr: "" };
      if (line.includes("Bearer/0")) return { code: 0, stdout: fixture("bearer-initial"), stderr: "" };
      return { code: 0, stdout: fixture("modem-show"), stderr: "" };
    };
    const client = new MmcliClient(runner);
    const modem = await client.modem("/org/freedesktop/ModemManager1/Modem/0");
    const bearer = await client.connectedBearer(modem);
    expect(bearer?.apn).toBe("ereseller");
    expect(bearer?.interface).toBe("wwan0");
    expect(bearer?.address).toBe("10.31.95.33");
    expect(bearer?.mtu).toBe(1430);
  });

  it("is null when no bearer is connected", async () => {
    const runner: CommandRunner = async (argv) =>
      argv.join(" ").includes("-b")
        ? { code: 0, stdout: fixture("bearer-initial"), stderr: "" }
        : { code: 0, stdout: fixture("modem-show"), stderr: "" };
    const client = new MmcliClient(runner);
    const modem = await client.modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(await client.connectedBearer(modem)).toBeNull();
  });
});

describe("MmcliClient signal", () => {
  it("arms polling before reading, because otherwise there is nothing to read", async () => {
    const { runner, calls } = fakeRunner({ "--signal-setup": "" });
    await new MmcliClient(runner).armSignal("/org/freedesktop/ModemManager1/Modem/0", 2);
    expect(calls[0]).toEqual([
      "mmcli", "-m", "/org/freedesktop/ModemManager1/Modem/0", "--signal-setup=2",
    ]);
  });

  it("reads the four numbers for the technology in use", async () => {
    const { runner } = fakeRunner({ "--signal-get": fixture("signal-get") });
    const s = await new MmcliClient(runner).signal("/org/freedesktop/ModemManager1/Modem/0");
    expect(s).toEqual({ rssi: -71, rsrq: -9, rsrp: -100, snr: 19 });
  });

  it("answers nulls rather than zeroes when polling was never armed", async () => {
    // Zero dBm is a real and extraordinary value. Reporting it for "unknown"
    // would put a perfect signal on a console that has no signal at all.
    const { runner } = fakeRunner({ "--signal-get": "modem.signal.lte.rssi : --\n" });
    expect(await new MmcliClient(runner).signal("/x"))
      .toEqual({ rssi: null, rsrq: null, rsrp: null, snr: null });
  });
});
