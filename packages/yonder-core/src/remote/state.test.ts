// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../schema/config.js";
import type { ZeroTierNetwork, ZeroTierPath, ZeroTierPeer } from "./zerotier/parse.js";
import type { Traffic } from "./traffic.js";
import type { Throughput } from "./sampler.js";
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

// The network id used throughout is "9fef8a3bf9000001"; its first ten hex
// characters, "9fef8a3bf9", are the controller's own address - the same
// address `info` above uses for the *device*, which is a coincidence of
// these fixtures, not a rule (a controller is never the device itself).
const path = (over: Partial<ZeroTierPath> = {}): ZeroTierPath => ({
  active: true,
  preferred: true,
  address: "1.2.3.4/9993",
  lastReceive: 1_000,
  ...over,
});

const peer = (over: Partial<ZeroTierPeer> = {}): ZeroTierPeer => ({
  address: "c0ffee0001",
  role: "LEAF",
  latencyMs: 34,
  relayed: false,
  version: "1.16.2",
  paths: [path()],
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
    expect(s.networkName).toBe("yonder-probe");
    expect(s.online).toBe(true);
  });

  // R-VPN-10: "OK" only means the controller authorised this device and it
  // holds a valid, cached network config - not that it can reach anything.
  // That config survives the loss of every path, so `status === "OK"` alone
  // must never be reported as "connected".
  it("is no-path, not connected, when authorised but the node has no working path to the mesh", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info: { ...info, online: false },
      networks: [net({ status: "OK", name: "yonder-probe", assignedAddresses: ["10.147.20.26/24"] })],
    });
    expect(s.phase).toBe("no-path");
    // The membership is still real: the operator still sees the address and
    // the name, it is only the word "connected" that is withheld.
    expect(s.addresses).toEqual(["10.147.20.26/24"]);
    expect(s.networkName).toBe("yonder-probe");
    expect(s.online).toBe(false);
  });

  it("carries no network name until the device is authorised", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "ACCESS_DENIED" })],
    });
    expect(s.networkName).toBeNull();
  });

  // The controller's address is deterministic - the first ten hex characters
  // of the network id - and it is always a member, so it is the one peer that
  // reliably answers whether *this device's* link to *this network* is direct
  // or bounced through a relay.
  it("reports direct-vs-relayed and latency from the network's controller peer (R-VPN-03)", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      peers: [peer({ address: "9fef8a3bf9", relayed: false, latencyMs: 12 })],
    });
    expect(s.relayed).toBe(false);
    expect(s.latencyMs).toBe(12);
  });

  it("reports relayed and latency as unknown, not guessed, when the controller peer is absent", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      peers: [peer({ address: "notthecontroller" })],
    });
    expect(s.relayed).toBeNull();
    expect(s.latencyMs).toBeNull();
  });

  it("counts LEAF peers that have at least one active path", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      peers: [
        peer({ address: "aaaaaaaaaa", role: "LEAF", paths: [path({ active: true })] }),
        // A relay with nothing active - present in the list, not counted.
        peer({ address: "bbbbbbbbbb", role: "LEAF", paths: [path({ active: false })] }),
        // The root server infrastructure, not a mesh peer.
        peer({ address: "9fef8a3bf9", role: "PLANET", paths: [path({ active: true })] }),
      ],
    });
    expect(s.peerCount).toBe(1);
  });

  it("is the newest lastReceive across every peer's active paths, and null when there are none", () => {
    const withPeers = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      peers: [
        peer({ address: "aaaaaaaaaa", paths: [path({ active: true, lastReceive: 5_000 })] }),
        peer({ address: "bbbbbbbbbb", paths: [path({ active: true, lastReceive: 9_000 }), path({ active: false, lastReceive: 99_000 })] }),
      ],
    });
    expect(withPeers.lastHeardMs).toBe(9_000);

    const withNone = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      peers: [],
    });
    expect(withNone.lastHeardMs).toBeNull();
  });

  it("carries the traffic it was given, and null counters when none was measured", () => {
    const traffic: Traffic = { rxBytes: 1_537_757, txBytes: 405_199 };
    const withTraffic = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      traffic,
    });
    expect(withTraffic.rxBytes).toBe(1_537_757);
    expect(withTraffic.txBytes).toBe(405_199);

    const withoutTraffic = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      traffic: null,
    });
    expect(withoutTraffic.rxBytes).toBeNull();
    expect(withoutTraffic.txBytes).toBeNull();
  });

  it("carries the throughput it was given, and empty when none was measured", () => {
    const throughput: Throughput = {
      rxBitsPerSecond: 1_400_000,
      txBitsPerSecond: 300_000,
      history: [{ rx: 1_200_000, tx: 280_000 }, { rx: 1_400_000, tx: 300_000 }],
    };
    const withThroughput = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
      throughput,
    });
    expect(withThroughput.rxBitsPerSecond).toBe(1_400_000);
    expect(withThroughput.txBitsPerSecond).toBe(300_000);
    expect(withThroughput.throughputHistory).toEqual(throughput.history);

    const withoutThroughput = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK" })],
    });
    expect(withoutThroughput.rxBitsPerSecond).toBeNull();
    expect(withoutThroughput.txBitsPerSecond).toBeNull();
    expect(withoutThroughput.throughputHistory).toEqual([]);
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

  // Three questions, not two, now that the answer needs to know who else is on
  // the mesh. `listpeers` fits the same shape as `listnetworks` above it.
  it("asks three times when a mesh is configured and a client answers", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : argv.includes("listnetworks")
          ? {
            code: 0,
            stdout: JSON.stringify([{
              nwid: "9fef8a3bf9000001",
              name: "",
              status: "ACCESS_DENIED",
              portDeviceName: "ztuqliuo7y",
              assignedAddresses: [],
            }]),
            stderr: "",
          }
          : { code: 0, stdout: "[]", stderr: "" },
    );
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli);
    expect(s.phase).toBe("waiting-for-approval");
    expect(s.deviceId).toBe("9fef8a3bf9");
    expect(h.calls).toEqual([
      ["zerotier-cli", "-j", "info"],
      ["zerotier-cli", "-j", "listnetworks"],
      ["zerotier-cli", "-j", "listpeers"],
    ]);
  });

  // A peer listing that fails is treated the same as an empty one - the same
  // tolerance `listNetworks` already gets - rather than failing the whole
  // route over a detail the operator did not ask for.
  it("tolerates listpeers failing, rather than losing the whole state", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : argv.includes("listnetworks")
          ? {
            code: 0,
            stdout: JSON.stringify([{
              nwid: "9fef8a3bf9000001",
              name: "yonder-probe",
              status: "OK",
              portDeviceName: "ztuqliuo7y",
              assignedAddresses: ["10.147.20.26/24"],
            }]),
            stderr: "",
          }
          : { code: 127, stdout: "", stderr: "command not found" },
    );
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli);
    expect(s.phase).toBe("connected");
    expect(s.peerCount).toBe(0);
  });

  // The interface name comes from the network the configuration names, not
  // from whatever the client happens to list first.
  it("reads traffic for the interface of the configured network, once it is known", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : argv.includes("listnetworks")
          ? {
            code: 0,
            stdout: JSON.stringify([{
              nwid: "9fef8a3bf9000001",
              name: "yonder-probe",
              status: "OK",
              portDeviceName: "ztly52ge2a",
              assignedAddresses: ["10.147.20.26/24"],
            }]),
            stderr: "",
          }
          : { code: 0, stdout: "[]", stderr: "" },
    );
    const seen: string[] = [];
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli, {
      readTraffic: (iface) => {
        seen.push(iface);
        return { rxBytes: 1_537_757, txBytes: 405_199 };
      },
    });
    expect(seen).toEqual(["ztly52ge2a"]);
    expect(s.rxBytes).toBe(1_537_757);
    expect(s.txBytes).toBe(405_199);
  });

  it("never reads traffic when no network has been joined yet", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : { code: 0, stdout: "[]", stderr: "" },
    );
    const readTraffic = () => {
      throw new Error("must not be called");
    };
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli, { readTraffic });
    expect(s.phase).toBe("joining");
    expect(s.rxBytes).toBeNull();
  });

  // The same wiring as readTraffic above, and for the same reason: the
  // sampler is asked about the interface the configured network actually
  // has, not whatever the client happens to list first.
  it("reads throughput for the interface of the configured network, once it is known", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : argv.includes("listnetworks")
          ? {
            code: 0,
            stdout: JSON.stringify([{
              nwid: "9fef8a3bf9000001",
              name: "yonder-probe",
              status: "OK",
              portDeviceName: "ztly52ge2a",
              assignedAddresses: ["10.147.20.26/24"],
            }]),
            stderr: "",
          }
          : { code: 0, stdout: "[]", stderr: "" },
    );
    const seen: string[] = [];
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli, {
      throughput: (iface) => {
        seen.push(iface);
        return { rxBitsPerSecond: 1_400_000, txBitsPerSecond: 300_000, history: [{ rx: 1_400_000, tx: 300_000 }] };
      },
    });
    expect(seen).toEqual(["ztly52ge2a"]);
    expect(s.rxBitsPerSecond).toBe(1_400_000);
    expect(s.txBitsPerSecond).toBe(300_000);
    expect(s.throughputHistory).toEqual([{ rx: 1_400_000, tx: 300_000 }]);
  });

  it("never reads throughput when no network has been joined yet", async () => {
    const h = harness((argv) =>
      argv.includes("info")
        ? { code: 0, stdout: JSON.stringify({ address: "9fef8a3bf9", online: true, version: "1.16.2" }), stderr: "" }
        : { code: 0, stdout: "[]", stderr: "" },
    );
    const throughput = () => {
      throw new Error("must not be called");
    };
    const s = await readRemoteState(config("9fef8a3bf9000001"), h.cli, { throughput });
    expect(s.phase).toBe("joining");
    expect(s.rxBitsPerSecond).toBeNull();
    expect(s.throughputHistory).toEqual([]);
  });
});
