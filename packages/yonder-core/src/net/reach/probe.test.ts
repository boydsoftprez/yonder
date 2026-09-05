// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { commandProbe, PROBE_ADDRESSES } from "./probe.js";
import type { CommandRunner } from "../runner.js";

/** The URL is the last argument, and the only place a name could hide. */
const urlOf = (argv: string[]): string => argv[argv.length - 1] ?? "";

const IP_URL = /^http:\/\/(\d{1,3}\.){3}\d{1,3}\/$/;

/** A runner that answers each successive call from a list of exit codes. */
function runnerFor(codes: number[]): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const code = codes[Math.min(n, codes.length - 1)] ?? 0;
    n++;
    return { code, stdout: "", stderr: code === 0 ? "" : "failed" };
  };
  return { runner, calls };
}

describe("commandProbe", () => {
  it("sends real traffic out of the named device", async () => {
    // Bound to the device, not merely to the routing table: the question is
    // whether *this* path works, and the default route may be another one.
    const { runner, calls } = runnerFor([0]);
    expect(await commandProbe(runner)("wwan0")).toBe(true);
    expect(calls[0]).toContain("wwan0");
  });

  it("asks for no hostname, on any attempt", async () => {
    // The defect this pins. `curl --interface` binds name resolution to the
    // interface as well as the traffic, and the board's first resolver is a
    // LAN router reachable only over Ethernet — so a hostname here times out
    // on a cellular link that is working perfectly, and three of those stand
    // the path down. Every attempt must be an IP literal, and nothing in the
    // argv may be resolvable.
    const { runner, calls } = runnerFor([1]);
    expect(await commandProbe(runner)("wwan0")).toBe(false);
    expect(calls.length).toBe(PROBE_ADDRESSES.length);
    for (const argv of calls) {
      // Exactly one URL, and it is an address rather than something that has
      // to be looked up.
      const urls = argv.filter((a) => a.startsWith("http"));
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(IP_URL);
      expect(urlOf(argv)).toMatch(IP_URL);
      // No `--resolve`, no `--dns-servers`: this test does not carry a name
      // for anything to work around.
      expect(argv.some((a) => a.startsWith("--resolve") || a.startsWith("--dns"))).toBe(false);
    }
  });

  it("reaches when one address answers and another does not", async () => {
    // A single unreachable host is not a dead link. Without this, one
    // service's bad afternoon demotes a working aircraft path.
    const { runner, calls } = runnerFor([28, 0]);
    expect(await commandProbe(runner)("wwan0")).toBe(true);
    expect(calls.length).toBe(2);
    expect(urlOf(calls[0] ?? [])).not.toBe(urlOf(calls[1] ?? []));
  });

  it("spends one request when the first address answers", async () => {
    // A metered link. A path that works must not pay for every address.
    const { runner, calls } = runnerFor([0, 0]);
    expect(await commandProbe(runner)("wwan0")).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("is false only when every address fails", async () => {
    const { runner, calls } = runnerFor([28]);
    expect(await commandProbe(runner)("wwan0")).toBe(false);
    expect(calls.length).toBe(PROBE_ADDRESSES.length);
  });

  it("is false rather than throwing when the binary is missing", async () => {
    const { runner } = runnerFor([127]);
    expect(await commandProbe(runner)("wwan0")).toBe(false);
  });

  it("cannot outlast the probe budget however many addresses it tries", async () => {
    // REACH_TICK_DEADLINE_MS is sized on a probe costing at most 8 s per
    // path. Trying a second address divides that budget rather than doubling
    // what a probe can cost.
    const { runner, calls } = runnerFor([28]);
    await commandProbe(runner)("wwan0");
    const total = calls.reduce((sum, argv) => {
      const i = argv.indexOf("--max-time");
      return sum + Number(argv[i + 1]);
    }, 0);
    expect(total).toBeLessThanOrEqual(8);
    expect(calls.every((argv) => argv.includes("--max-time"))).toBe(true);
  });
});
