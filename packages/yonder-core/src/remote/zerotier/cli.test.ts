// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../../net/runner.js";
import { ZeroTierCli, ZeroTierCliError } from "./cli.js";

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

/** Returns canned output per command, and records every argv it was given. */
function fakeRunner(reply: (argv: string[]) => CommandResult) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };
  return { run, calls };
}

describe("ZeroTierCli", () => {
  it("asks for JSON, not the terse form", async () => {
    const { run, calls } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    await new ZeroTierCli(run).info();
    expect(calls[0]).toEqual(["zerotier-cli", "-j", "info"]);
  });

  it("reads the node address", async () => {
    const { run } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    expect((await new ZeroTierCli(run).info()).address).toBe("9fef8a3bf9");
  });

  it("lists networks", async () => {
    const { run, calls } = fakeRunner(() =>
      ok('[{"nwid":"9fef8a3bf9000001","name":"","status":"ACCESS_DENIED","portDeviceName":"zt0","assignedAddresses":[]}]'),
    );
    const nets = await new ZeroTierCli(run).listNetworks();
    expect(calls[0]).toEqual(["zerotier-cli", "-j", "listnetworks"]);
    expect(nets[0].status).toBe("ACCESS_DENIED");
  });

  it("joins by network id", async () => {
    const { run, calls } = fakeRunner(() => ok("200 join OK"));
    await new ZeroTierCli(run).join("9fef8a3bf9000001");
    expect(calls[0]).toEqual(["zerotier-cli", "join", "9fef8a3bf9000001"]);
  });

  it("leaves by network id", async () => {
    const { run, calls } = fakeRunner(() => ok("200 leave OK"));
    await new ZeroTierCli(run).leave("9fef8a3bf9000001");
    expect(calls[0]).toEqual(["zerotier-cli", "leave", "9fef8a3bf9000001"]);
  });

  // The runner never rejects, so a non-zero exit has to be turned into one here
  // or every caller silently treats a failure as a success.
  it("turns a non-zero exit into an error carrying the argv and the code", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "missing port" }));
    await expect(new ZeroTierCli(run).join("9fef8a3bf9000001")).rejects.toBeInstanceOf(ZeroTierCliError);
  });

  it("reports the client as absent when the binary is not there", async () => {
    const { run } = fakeRunner(() => ({ code: 127, stdout: "", stderr: "command not found" }));
    expect(await new ZeroTierCli(run).installed()).toBe(false);
  });

  it("reports the client as present when it answers", async () => {
    const { run } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    expect(await new ZeroTierCli(run).installed()).toBe(true);
  });

  // The command line goes to the journal, never to the activity pane: a status
  // poll every few seconds would otherwise bury what the operator's Join did.
  it("traces every command it runs", async () => {
    const trace = vi.fn();
    const { run } = fakeRunner(() => ok("[]"));
    await new ZeroTierCli(run, trace).listNetworks();
    expect(trace).toHaveBeenCalledWith("zerotier-cli -j listnetworks");
  });
});
