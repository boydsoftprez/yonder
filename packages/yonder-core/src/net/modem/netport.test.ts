// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModemNetPort, MODEM_READ_DEADLINE_MS } from "./netport.js";
import { MmcliClient } from "./mmcli/client.js";
import type { CommandRunner } from "../runner.js";
import type { Clock } from "../../apply/types.js";
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
 * Time this daemon controls. Nothing here may wait on the wall clock, in
 * production or in a test — and a deadline test that did would take seconds.
 */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: now + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now) { timers.delete(h); t.fn(); }
      }
    },
  };
}

/**
 * A board whose modem can be taken away between readings.
 *
 * The real `MmcliClient` on a fake runner, not a stub of the client: the point
 * of asking ModemManager is what ModemManager says, and a hand-written stub
 * would assert about the parse this file does not own. Nothing here reaches a
 * real command.
 */
function board(present: () => string[], clock: Clock = fakeClock().clock) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (argv[1] === "-L") return ok(listing(...present()));
    if (argv[1] === "-m") {
      if (!present().includes(argv[2] ?? "")) {
        return { code: 1, stdout: "", stderr: "error: couldn't find modem" };
      }
      // Every other stick on this bench came up on wwan1.
      return ok(argv[2] === MODEM_0
        ? fixture("modem-show")
        : fixture("modem-show").replace(/wwan0/g, "wwan1"));
    }
    return ok("");
  };
  return {
    port: new ModemNetPort(new MmcliClient(runner), clock),
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

  /**
   * R-CEL-12. Nothing is remembered in order to skip a reading — not that the
   * modem exists, and not its port layout either.
   *
   * ModemManager numbers its object paths per service run, so a restart hands
   * `…/Modem/0` to whatever is there next. A layout cached against that path
   * would give a stick swapped across the restart the departed one's port,
   * and the daemon would probe and count an interface that is not the one
   * carrying traffic.
   */
  it("asks ModemManager both questions on every reading", async () => {
    const { port, reads, listings } = board(() => [MODEM_0]);
    for (let i = 0; i < 3; i++) expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    expect(listings()).toBe(3);
    expect(reads()).toBe(3);
  });

  /**
   * The defect this class was extracted for.
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
    // R-CEL-06: a disconnect and reconnect costs the operator nothing.
    let plugged = true;
    const { port } = board(() => (plugged ? [MODEM_0] : []));
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    plugged = false;
    expect(await port.interfaceFor(AUTO)).toBeNull();
    plugged = true;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });

  it("does not give a modem the port layout of the one before it", async () => {
    // A stick swapped across a ModemManager restart: the object path is
    // numbered per service run, so the new modem answers to the old name.
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
    const port = new ModemNetPort(new MmcliClient(runner), fakeClock().clock);
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    mmcliWorks = false;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });

  it("has nothing to fall back on when mmcli never worked", async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    const port = new ModemNetPort(new MmcliClient(runner), fakeClock().clock);
    expect(await port.interfaceFor(AUTO)).toBeNull();
  });

  it("does not answer for a modem it has never read", async () => {
    // The remembered name belongs to the modem it was read from. A different
    // path whose read fails has nothing to fall back on.
    let path = MODEM_0;
    const runner: CommandRunner = async (argv) => {
      if (argv[1] === "-L") return { code: 0, stdout: listing(path), stderr: "" };
      if (argv[2] === MODEM_0) return { code: 0, stdout: fixture("modem-show"), stderr: "" };
      return { code: 1, stdout: "", stderr: "error: couldn't find modem" };
    };
    const port = new ModemNetPort(new MmcliClient(runner), fakeClock().clock);
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
    path = MODEM_0.replace("/0", "/1");
    expect(await port.interfaceFor(AUTO)).toBeNull();
  });

  /**
   * A hang is not a throw, and the `try`/`catch` above does not cover one.
   *
   * The production runner kills a command after two minutes, so an unbounded
   * reading blocks `/reach/state` past the console's patience, leaves an
   * `mmcli` child behind on every five-second tick, and lets the fallback
   * watchdog's question expire into raising the access point on a board where
   * another path is working.
   */
  it("answers within its deadline when ModemManager wedges", async () => {
    const { clock, advance } = fakeClock();
    let wedged = false;
    const runner: CommandRunner = async (argv) => {
      // Never settles, which is what `mmcli -L` does against a wedged
      // ModemManager until the runner's own two-minute timeout kills it.
      if (wedged) return new Promise(() => {});
      if (argv[1] === "-L") return { code: 0, stdout: listing(MODEM_0), stderr: "" };
      return { code: 0, stdout: fixture("modem-show"), stderr: "" };
    };
    const port = new ModemNetPort(new MmcliClient(runner), clock);
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");

    wedged = true;
    const late = port.interfaceFor(AUTO);
    advance(MODEM_READ_DEADLINE_MS);
    // The last name actually observed, not the control port: a reading that
    // did not happen is not evidence that the modem has changed.
    expect(await late).toBe("wwan0");
  });

  it("has nothing to answer with when the first reading is the one that wedges", async () => {
    const { clock, advance } = fakeClock();
    const runner: CommandRunner = async () => new Promise(() => {});
    const port = new ModemNetPort(new MmcliClient(runner), clock);
    const late = port.interfaceFor(AUTO);
    advance(MODEM_READ_DEADLINE_MS);
    expect(await late).toBeNull();
  });

  it("lets no abandoned reading overwrite what a newer one recorded", async () => {
    // The deadline abandons the wait, not the work. A reading that answers
    // after a newer one has been taken is about a moment that has passed.
    const { clock, advance } = fakeClock();
    type Answer = { code: number; stdout: string; stderr: string };
    const show = (net: string): Answer =>
      ({ code: 0, stdout: fixture("modem-show").replace(/wwan0/g, net), stderr: "" });
    let release: ((v: Answer) => void) | null = null;
    let mode: "stall" | "ok" | "broken" = "stall";

    const runner: CommandRunner = async (argv) => {
      if (mode === "broken") return { code: 1, stdout: "", stderr: "error: cannot connect to D-Bus" };
      if (argv[1] === "-L") return { code: 0, stdout: listing(MODEM_0), stderr: "" };
      if (mode === "stall") return new Promise<Answer>((res) => { release = res; });
      return show("wwan0");
    };
    const port = new ModemNetPort(new MmcliClient(runner), clock);

    // A reading whose `mmcli -m` never comes back, abandoned by the deadline.
    const abandoned = port.interfaceFor(AUTO);
    advance(MODEM_READ_DEADLINE_MS);
    expect(await abandoned).toBeNull();

    // A newer reading is taken, and records wwan0.
    mode = "ok";
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");

    // Only now does the abandoned one answer — with a different port, which is
    // what makes the overwrite visible.
    release?.(show("wwan9"));
    await new Promise((r) => setImmediate(r));

    // It is not what the next reading falls back on: that is still the name
    // the newer reading recorded.
    mode = "broken";
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

  it("keeps asking while a modem that has been claimed has no net port yet", async () => {
    // A modem is claimed before it is ready. Answering with the control port
    // would probe cdc-wdm0, which fails on a link that is coming up fine.
    let ready = false;
    const runner: CommandRunner = async (argv) => {
      if (argv[1] === "-L") return { code: 0, stdout: listing(MODEM_0), stderr: "" };
      const show = fixture("modem-show");
      return { code: 0, stderr: "", stdout: ready ? show : withoutNetPort(show) };
    };
    const port = new ModemNetPort(new MmcliClient(runner), fakeClock().clock);
    expect(await port.interfaceFor(AUTO)).toBeNull();
    ready = true;
    expect(await port.interfaceFor(AUTO)).toBe("wwan0");
  });
});
