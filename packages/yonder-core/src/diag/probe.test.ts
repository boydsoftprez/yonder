// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { Clock } from "../apply/types.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import {
  DEFAULT_REACHABILITY_HOST,
  MAX_COUNT,
  isProbeHost,
  parsePingSummary,
  ping,
  reachable,
} from "./probe.js";

/**
 * No test here executes `ping`. Every one of them injects a runner, and the
 * clock is driven by hand, so nothing waits and nothing leaves this machine.
 */

const REPLIED = [
  "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.",
  "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=8.29 ms",
  "64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=9.12 ms",
  "64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=10.3 ms",
  "",
  "--- 1.1.1.1 ping statistics ---",
  "3 packets transmitted, 3 received, 0% packet loss, time 2003ms",
  "rtt min/avg/max/mdev = 8.294/9.117/10.352/0.884 ms",
  "",
].join("\n");

const SILENT = [
  "PING 192.168.9.9 (192.168.9.9) 56(84) bytes of data.",
  "",
  "--- 192.168.9.9 ping statistics ---",
  "3 packets transmitted, 0 received, 100% packet loss, time 2043ms",
  "",
].join("\n");

/** A runner that records what it was asked and answers with what it was given. */
function stubRunner(result: Partial<CommandResult>): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: (argv) => {
      calls.push(argv);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
    },
  };
}

/** A runner that never answers. The wedged-binary case. */
const neverAnswers: CommandRunner = () => new Promise<CommandResult>(() => {});

/** A clock whose timers fire only when a test says so. */
function manualClock(): Clock & { fire(): void } {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    now: () => 0,
    setTimer: (_ms, fn) => { const h = next++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
    fire: () => { for (const fn of [...timers.values()]) fn(); },
  };
}

describe("isProbeHost", () => {
  it("accepts IPv4 addresses and DNS host names", () => {
    for (const host of [
      "1.1.1.1", "192.168.77.1", "8.8.8.8",
      "example.com", "a.b.c.d.example.com", "gateway", "my-router.local",
      "example.com.", "xn--bcher-kva.example",
    ]) {
      expect(isProbeHost(host), host).toBe(true);
    }
  });

  /**
   * The malicious cases. `CommandRunner` passes an argument array and there is
   * no shell, so none of these could ever have become a second command — but
   * that is the runner's property, and this validator is what stops an
   * arbitrary string reaching `ping` at all.
   */
  it("refuses anything that is not one of those", () => {
    for (const host of [
      "8.8.8.8; rm -rf /",
      "$(whoami)",
      "`id`",
      "8.8.8.8 && reboot",
      "a".repeat(300),
      "-i0.001",                    // a flag, not a host
      "--help",
      "192.168.1.1/24",             // a network, not a host
      "2001:db8::1",                // IPv6 — K-22
      "::1",
      "host name with spaces",
      "under_score.example.com",
      "-leading-hyphen.example",
      "trailing-hyphen-.example",
      "",
      ".",
      "example..com",
      "999.1.1.1",           // every label is a legal name label; the last is all digits
      "http://example.com",
      "example.com:80",
      "a".repeat(64) + ".example.com", // a label longer than 63
    ]) {
      expect(isProbeHost(host), host).toBe(false);
    }
  });
});

describe("parsePingSummary", () => {
  it("reads what ping said it did", () => {
    expect(parsePingSummary(REPLIED)).toEqual({ transmitted: 3, received: 3, rttMs: 9.117 });
  });

  it("reads a run where nothing answered", () => {
    expect(parsePingSummary(SILENT)).toEqual({ transmitted: 3, received: 0, rttMs: null });
  });

  it("reports null rather than a number it did not read", () => {
    expect(parsePingSummary("")).toEqual({ transmitted: null, received: null, rttMs: null });
    expect(parsePingSummary("something else entirely"))
      .toEqual({ transmitted: null, received: null, rttMs: null });
  });
});

describe("ping", () => {
  it("reports a host that answered", async () => {
    const { runner, calls } = stubRunner({ code: 0, stdout: REPLIED });
    const result = await ping("1.1.1.1", { runner, clock: manualClock() });
    expect(result).toEqual({
      host: "1.1.1.1", reachable: true, transmitted: 3, received: 3, rttMs: 9.117,
    });
    expect(calls).toEqual([["ping", "-n", "-c", "3", "-w", "5", "1.1.1.1"]]);
  });

  it("reports a host that did not answer as a measurement, not an error", async () => {
    const { runner } = stubRunner({ code: 1, stdout: SILENT });
    const result = await ping("192.168.9.9", { runner, clock: manualClock() });
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("no-reply");
    expect(result.transmitted).toBe(3);
    expect(result.received).toBe(0);
  });

  /**
   * Exit 1 and exit 2 must not read the same on a page. One is "that host is
   * not answering", the other is "this probe never happened".
   */
  it("tells a probe that could not run apart from a host that is down", async () => {
    const { runner } = stubRunner({ code: 2, stdout: "", stderr: "ping: nope.invalid: Name or service not known" });
    const result = await ping("nope.invalid", { runner, clock: manualClock() });
    expect(result.reason).toBe("failed");
    expect(result.reachable).toBe(false);
  });

  /**
   * `execFile` reports ENOENT as our runner's code 127. A board with no
   * `ping` binary must say so rather than report every host as down.
   */
  it("survives a board with no ping at all", async () => {
    const { runner } = stubRunner({ code: 127, stdout: "", stderr: "Error: spawn ping ENOENT" });
    const result = await ping("1.1.1.1", { runner, clock: manualClock() });
    expect(result.reason).toBe("failed");
  });

  /**
   * R-SEC-10's shape applied to a route that answers 200. The generic 500 in
   * daemon/routes.ts stops a subprocess message leaving the device by the
   * error path; a `detail` copied out of stderr would carry one out by the
   * success path instead.
   */
  it("never puts the subprocess's own output in the answer", async () => {
    const stderr = "ping: socket: Operation not permitted (/usr/bin/ping)";
    const { runner } = stubRunner({ code: 2, stdout: "", stderr });
    const result = await ping("1.1.1.1", { runner, clock: manualClock() });
    expect(JSON.stringify(result)).not.toContain("Operation not permitted");
    expect(JSON.stringify(result)).not.toContain("/usr/bin/ping");
  });

  it("refuses a host that is not one, and runs nothing", async () => {
    const { runner, calls } = stubRunner({ code: 0, stdout: REPLIED });
    const result = await ping("8.8.8.8; rm -rf /", { runner, clock: manualClock() });
    expect(result.reason).toBe("invalid-host");
    expect(result.reachable).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not echo the refused value back into the browser", async () => {
    const result = await ping("<script>alert(1)</script>", {
      runner: stubRunner({}).runner,
      clock: manualClock(),
    });
    expect(JSON.stringify(result)).not.toContain("script");
  });

  it("clamps the count rather than letting a page start an unbounded probe", async () => {
    const { runner, calls } = stubRunner({ code: 0, stdout: REPLIED });
    const clock = manualClock();
    await ping("1.1.1.1", { runner, clock, count: 10_000 });
    await ping("1.1.1.1", { runner, clock, count: 0 });
    await ping("1.1.1.1", { runner, clock, count: Number.NaN });
    await ping("1.1.1.1", { runner, clock, count: 2.7 });
    expect(calls.map((c) => c[3])).toEqual([String(MAX_COUNT), "1", "3", "2"]);
  });

  /**
   * A probe that never returns is a console request that never returns. `-w`
   * bounds the subprocess; this bounds the wait, so a wedged `ping` still
   * produces an answer.
   */
  it("answers when the runner never does", async () => {
    const clock = manualClock();
    const pending = ping("1.1.1.1", { runner: neverAnswers, clock });
    clock.fire();
    const result = await pending;
    expect(result.reason).toBe("timed-out");
    expect(result.reachable).toBe(false);
  });

  it("answers rather than rejecting when the runner itself throws", async () => {
    const clock = manualClock();
    const result = await ping("1.1.1.1", {
      runner: () => Promise.reject(new Error("the runner is broken")),
      clock,
    });
    expect(result.reason).toBe("timed-out");
    expect(JSON.stringify(result)).not.toContain("the runner is broken");
  });
});

describe("reachable", () => {
  it("probes a literal address, so broken DNS is not read as a dead link", async () => {
    const { runner, calls } = stubRunner({ code: 0, stdout: REPLIED });
    const result = await reachable({ runner, clock: manualClock() });
    expect(result.reachable).toBe(true);
    expect(calls[0]).toContain(DEFAULT_REACHABILITY_HOST);
    expect(DEFAULT_REACHABILITY_HOST).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("takes a different address, and holds it to the same rule", async () => {
    const { runner, calls } = stubRunner({ code: 0, stdout: REPLIED });
    const clock = manualClock();
    await reachable({ runner, clock, host: "9.9.9.9" });
    expect(calls[0]).toContain("9.9.9.9");
    expect((await reachable({ runner, clock, host: "; reboot" })).reason).toBe("invalid-host");
  });

  it("reports no answer as unreachable rather than as a failure", async () => {
    const { runner } = stubRunner({ code: 1, stdout: SILENT });
    const result = await reachable({ runner, clock: manualClock() });
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("no-reply");
  });
});
