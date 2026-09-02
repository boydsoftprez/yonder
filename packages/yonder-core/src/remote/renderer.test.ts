// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ZeroTierCli } from "./zerotier/cli.js";
import { RemoteRenderer } from "./renderer.js";

const config = (network_id: string | null, enabled = network_id !== null): Config =>
  ConfigSchema.parse({
    version: 1,
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled, network_id } },
  });

function harness(reply: (argv: string[]) => CommandResult = () => ({ code: 0, stdout: "[]", stderr: "" })) {
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
  const make = () => new RemoteRenderer({ cli: new ZeroTierCli(run), run, statePath, log });
  return { calls, log, statePath, make, renderer: make() };
}

const argvOf = (calls: string[][], head: string) => calls.filter((a) => a[0] === head);

describe("RemoteRenderer", () => {
  // R-VPN-08: installing a client must not start one. With zero networks joined
  // the daemon still holds live sessions with ZeroTier's root servers, which is
  // not something a device should do because a package is merely present.
  it("does not start the service when nothing is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "systemctl").map((a) => a[1])).not.toContain("start");
  });

  it("stops the service when nothing is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "systemctl")).toContainEqual(["systemctl", "stop", "zerotier-one"]);
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
});
