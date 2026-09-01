// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { FallbackWatchdog } from "./watchdog.js";
import { NmcliClient } from "./nmcli/client.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { Clock } from "../apply/types.js";
import type { CommandRunner, CommandResult } from "./runner.js";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/**
 * fire() resolves through four chained async layers before it calls apUp():
 * fire -> check -> NmcliClient.activeIpv4 -> NmcliClient#exec -> the fake
 * CommandRunner. Each `await` on a call to an async function costs its own
 * microtask tick, so a single (or even double/triple) bare
 * `await Promise.resolve()` after advancing the fake clock observes the
 * watchdog mid-flight rather than settled. Looping enough ticks drains the
 * chain deterministically — no timers, no wall-clock wait, nothing to make
 * this flaky — without depending on the exact call depth staying fixed.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
    },
  };
}

/**
 * `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` output, in the shape
 * the real thing emits: a stream of `FIELD:value` lines, one per property per
 * device, not one record per device. See parseDeviceShow.
 */
const DEVICE_SHOW = {
  /** Two interfaces, neither holding an address. */
  none: "GENERAL.DEVICE:eth0\nGENERAL.DEVICE:wlan0\n",
  /** One interface only, holding nothing. */
  nothingUp: "GENERAL.DEVICE:eth0\n",
  ethernetUp: "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nGENERAL.DEVICE:wlan0\n",
  /** Only the access point's own address is up. */
  apOnly: "GENERAL.DEVICE:wlan0\nIP4.ADDRESS[1]:192.168.77.1/24\n",
  loopbackOnly: "GENERAL.DEVICE:lo\nIP4.ADDRESS[1]:127.0.0.1/8\nGENERAL.DEVICE:eth0\n",
};

function harness(deviceShow: string, config: Config = DEFAULT_CONFIG) {
  const { clock, advance } = fakeClock();
  const run: CommandRunner = async (argv) =>
    argv.join(" ") === "nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show" ? ok(deviceShow) : ok();
  let raised = 0;
  const wd = new FallbackWatchdog({
    client: new NmcliClient(run),
    clock,
    config,
    apUp: async () => { raised++; },
  });
  return { wd, advance, raised: () => raised };
}

describe("FallbackWatchdog", () => {
  it("raises the access point when nothing is reachable at the deadline", async () => {
    const { wd, advance, raised } = harness(DEVICE_SHOW.none);
    wd.start();
    advance(90_000);
    await flushMicrotasks();
    expect(raised()).toBe(1);
  });

  it("does not raise it when an interface has an address", async () => {
    const { wd, advance, raised } = harness(DEVICE_SHOW.ethernetUp);
    wd.start();
    advance(90_000);
    await flushMicrotasks();
    expect(raised()).toBe(0);
  });

  it("does not raise it before the deadline", async () => {
    const { wd, advance, raised } = harness(DEVICE_SHOW.nothingUp);
    wd.start();
    advance(89_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("ignores the access point's own address when deciding", async () => {
    // 192.168.77.1 is the access point itself; its presence must not count
    // as "we are reachable", or the fallback could never fire twice.
    const { wd, advance, raised } = harness(DEVICE_SHOW.apOnly);
    wd.start();
    advance(90_000);
    await flushMicrotasks();
    expect(raised()).toBe(1);
  });

  it("ignores loopback", async () => {
    const { wd, advance, raised } = harness(DEVICE_SHOW.loopbackOnly);
    wd.start();
    advance(90_000);
    await flushMicrotasks();
    expect(raised()).toBe(1);
  });

  it("honours a configured timeout other than the default", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.fallback.timeout = 120;
    const { wd, advance, raised } = harness(DEVICE_SHOW.nothingUp, c);
    wd.start();
    advance(90_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
    advance(31_000);
    await flushMicrotasks();
    expect(raised()).toBe(1);
  });

  it("does nothing at all when the fallback is disabled", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.fallback.enabled = false;
    const { wd, advance, raised } = harness(DEVICE_SHOW.nothingUp, c);
    wd.start();
    advance(200_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("stop() cancels a pending check", async () => {
    const { wd, advance, raised } = harness(DEVICE_SHOW.nothingUp);
    wd.start();
    wd.stop();
    advance(200_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("raises the access point even when nmcli fails, rather than assuming reachability", async () => {
    const { clock, advance } = fakeClock();
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "NetworkManager is not running" });
    let raised = 0;
    const wd = new FallbackWatchdog({
      client: new NmcliClient(run), clock, config: DEFAULT_CONFIG,
      apUp: async () => { raised++; },
    });
    wd.start();
    advance(90_000);
    await flushMicrotasks();
    expect(raised).toBe(1);
  });
});
