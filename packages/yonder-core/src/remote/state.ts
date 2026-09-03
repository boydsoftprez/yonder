// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { Traffic } from "./traffic.js";
import type { Throughput, ThroughputSample } from "./sampler.js";
import type { ZeroTierCli } from "./zerotier/cli.js";
import type { ZeroTierInfo, ZeroTierNetwork, ZeroTierPeer } from "./zerotier/parse.js";

/** What `remoteState` reports when nobody measured a rate this time. */
const NO_THROUGHPUT: Throughput = { rxBitsPerSecond: null, txBitsPerSecond: null, history: [] };

/**
 * The states an operator can be in, as opposed to the states a client reports.
 *
 * `waiting-for-approval` is the one this feature is shaped around: it is
 * neither a fault nor a connection, it is reached in about four seconds, and it
 * is stable for as long as the human takes. Nothing times out of it (R-VPN-06).
 *
 * `joining` is the ambiguous one, and deliberately so. A client that cannot
 * reach a controller and a client given a network id that does not exist both
 * sit in `REQUESTING_CONFIGURATION` indefinitely — a board reported exactly
 * that for twenty seconds against `1234567890abcdef` and would have reported it
 * for ever. Guessing between "still joining" and "that id is wrong" would be
 * wrong every time a board's uplink was merely slow, so this does not guess.
 *
 * `no-path` exists because `OK` lies by omission (R-VPN-10). It means the
 * controller authorised this device and it holds a valid, cached network
 * config — which a client keeps reporting for as long as it exists, whether
 * or not the device can currently reach a single other machine over it. A
 * console that read `status: "OK"` alone said "connected" on an aircraft that
 * had lost every path to the mesh. `connected` now additionally requires the
 * node itself to be online; `no-path` is what an authorised-but-unreachable
 * device is named instead.
 */
export type RemotePhase =
  | "off"
  | "no-client"
  | "joining"
  | "waiting-for-approval"
  | "connected"
  | "no-path"
  | "fault";

export interface RemoteState {
  phase: RemotePhase;
  /** From the configuration, so it is known before the client reports anything. */
  networkId: string | null;
  /** Ten hex characters: what a human approves in the controller. */
  deviceId: string | null;
  addresses: string[];
  interface: string | null;
  /** The client's own word, when the phase is `fault`. Never a secret. */
  detail: string | null;
  /** Empty until the device is authorised (R-VPN-10), so `null` before then. */
  networkName: string | null;
  /** Whether this node has a working path to ZeroTier's infrastructure at all. */
  online: boolean;
  /** `null` when there is no telling — no controller peer to ask. */
  relayed: boolean | null;
  latencyMs: number | null;
  /** Epoch ms: the newest `lastReceive` across every peer's active paths. */
  lastHeardMs: number | null;
  /** LEAF peers — mesh members, not root infrastructure — with an active path. */
  peerCount: number;
  rxBytes: number | null;
  txBytes: number | null;
  /** Bits per second (R-NET-10) — a rate, never the accumulated `rxBytes` above. `null` until two samples exist. */
  rxBitsPerSecond: number | null;
  txBitsPerSecond: number | null;
  /** Oldest first, at most the sampler's history length — what the sparkline draws. */
  throughputHistory: ThroughputSample[];
}

export function remoteState(input: {
  config: Config;
  installed: boolean;
  info: ZeroTierInfo | null;
  networks: ZeroTierNetwork[];
  peers?: ZeroTierPeer[];
  traffic?: Traffic | null;
  throughput?: Throughput;
}): RemoteState {
  const { enabled, network_id } = input.config.remote.zerotier;
  const peers = input.peers ?? [];
  const traffic = input.traffic ?? null;
  const throughput = input.throughput ?? NO_THROUGHPUT;

  const online = input.info?.online === true;

  // Root infrastructure (PLANET, and a MOON should one ever be configured)
  // is not a mesh member, so it never counts as one, however reachable it is.
  const peerCount = peers.filter((p) => p.role === "LEAF" && p.paths.some((path) => path.active)).length;

  const lastHeardMs = peers
    .flatMap((p) => p.paths)
    .filter((path) => path.active)
    .reduce<number | null>(
      (latest, path) => (latest === null || path.lastReceive > latest ? path.lastReceive : latest),
      null,
    );

  const base: RemoteState = {
    phase: "off",
    networkId: null,
    deviceId: input.info?.address ?? null,
    addresses: [],
    interface: null,
    detail: null,
    networkName: null,
    online,
    relayed: null,
    latencyMs: null,
    lastHeardMs,
    peerCount,
    rxBytes: null,
    txBytes: null,
    rxBitsPerSecond: null,
    txBitsPerSecond: null,
    throughputHistory: [],
  };

  // Nothing configured is not a problem to report (R-VPN-05).
  if (!enabled || network_id === null) return base;
  if (!input.installed) return { ...base, phase: "no-client", networkId: network_id };

  const net = input.networks.find((n) => n.nwid === network_id);
  // Configured but not in the client's list: the join has been asked for and
  // has not landed. That is joining, not silence.
  if (net === undefined) return { ...base, phase: "joining", networkId: network_id };

  // The controller's address is deterministic — the first ten hex characters
  // of the network id — and it is always a member of its own network, so it
  // is the one peer that reliably answers whether *this device's* link to
  // *this network* is direct or bounced through a relay (R-VPN-03). If it is
  // absent from the peer list, relayed and latency are unknown, not guessed
  // from some other peer that happens to be present.
  const controller = peers.find((p) => p.address === network_id.slice(0, 10));

  const common = {
    ...base,
    networkId: network_id,
    interface: net.portDeviceName === "" ? null : net.portDeviceName,
    networkName: net.name === "" ? null : net.name,
    relayed: controller ? controller.relayed : null,
    latencyMs: controller ? controller.latencyMs : null,
    rxBytes: traffic?.rxBytes ?? null,
    txBytes: traffic?.txBytes ?? null,
    rxBitsPerSecond: throughput.rxBitsPerSecond,
    txBitsPerSecond: throughput.txBitsPerSecond,
    throughputHistory: throughput.history,
  };

  switch (net.status) {
    case "REQUESTING_CONFIGURATION":
      return { ...common, phase: "joining" };
    case "ACCESS_DENIED":
      return { ...common, phase: "waiting-for-approval" };
    case "OK":
      // R-VPN-10: authorised is not the same as reachable. A cached "OK"
      // survives the loss of every path, so `connected` additionally requires
      // the node itself to be online; an authorised device with no path is
      // `no-path`, not a silent lie.
      return { ...common, phase: online ? "connected" : "no-path", addresses: net.assignedAddresses };
    default:
      // Everything else - NOT_FOUND, PORT_ERROR, CLIENT_TOO_OLD, and anything a
      // newer client invents - is a fault the operator is told the name of.
      return { ...common, phase: "fault", detail: net.status };
  }
}

/**
 * The same state, having asked a client for as little as it can get away with.
 *
 * The console polls this every two to five seconds, depending on the page,
 * for the life of the flight, so what it costs is not a detail. Nothing
 * configured, nothing asked. Otherwise three calls — `info()`,
 * `listNetworks()`, and `listPeers()` — plus, once a network is found and
 * authorised enough to have an interface, one read of that interface's kernel
 * byte counters and one look at the throughput sampler. `installed` is what
 * `info()` already answered rather than a separate probe for it — the client
 * that cannot say who it is cannot list its networks or peers either.
 *
 * `readTraffic` and `throughput` are not called from here directly with a
 * default: they are the I/O in this feature that is not a `zerotier-cli`
 * invocation — a sysfs read and a sampler with its own timer — and this file
 * has no reason to import either merely to hold a fallback nothing here would
 * ever exercise. The daemon passes both in.
 */
export async function readRemoteState(
  config: Config,
  cli: ZeroTierCli,
  opts: {
    readTraffic?: (iface: string) => Traffic | null;
    /** `TrafficSampler.forInterface`, bound by the daemon to its one sampler instance. */
    throughput?: (iface: string) => Throughput;
  } = {},
): Promise<RemoteState> {
  const { enabled, network_id } = config.remote.zerotier;
  if (!enabled || network_id === null) {
    return remoteState({ config, installed: false, info: null, networks: [] });
  }
  const info = await cli.info().catch(() => null);
  if (info === null) return remoteState({ config, installed: false, info: null, networks: [] });
  const networks = await cli.listNetworks().catch(() => []);
  const peers = await cli.listPeers().catch(() => []);

  const net = networks.find((n) => n.nwid === network_id);
  const iface = net?.portDeviceName;
  const hasIface = iface !== undefined && iface !== "";
  const traffic = hasIface && opts.readTraffic ? opts.readTraffic(iface) : null;
  const throughput = hasIface && opts.throughput ? opts.throughput(iface) : undefined;

  return remoteState({ config, installed: true, info, networks, peers, traffic, throughput });
}
