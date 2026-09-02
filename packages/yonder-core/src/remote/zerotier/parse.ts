// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The statuses a real client printed, plus the ones its source can produce.
 *
 * A `string` fallback is deliberate. A client newer than this daemon can
 * report something not in this list, and the status line's job is to keep
 * working — a device that reports an unknown state is far better than a
 * console that throws while an aircraft is in the air. `state.ts` maps
 * anything it does not recognise to the same place a fault goes.
 */
export type ZeroTierStatus =
  | "REQUESTING_CONFIGURATION"
  | "OK"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "PORT_ERROR"
  | "CLIENT_TOO_OLD"
  | "AUTHENTICATION_REQUIRED"
  | (string & {});

export interface ZeroTierInfo {
  /** Ten hex characters. The thing a human approves in the controller. */
  address: string;
  online: boolean;
  version: string;
}

export interface ZeroTierNetwork {
  nwid: string;
  /**
   * **Empty until the device is authorised.** A controller tells a member it
   * has not authorised nothing about the network, so this is `""` in exactly
   * the state the operator most wants it named.
   */
  name: string;
  status: ZeroTierStatus;
  /** The interface, which exists from the moment of joining, addressed or not. */
  portDeviceName: string;
  /** CIDR strings. Empty until authorised. */
  assignedAddresses: string[];
}

function json(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    // Do not quote the output back: this message reaches the journal, and
    // there is no reason to widen what it carries.
    throw new Error(`the ${what} reported by zerotier-cli could not be read as JSON`);
  }
}

export function parseInfo(stdout: string): ZeroTierInfo {
  const raw = json(stdout, "node information") as Record<string, unknown>;
  return {
    address: typeof raw.address === "string" ? raw.address : "",
    online: raw.online === true,
    version: typeof raw.version === "string" ? raw.version : "",
  };
}

export function parseNetworks(stdout: string): ZeroTierNetwork[] {
  const raw = json(stdout, "network list");
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const n = entry as Record<string, unknown>;
    return {
      nwid: typeof n.nwid === "string" ? n.nwid : "",
      name: typeof n.name === "string" ? n.name : "",
      status: typeof n.status === "string" ? n.status : "",
      portDeviceName: typeof n.portDeviceName === "string" ? n.portDeviceName : "",
      assignedAddresses: Array.isArray(n.assignedAddresses)
        ? n.assignedAddresses.filter((a): a is string => typeof a === "string")
        : [],
    };
  });
}
