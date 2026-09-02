// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { joinSucceeded } from "./joined.js";
import { NmcliClient } from "./nmcli/client.js";
import type { CommandRunner } from "./runner.js";
import type { Clock } from "../apply/types.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

/**
 * A clock a test drives. `advance` moves `now` and fires anything due, then
 * yields so the promise chain behind each timer can settle before the next
 * step — without it, a poll loop that awaits its own timer never progresses.
 */
function manualClock(): Clock & { advance(ms: number): Promise<void> } {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: now + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

/**
 * R-CFG-11. The device decides whether the join took, because the operator
 * cannot: the console leaves the air with the access point.
 */

const SHOW_JOINED = `GENERAL.DEVICE:wlan0
GENERAL.CONNECTION:yonder-wifi
IP4.ADDRESS[1]:192.168.1.42/24
IP4.GATEWAY:192.168.1.1
`;

const SHOW_NO_ADDRESS = `GENERAL.DEVICE:wlan0
GENERAL.CONNECTION:yonder-wifi
IP4.GATEWAY:--
`;

const SHOW_NO_GATEWAY = `GENERAL.DEVICE:wlan0
GENERAL.CONNECTION:yonder-wifi
IP4.ADDRESS[1]:169.254.3.9/16
IP4.GATEWAY:--
`;

/** A configuration that is on its way to a network, which is what makes the
 *  join checks apply at all. */
function joiningConfig(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.network.client.ssid = "HomeNetwork";
  return c;
}

function harness(show: string, pingOk: boolean): {
  run: () => ReturnType<typeof joinSucceeded>;
  argv: string[][];
  clock: ReturnType<typeof manualClock>;
} {
  const argv: string[][] = [];
  const runner: CommandRunner = (a) => {
    argv.push(a);
    if (a[0] === "nmcli") return Promise.resolve({ code: 0, stdout: show, stderr: "" });
    // ping
    return Promise.resolve(pingOk
      ? { code: 0, stdout: "2 packets transmitted, 2 received, 0% packet loss\nrtt min/avg/max/mdev = 1.0/1.1/1.2/0.1 ms\n", stderr: "" }
      : { code: 1, stdout: "2 packets transmitted, 0 received, 100% packet loss\n", stderr: "" });
  };
  const clock = manualClock();
  const client = new NmcliClient(runner, () => {});
  return { run: () => joinSucceeded({ target: joiningConfig(), client, runner, clock, graceMs: 6_000, pollMs: 1_000 }), argv, clock };
}

describe("joinSucceeded", () => {
  it("confirms when there is an address and the gateway answers", async () => {
    const { run, argv } = harness(SHOW_JOINED, true);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("192.168.1.1");
    // It pinged the gateway it was told about, not something it invented.
    expect(argv.some((a) => a[0] === "ping" && a.includes("192.168.1.1"))).toBe(true);
  });

  /**
   * An address is not the same as a network. DHCP hands one out on plenty of
   * networks that then drop everything, and a captive portal issues one
   * eagerly.
   */
  it("refuses when an address was issued but the gateway is silent", async () => {
    const result = await harness(SHOW_JOINED, false).run();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not answer/);
  });

  it("refuses a link-local address with no gateway to reach", async () => {
    const { run, clock } = harness(SHOW_NO_GATEWAY, true);
    const p = run();
    await clock.advance(7_000);
    const result = await p;
    expect(result.ok).toBe(false);
  });

  it("gives DHCP time before deciding, then gives up", async () => {
    const { run, clock } = harness(SHOW_NO_ADDRESS, true);
    const p = run();
    await clock.advance(7_000);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no address/);
  });

  /** A verifier that cannot ask has not established anything. */
  it("does not call a failure to look a success", async () => {
    const clock = manualClock();
    const runner: CommandRunner = () => Promise.reject(new Error("nmcli is not here"));
    const client = new NmcliClient(runner, () => {});
    const p = joinSucceeded({ target: joiningConfig(), client, runner, clock, graceMs: 4_000, pollMs: 1_000 });
    await clock.advance(5_000);
    expect((await p).ok).toBe(false);
  });
});
