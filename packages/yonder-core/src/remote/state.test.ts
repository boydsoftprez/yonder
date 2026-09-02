// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../schema/config.js";
import type { ZeroTierNetwork } from "./zerotier/parse.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ZeroTierCli } from "./zerotier/cli.js";
import { readRemoteState, remoteState } from "./state.js";

const config = (network_id: string | null, enabled = network_id !== null): Config =>
  ConfigSchema.parse({
    version: 1,
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled, network_id } },
  });

const info = { address: "9fef8a3bf9", online: true, version: "1.16.2" };

const net = (over: Partial<ZeroTierNetwork>): ZeroTierNetwork => ({
  nwid: "9fef8a3bf9000001",
  name: "",
  status: "REQUESTING_CONFIGURATION",
  portDeviceName: "ztuqliuo7y",
  assignedAddresses: [],
  ...over,
});

describe("remoteState", () => {
  it("is off when nothing is configured", () => {
    const s = remoteState({ config: config(null), installed: true, info, networks: [] });
    expect(s.phase).toBe("off");
    expect(s.networkId).toBeNull();
  });

  // R-VPN-05: a device with no mesh configured is a normal device, and must not
  // be told it has a problem.
  it("is off, not a fault, when no client is installed and none is configured", () => {
    const s = remoteState({ config: config(null), installed: false, info: null, networks: [] });
    expect(s.phase).toBe("off");
  });

  it("says so when a network is configured but no client is installed", () => {
    const s = remoteState({ config: config("9fef8a3bf9000001"), installed: false, info: null, networks: [] });
    expect(s.phase).toBe("no-client");
  });

  it("is joining while the client is still handshaking", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "REQUESTING_CONFIGURATION" })],
    });
    expect(s.phase).toBe("joining");
  });

  // The state this whole feature is shaped around. It carries the ten-hex node
  // address because that is the one thing the operator must transfer to the
  // controller.
  it("waits for approval, and carries the address a human must approve", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "ACCESS_DENIED" })],
    });
    expect(s.phase).toBe("waiting-for-approval");
    expect(s.deviceId).toBe("9fef8a3bf9");
    expect(s.networkId).toBe("9fef8a3bf9000001");
    expect(s.addresses).toEqual([]);
  });

  it("is connected once authorised, and carries the assigned address", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK", name: "yonder-probe", assignedAddresses: ["10.147.20.26/24"] })],
    });
    expect(s.phase).toBe("connected");
    expect(s.addresses).toEqual(["10.147.20.26/24"]);
    expect(s.interface).toBe("ztuqliuo7y");
  });

  // A configured network the client has not joined at all is not "connected",
  // and it is not silence either.
  it("is joining when the configured network is not in the client's list", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [],
    });
    expect(s.phase).toBe("joining");
  });

  it("ignores a network the configuration does not name", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ nwid: "aaaaaaaaaaaaaaaa", status: "OK", assignedAddresses: ["10.0.0.1/24"] })],
    });
    expect(s.phase).toBe("joining");
    expect(s.addresses).toEqual([]);
  });

  it("reports a status it does not recognise as a fault, with the status in the detail", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "PORT_ERROR" })],
    });
    expect(s.phase).toBe("fault");
    expect(s.detail).toBe("PORT_ERROR");
  });
});

/**
 * What the console's five-second poll costs, which is not a detail: it runs
 * for the whole flight whether or not a mesh is configured, and the shipped
 * default is no mesh.
 */
describe("readRemoteState", () => {
  const harness = (reply: (argv: string[]) => CommandResult) => {
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push(argv);
      return reply(argv);
    };
    return { calls, cli: new ZeroTierCli(run) };
  };

  const absent = () => ({ code: 127, stdout: "", stderr: "command not found" });

  it("asks a client nothing at all when no mesh is configured", async () => {
    const h = harness(absent);
    expect((await readRemoteState(config(null), h.cli)).phase).toBe("off");
    expect(h.calls).toEqual([]);
  });

  it("asks nothing when the mesh is enabled but has no network id", async () => {
    const h = harness(absent);
    expect((await readRemoteState(config(null, true), h.cli)).phase).toBe("off");
    expect(h.calls).toEqual([]);
  });

  // One question, not two. `installed` is what `info` already answered - a
  // client that cannot say who it is cannot list its networks either.
  it("asks once, not twice, when there is no client to answer", async () => {
    const h = harness(absent);
    expect((await readRemoteState(config("9fef8a3bf9000001"), h.cli)).phase).toBe("no-client");
    expect(h.calls).toEqual([["zerotier-cli", "-j", "info"]]);
  });

  it("asks twice when a mesh is configured and a client answers", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : {
          code: 0,
          stdout: JSON.stringify([{
            nwid: "9fef8a3bf9000001",
            name: "",
            status: "ACCESS_DENIED",
            portDeviceName: "ztuqliuo7y",
            assignedAddresses: [],
          }]),
          stderr: "",
        },
    );
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli);
    expect(s.phase).toBe("waiting-for-approval");
    expect(s.deviceId).toBe("9fef8a3bf9");
    expect(h.calls).toEqual([
      ["zerotier-cli", "-j", "info"],
      ["zerotier-cli", "-j", "listnetworks"],
    ]);
  });
});
