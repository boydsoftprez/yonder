// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { ZeroTierCli } from "./zerotier/cli.js";
import type { ZeroTierInfo, ZeroTierNetwork } from "./zerotier/parse.js";

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
 */
export type RemotePhase =
  | "off"
  | "no-client"
  | "joining"
  | "waiting-for-approval"
  | "connected"
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
}

export function remoteState(input: {
  config: Config;
  installed: boolean;
  info: ZeroTierInfo | null;
  networks: ZeroTierNetwork[];
}): RemoteState {
  const { enabled, network_id } = input.config.remote.zerotier;
  const base: RemoteState = {
    phase: "off",
    networkId: null,
    deviceId: input.info?.address ?? null,
    addresses: [],
    interface: null,
    detail: null,
  };

  // Nothing configured is not a problem to report (R-VPN-05).
  if (!enabled || network_id === null) return base;
  if (!input.installed) return { ...base, phase: "no-client", networkId: network_id };

  const net = input.networks.find((n) => n.nwid === network_id);
  // Configured but not in the client's list: the join has been asked for and
  // has not landed. That is joining, not silence.
  if (net === undefined) return { ...base, phase: "joining", networkId: network_id };

  const common = {
    ...base,
    networkId: network_id,
    interface: net.portDeviceName === "" ? null : net.portDeviceName,
  };

  switch (net.status) {
    case "REQUESTING_CONFIGURATION":
      return { ...common, phase: "joining" };
    case "ACCESS_DENIED":
      return { ...common, phase: "waiting-for-approval" };
    case "OK":
      return { ...common, phase: "connected", addresses: net.assignedAddresses };
    default:
      // Everything else - NOT_FOUND, PORT_ERROR, CLIENT_TOO_OLD, and anything a
      // newer client invents - is a fault the operator is told the name of.
      return { ...common, phase: "fault", detail: net.status };
  }
}

/**
 * The same state, having asked a client for as little as it can get away with.
 *
 * The console polls this every five seconds for the life of the flight, so
 * what it costs is not a detail. It asked three times — `installed()`, which
 * runs `zerotier-cli -j info`; `info()`, which runs it again; and
 * `listNetworks()` — regardless of whether a mesh was configured at all. On
 * the shipped default that is roughly fifty thousand `execFile` spawns a day,
 * every one of them an ENOENT, to produce a state `remoteState` decides is
 * `off` from the configuration alone before it looks at any of them.
 *
 * So: nothing configured, nothing asked. Otherwise two calls, and `installed`
 * is what `info()` already answered rather than a separate probe for it — the
 * client that cannot say who it is cannot list its networks either, and a
 * second question with the same answer is a second subprocess.
 */
export async function readRemoteState(config: Config, cli: ZeroTierCli): Promise<RemoteState> {
  const { enabled, network_id } = config.remote.zerotier;
  if (!enabled || network_id === null) {
    return remoteState({ config, installed: false, info: null, networks: [] });
  }
  const info = await cli.info().catch(() => null);
  if (info === null) return remoteState({ config, installed: false, info: null, networks: [] });
  const networks = await cli.listNetworks().catch(() => []);
  return remoteState({ config, installed: true, info, networks });
}
