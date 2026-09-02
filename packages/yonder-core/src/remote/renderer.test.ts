// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../apply/types.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ZeroTierCli } from "./zerotier/cli.js";
import { RemoteRenderer, ZEROTIER_POLL_MS, ZEROTIER_WAIT_MS } from "./renderer.js";

/**
 * A clock that fast-forwards instead of waiting: `setTimer` moves `now()` on
 * by the interval asked for and runs the callback off the microtask queue.
 * A bounded poll finishes in microseconds however long its bound is, and no
 * test ever waits on the wall clock — the same rule `net/renderer.test.ts`
 * uses for `waitForRadio`.
 */
function fastClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    setTimer: (ms, fn) => { t += ms; queueMicrotask(fn); return 0; },
    clearTimer: () => {},
  };
}

const config = (network_id: string | null, enabled = network_id !== null): Config =>
  ConfigSchema.parse({
    version: 1,
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled, network_id } },
  });

function harness(
  reply: (argv: string[]) => CommandResult = () => ({ code: 0, stdout: "[]", stderr: "" }),
  opts: { clock?: Clock; zerotierWaitMs?: number; zerotierPollMs?: number } = {},
) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };
  const log = vi.fn();
  // A real path in a temp dir: the renderer records which network it joined,
  // and the test that matters is the one where a *different* renderer instance
  // reads it back.
  const statePath = join(mkdtempSync(join(tmpdir(), "yonder-remote-")), "remote.json");
  const make = () => new RemoteRenderer({
    cli: new ZeroTierCli(run), run, statePath, log,
    clock: opts.clock, zerotierWaitMs: opts.zerotierWaitMs, zerotierPollMs: opts.zerotierPollMs,
  });
  return { calls, log, statePath, make, renderer: make() };
}

const argvOf = (calls: string[][], head: string) => calls.filter((a) => a[0] === head);

const joinedList = (...nwids: string[]) =>
  JSON.stringify(
    nwids.map((nwid) => ({
      nwid,
      name: "",
      status: "OK",
      portDeviceName: "zt0",
      assignedAddresses: [],
    })),
  );

describe("RemoteRenderer", () => {
  // R-VPN-08: installing a client must not start one. With zero networks joined
  // the daemon still holds live sessions with ZeroTier's root servers, which is
  // not something a device should do because a package is merely present.
  it("does not start the service when nothing is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "systemctl")).not.toContainEqual([
      "systemctl", "enable", "--now", "zerotier-one",
    ]);
  });

  // CLAUDE.md rule 6, and the reason this branch is gated at all. A device an
  // operator joined to a mesh by hand, and is reaching the console over, must
  // not lose it to a change of palette: every apply on a default device lands
  // here, and a palette change carries no confirmation window to undo it.
  it("touches nothing at all when it has never started the service", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(calls).toEqual([]);
  });

  it("stops and disables the service it started, once the mesh is turned off", async () => {
    const h = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joinedList("9fef8a3bf9000001"), stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await h.renderer.render(config("9fef8a3bf9000001"));
    await h.renderer.render(config(null));
    expect(argvOf(h.calls, "systemctl")).toContainEqual(["systemctl", "stop", "zerotier-one"]);
    expect(argvOf(h.calls, "systemctl")).toContainEqual(["systemctl", "disable", "zerotier-one"]);
  });

  it("starts and enables the service when a network is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "systemctl")).toContainEqual(["systemctl", "enable", "--now", "zerotier-one"]);
  });

  it("joins the configured network", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "zerotier-cli")).toContainEqual(["zerotier-cli", "join", "9fef8a3bf9000001"]);
  });

  it("does not re-join a network it is already on", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":["10.147.20.26/24"]}]';
    const { renderer, calls } = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "zerotier-cli").some((a) => a[1] === "join")).toBe(false);
  });

  // Only what it owns. A network an operator joined by hand is theirs, and this
  // is not the thing that decides they have finished with it.
  it("leaves only the network it joined, never one an operator joined by hand", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":[]},{"nwid":"aaaaaaaaaaaaaaaa","name":"","status":"OK","portDeviceName":"zt1","assignedAddresses":[]}]';
    const { renderer, calls } = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await renderer.render(config("9fef8a3bf9000001"));
    await renderer.render(config(null));
    const left = argvOf(calls, "zerotier-cli").filter((a) => a[1] === "leave");
    expect(left).toEqual([["zerotier-cli", "leave", "9fef8a3bf9000001"]]);
  });

  // The case instance state cannot answer. A daemon restarts between the join
  // and the leave - an upgrade, a reboot, a crash - and a renderer that
  // remembered its network in a field would come back knowing nothing and
  // leave the device on a mesh the configuration no longer names.
  it("leaves a network a previous daemon joined, after a restart", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":[]}]';
    const h = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await h.make().render(config("9fef8a3bf9000001"));
    // A different instance, as after a restart, sharing only the state file.
    await h.make().render(config(null));
    const left = argvOf(h.calls, "zerotier-cli").filter((a) => a[1] === "leave");
    expect(left).toEqual([["zerotier-cli", "leave", "9fef8a3bf9000001"]]);
  });

  it("leaves nothing when it has never joined anything", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "zerotier-cli").some((a) => a[1] === "leave")).toBe(false);
  });

  // A board installed before ZeroTier was carried has no client. Say so; do not
  // fail with a shell error the operator cannot act on.
  it("fails with a reason when a network is configured and no client is installed", async () => {
    const { renderer } = harness(() => ({ code: 127, stdout: "", stderr: "command not found" }));
    await expect(renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow(/not installed/);
  });

  it("says what it is doing, for the activity pane", async () => {
    const { renderer, log } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("9fef8a3bf9000001"));
  });

  // The network id changed: the old membership has to go, or the device sits
  // on two meshes and the configuration names neither.
  it("leaves the old network before joining a new one", async () => {
    // A client that remembers, so the second render sees what the first did.
    const member = new Set<string>();
    const h = harness((argv) => {
      if (argv.includes("listnetworks")) {
        return { code: 0, stdout: joinedList(...member), stderr: "" };
      }
      if (argv[1] === "join") member.add(argv[2] as string);
      if (argv[1] === "leave") member.delete(argv[2] as string);
      return { code: 0, stdout: "", stderr: "" };
    });
    await h.renderer.render(config("9fef8a3bf9000001"));
    await h.renderer.render(config("aaaaaaaaaaaaaaaa"));
    const zt = argvOf(h.calls, "zerotier-cli").filter((a) => a[1] === "leave" || a[1] === "join");
    expect(zt).toEqual([
      ["zerotier-cli", "join", "9fef8a3bf9000001"],
      ["zerotier-cli", "leave", "9fef8a3bf9000001"],
      ["zerotier-cli", "join", "aaaaaaaaaaaaaaaa"],
    ]);
    expect(member).toEqual(new Set(["aaaaaaaaaaaaaaaa"]));
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({ network: "aaaaaaaaaaaaaaaa" });
  });

  // A leave that failed did not happen. The membership is still in the
  // client's own database, so an apply that reported success and forgot the
  // network would leave the aircraft on a mesh nothing records and nothing
  // will ever remove.
  it("fails the apply when a leave fails, and keeps the record of what it joined", async () => {
    const h = harness((argv) => {
      if (argv.includes("listnetworks")) {
        return { code: 0, stdout: joinedList("9fef8a3bf9000001"), stderr: "" };
      }
      if (argv[1] === "leave") return { code: 1, stdout: "", stderr: "leave failed" };
      return { code: 0, stdout: "", stderr: "" };
    });
    await h.renderer.render(config("9fef8a3bf9000001"));
    await expect(h.renderer.render(config(null))).rejects.toThrow();
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({ network: "9fef8a3bf9000001" });
    // And nothing was stopped either: the device is still on that mesh.
    expect(argvOf(h.calls, "systemctl")).not.toContainEqual(["systemctl", "stop", "zerotier-one"]);
  });

  // R-VPN-07 names "a service that will not start" as one of the three
  // failures that must fail the apply, and it must not be reported as one of
  // the other two: an operator whose client cannot bind its port is not
  // helped by being sent to rebuild a payload.
  it("fails the apply, naming the service, when the unit will not start", async () => {
    const h = harness((argv) =>
      argv[0] === "systemctl"
        ? { code: 1, stdout: "", stderr: "Job for zerotier-one.service failed" }
        : { code: 0, stdout: "[]", stderr: "" },
    );
    await expect(h.renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow(/would not start/);
    // And it stopped there, rather than blaming the payload two calls later.
    expect(argvOf(h.calls, "zerotier-cli")).toEqual([]);
  });

  it("says the client is not installed when systemd has no such unit", async () => {
    const h = harness((argv) =>
      argv[0] === "systemctl"
        ? { code: 1, stdout: "", stderr: "Failed to enable unit: Unit file zerotier-one.service does not exist." }
        : { code: 0, stdout: "[]", stderr: "" },
    );
    await expect(h.renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow(/not installed/);
  });

  // R-VPN-08's "installed and off" is a claim this renderer makes, so it has
  // to check it. A stop that silently failed leaves the aircraft talking to a
  // company's root servers with nothing on the console saying so.
  it("fails the apply when the service will not stop", async () => {
    const h = harness((argv) => {
      if (argv.includes("listnetworks")) return { code: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "systemctl" && argv[1] === "stop") {
        return { code: 1, stdout: "", stderr: "Failed to stop zerotier-one.service" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    await h.renderer.render(config("9fef8a3bf9000001"));
    await expect(h.renderer.render(config(null))).rejects.toThrow(/systemctl stop/);
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({ network: "9fef8a3bf9000001" });
  });

  // Except the one case where the goal is already met: a unit systemd has
  // never heard of is neither running nor going to start at boot. A client
  // somebody removed by hand must not fail every later apply on the device.
  it("accepts a unit that is not there when it is trying to turn one off", async () => {
    const h = harness((argv) => {
      if (argv[0] === "systemctl" && (argv[1] === "stop" || argv[1] === "disable")) {
        return { code: 5, stdout: "", stderr: "Unit zerotier-one.service not loaded." };
      }
      if (argv.includes("listnetworks")) return { code: 0, stdout: "[]", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    await h.renderer.render(config("9fef8a3bf9000001"));
    await expect(h.renderer.render(config(null))).resolves.toBeUndefined();
    expect(existsSync(h.statePath)).toBe(false);
  });

  // The record is a write-ahead, not a receipt. A companion computer on an
  // aircraft is not a machine that shuts down politely, and a record written
  // after the join leaves a window where the device is a member of a network
  // nothing on disk says Yonder put it on.
  it("records the network before it joins it, not after", async () => {
    const seen: (string | null)[] = [];
    const h = harness((argv) => {
      if (argv[1] === "join") {
        seen.push(existsSync(h.statePath) ? readFileSync(h.statePath, "utf8").trim() : null);
      }
      return { code: 0, stdout: "[]", stderr: "" };
    });
    await h.renderer.render(config("9fef8a3bf9000001"));
    expect(seen).toEqual([JSON.stringify({ network: "9fef8a3bf9000001" })]);
  });

  // The other half of the same window: a write that fails must fail the apply
  // rather than leave a membership nothing knows about.
  it("fails the apply when the record cannot be written, before joining anything", async () => {
    const h = harness();
    // A directory where the file should be: writeFileDurable cannot replace it.
    mkdirSync(h.statePath, { recursive: true });
    await expect(h.renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow();
    expect(argvOf(h.calls, "zerotier-cli").some((a) => a[1] === "join")).toBe(false);
  });
});

// A real board measured `enable --now zerotier-one` returning well before the
// client would answer `listnetworks` — ~368 ms on a warm start, and slower
// still on the first start after installation, because the client generates
// an identity keypair before it opens its control socket. The very first
// join on a freshly installed device is exactly that path, and a render that
// asked immediately lost the race and reverted the operator's network id.
describe("RemoteRenderer waiting for the client to answer", () => {
  it("joins once the client answers, after polling past several failures", async () => {
    // The first three `listnetworks` calls land before the client is
    // listening; the fourth succeeds, as a real board's does once its
    // identity is generated and its socket is open.
    let listnetworksCalls = 0;
    const h = harness(
      (argv) => {
        if (argv.includes("listnetworks")) {
          listnetworksCalls++;
          if (listnetworksCalls < 4) return { code: 1, stdout: "", stderr: "cannot connect" };
          return { code: 0, stdout: "[]", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      { clock: fastClock() },
    );
    await h.renderer.render(config("9fef8a3bf9000001"));
    expect(listnetworksCalls).toBe(4);
    expect(argvOf(h.calls, "zerotier-cli")).toContainEqual(["zerotier-cli", "join", "9fef8a3bf9000001"]);
    // The record was still written, and the wait itself was logged for the
    // activity pane, once — not on every one of the failed polls.
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({ network: "9fef8a3bf9000001" });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("has not answered yet"));
  });

  it("still fails with the \"did not answer\" error when the client never comes up, and does not hang past the bound", async () => {
    const h = harness(
      (argv) =>
        argv.includes("listnetworks")
          ? { code: 1, stdout: "", stderr: "cannot connect" }
          : { code: 0, stdout: "", stderr: "" },
      { clock: fastClock(), zerotierWaitMs: 2_000, zerotierPollMs: 250 },
    );
    await expect(h.renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow(
      /the client did not answer; look at the journal for zerotier-one/,
    );
    // Nothing was ever recorded as joined, and no join was attempted against
    // a client that never answered at all.
    expect(existsSync(h.statePath)).toBe(false);
    expect(argvOf(h.calls, "zerotier-cli").some((a) => a[1] === "join")).toBe(false);
  });

  it("does not wait at all when the client answers immediately", async () => {
    const h = harness(() => ({ code: 0, stdout: "[]", stderr: "" }), { clock: fastClock() });
    await h.renderer.render(config("9fef8a3bf9000001"));
    expect(h.calls.filter((a) => a.includes("listnetworks"))).toHaveLength(1);
    expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("has not answered yet"));
  });

  it("exports the production bound and poll interval", () => {
    // Sanity check on the constants documented above: the bound must stay a
    // fraction of the 60 s per-renderer timeout in apply/engine.ts, not
    // approach it — that margin is what lets this renderer's own message win
    // the race against the engine's generic timeout.
    expect(ZEROTIER_WAIT_MS).toBeLessThan(60_000);
    expect(ZEROTIER_POLL_MS).toBeLessThan(ZEROTIER_WAIT_MS);
  });
});
