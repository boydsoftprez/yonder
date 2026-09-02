// SPDX-License-Identifier: GPL-3.0-or-later
import { CLIENT_CONNECTION } from "./profiles.js";
import { ping } from "../diag/probe.js";
import type { CommandRunner } from "./runner.js";
import type { NmcliClient } from "./nmcli/client.js";
import type { Clock } from "../apply/types.js";

/**
 * Whether the device actually got onto the network it was told to join
 * (R-CFG-11).
 *
 * This exists because the confirmation it replaces was unusable. Joining a
 * network takes the access point off the air — one radio cannot do both — so
 * the operator loses the console at the moment they press the button. Asking
 * them to confirm meant: find the device again on another network, sign in,
 * navigate back, and click inside the window. Miss it and a **working**
 * configuration is thrown away because somebody was slow finding an IP
 * address. That is a worse failure than the one confirmation exists to catch,
 * and a far more common one.
 *
 * The device can answer the question that actually matters. "Still reachable"
 * is not a human's opinion; it is whether this board holds an address on the
 * new network and can get a packet to its gateway and back. Both are facts
 * available here in a few seconds.
 *
 * **What this deliberately does not prove** is that the *operator* can reach
 * the device — a network that isolates its clients will satisfy every check
 * below and still hide the board from the laptop next to it. R-CFG-11 states
 * that trade rather than hiding it. The recovery in that case is the one it
 * has always been: reach the board another way, or reflash it.
 */

/** How long to wait for DHCP before deciding the join did not take. */
export const ADDRESS_GRACE_MS = 20_000;

/** How often to look while waiting for it. */
export const POLL_MS = 2_000;

export interface JoinedOptions {
  client: NmcliClient;
  runner: CommandRunner;
  clock: Clock;
  log?: (line: string) => void;
  /** Overridable for tests; real callers take the defaults. */
  graceMs?: number;
  pollMs?: number;
}

/** What the check found, in the words the journal and the log will carry. */
export interface JoinedResult {
  ok: boolean;
  reason: string;
}

/**
 * The gateway of the device carrying the Wi-Fi client connection.
 *
 * Read from `nmcli device show`, which reports `IP4.GATEWAY` per device. A
 * client connection with an address and no gateway is a network this device
 * cannot route out of, and for the purpose of "did the join work" that counts
 * as no.
 */
async function clientGateway(client: NmcliClient): Promise<{ device: string; gateway: string } | null> {
  const out = await client.exec([
    "nmcli", "-t", "-f", "GENERAL.DEVICE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY", "device", "show",
  ]);

  // One `FIELD:value` line per fact, devices separated by blank lines.
  let device = "";
  let connection = "";
  let address = "";
  let gateway = "";
  for (const line of out.split("\n")) {
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (field === "GENERAL.DEVICE") {
      device = value;
      connection = ""; address = ""; gateway = "";
    } else if (field === "GENERAL.CONNECTION") {
      connection = value;
    } else if (field.startsWith("IP4.ADDRESS")) {
      address = value;
    } else if (field === "IP4.GATEWAY") {
      gateway = value;
    }
    if (connection === CLIENT_CONNECTION && address !== "" && gateway !== "" && gateway !== "--") {
      return { device, gateway: gateway.split("/")[0] };
    }
  }
  return null;
}

/**
 * Wait for the join to take, or report why it did not.
 *
 * Polls rather than assuming: DHCP on a busy network is not instant, and a
 * check run the moment `nmcli connection up` returns would call a working
 * join a failure. The grace period is the only thing an operator waits on now
 * that the confirmation window is gone, and it is measured in seconds rather
 * than in minutes because nothing here needs a human to do anything.
 */
export async function joinSucceeded(opts: JoinedOptions): Promise<JoinedResult> {
  const log = opts.log ?? (() => {});
  const grace = opts.graceMs ?? ADDRESS_GRACE_MS;
  const poll = opts.pollMs ?? POLL_MS;
  const deadline = opts.clock.now() + grace;

  for (;;) {
    let found: { device: string; gateway: string } | null = null;
    try {
      found = await clientGateway(opts.client);
    } catch (e) {
      // A failure to ask is not evidence of success. Fall through to the
      // deadline and let the apply revert.
      log(`join: could not read the interface state (${(e as Error).message})`);
    }

    if (found !== null) {
      log(`join: ${CLIENT_CONNECTION} has an address; checking the gateway ${found.gateway}`);
      const reply = await ping(found.gateway, { runner: opts.runner, clock: opts.clock, count: 2 });
      if (reply.reachable) {
        return { ok: true, reason: `joined, and the gateway ${found.gateway} answered` };
      }
      return { ok: false, reason: `an address was issued but the gateway ${found.gateway} did not answer` };
    }

    if (opts.clock.now() >= deadline) {
      return { ok: false, reason: "no address on the new network before the grace period ran out" };
    }
    await new Promise<void>((resolve) => opts.clock.setTimer(poll, resolve));
  }
}
