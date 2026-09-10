// SPDX-License-Identifier: GPL-3.0-or-later
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * `yonder-mav-endpoints` — the Telemetry page's configured settings
 * (R-UI-17, R-MAV-03, R-MAV-07, R-MAV-08).
 *
 * `mavlink.autocast`, `mavlink.ingest.loopback_only` and `mavlink.endpoints`
 * are configuration, never `/mav/state` — `state.ts`'s own docstring says
 * why the two stay apart, and the plan is explicit that these fields are
 * "deliberately not on `/mav/state`".
 *
 * **Input-driven, off the configuration the flows already read once, exactly
 * the way `node-red-contrib-yonder-modem`'s `yonder-modem-form` reads
 * `network.modem`.** This node holds no `DaemonClient` of its own: the flows
 * already have a `yonder-config` node reading `GET /config` when the console
 * opens, and a second reader of the same document here would be a second
 * read of the same document — worse, one on its own schedule, which is
 * exactly what would show an operator their own half-typed host or port box
 * being overwritten while they are still editing it.
 */

/**
 * `config.mavlink`, as much of it as this node needs to see.
 *
 * Deliberately not `Config["mavlink"]`. This is the shape read out of an
 * answer that may be anything — a failed upstream read sends `payload:
 * null` — and naming the schema type here would invite a cast that says the
 * daemon answered when it did not. `yonder-modem-form`'s own `ModemSection`
 * makes the identical choice for the identical reason.
 */
interface MavlinkSection {
  autocast?: unknown;
  ingest?: { loopback_only?: unknown };
  tcp_server?: { enabled?: unknown; port?: unknown };
  endpoints?: { host?: unknown; port?: unknown }[];
}

function mavlinkSection(value: unknown): MavlinkSection | null {
  if (value === null || typeof value !== "object") return null;
  const mavlink = (value as { mavlink?: unknown }).mavlink;
  if (mavlink === null || typeof mavlink !== "object") return null;
  return mavlink as MavlinkSection;
}

/**
 * A configured value as a box shows it: the string, or an empty box —
 * `yonder-modem-form`'s own `box()` helper, widened to take a port number as
 * readily as a host string, since `ui-text-input` shows both as text.
 *
 * **`""` and never `null`, and for the same reason `yonder-modem-form`'s own
 * comment gives**: a seed that reaches a box as `null` rather than as an
 * empty string risks reading as a real value somewhere downstream, and an
 * unconfigured row is not a row with a value.
 */
function box(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

const ENDPOINT_ROWS = 3;

/**
 * The ingest rail, with the key that is actually in force lit (R-MAV-07).
 *
 * **The rail's own configuration cannot answer this.** `ui-yonder-softkeys`
 * takes its keys from the node in `flows.json` unless a message carries a
 * list, and that static list lights `THIS DEVICE` always — which is right for
 * the shipped default and wrong the moment an operator turns ingest on. The
 * page then reads *Accepting from: Any network* above a rail claiming the
 * opposite, which is the one confusion R-MAV-09 names by hand: *telemetry is
 * off* and *nothing can command the vehicle* are the two facts that get
 * mistaken for each other, and a rail that lies about the second is worse
 * than no rail. The approved mockup
 * (`docs/console/design/telemetry/telemetry-ingest-open.html`) draws
 * `ANY NETWORK` lit and `caution`-toned in exactly this state.
 *
 * The labels, actions and tones are here rather than in the flow for the
 * reason CLAUDE.md rule 2 gives about presentation: a list of captions
 * assembled in a `change` node is a second copy of the rail's vocabulary,
 * going stale beside the first. They match the node's own configuration
 * exactly, so a rail that never receives a message — a device whose
 * configuration could not be read — falls back to the same two keys.
 *
 * Read off the same predicate as the `ingest` word above it, so the two can
 * never disagree.
 */
function ingestKeys(open: boolean): { label: string; action: string; tone: string; active: boolean }[] {
  return [
    { label: "THIS DEVICE", action: "loopback", tone: "act", active: !open },
    { label: "ANY NETWORK", action: "open", tone: "caution", active: open },
  ];
}

/**
 * The TCP server line, told the truth (R-MAV-04, R-MAV-07, R-UI-20).
 *
 * **The port alone is not whether there is a listener.** `router/config.ts`
 * writes `TcpServerPort = mavlink.tcp_server.enabled && !loopback_only ?
 * port : 0`, and `0` is how mavlink-router is told to run no TCP server at
 * all. The two gates are independent and both real: the switch is the
 * operator's own, and the ingest gate is R-MAV-07's, because a listening
 * MAVLink TCP server binds every interface and MAVLink is bidirectional —
 * an accepted connection is an unauthenticated command path to the vehicle,
 * so it is not opened by a switch that never mentioned the network.
 *
 * With the shipped defaults — `enabled: true`, `loopback_only: true` — that
 * means **nothing is bound**, and this line read `:5760 · no clients` on a
 * device with no listener: a port an operator could hand a ground station,
 * and a client count for a socket that does not exist. R-MAV-04 is priority
 * 1 and off out of the box, so the page has to say both that it is off and
 * what would turn it on; saying neither is how it stayed unnoticed.
 *
 * `tcpServing` travels beside the words because the row is half
 * configuration and half measurement — the client count comes from
 * `/mav/state`, joined in `flows.json` — and a count of clients on a socket
 * nothing is listening on is not a measurement of anything. The flow appends
 * it only when there is a server to be on.
 *
 * The gating itself is deliberately **not** what changed. Turning the
 * listener on regardless of ingest would open the command path R-MAV-07
 * exists to keep shut, from a switch whose name says nothing about the
 * network — see `router/config.ts`, which reasons it out where the file is
 * generated.
 */
function tcpServer(mavlink: MavlinkSection, open: boolean): { tcpAddress: string; tcpServing: boolean } {
  const enabled = mavlink.tcp_server?.enabled === true;
  if (enabled && open) return { tcpAddress: `:${box(mavlink.tcp_server?.port)}`, tcpServing: true };
  // Why, not just that — the words the ingest rail directly above already
  // uses, so an operator reads one setting named the same way twice rather
  // than two settings they have to connect themselves.
  return { tcpAddress: enabled ? "Off · ingest is this device only" : "Off", tcpServing: false };
}

/**
 * The eight readings the Telemetry rail and the three ground-station rows
 * show when the page opens (R-UI-17), one per output, in the order the
 * flows wire them:
 *
 * 0. `{ atboot, ingest, tcpAddress, tcpServing, keys }` — the rail's
 *    read-only facts (`tel-atboot`, `tel-ingest`), the TCP server's own address fragment
 *    (`tel-tcp` needs this beside `state.ts`'s own client-count fragment,
 *    since the port is configuration and the client count is a measurement —
 *    two different questions this route answers and `/mav/state` does not),
 *    and the ingest rail's own keys with the one in force lit. `keys` is the
 *    name `ui-yonder-softkeys` reads off `msg.payload`, so the same message
 *    that feeds the two readouts feeds the rail beneath them without a
 *    reshaping node in between — and without the rail's vocabulary being
 *    written down a second time in `flows.json`.
 * 1–6. host-0, port-0, host-1, port-1, host-2, port-2 — each an empty box
 *    when nothing is configured for that row, never a fabricated value —
 *    including the port, on its own. `MavlinkEndpoint` requires `name`,
 *    `host` (min length 1) and `port` together in a `.strict()` object
 *    with no per-field default, so "port set, host unset" is not merely
 *    unseeded, it is unrepresentable in a real `config.yaml` — and
 *    `R-CEL-09` ("no APN is ever suggested, completed or tried on the
 *    operator's behalf") already refuses exactly this kind of invented
 *    convenience for the structurally identical cellular case.
 *
 * `null` on every output when there is nothing to read: a failed upstream
 * read must leave the boxes exactly as they are, because blanking a form on
 * a lost socket looks exactly like a device that has forgotten its own
 * settings — `yonder-modem-form`'s own reasoning, word for word.
 *
 * Pure, and exported for that reason: the whole decision, testable without
 * a Node-RED and without a daemon.
 */
export function endpointsMessage(config: unknown): (NodeMessage | null)[] {
  const mavlink = mavlinkSection(config);
  if (mavlink === null) return Array<null>(1 + ENDPOINT_ROWS * 2).fill(null);

  const open = mavlink.ingest?.loopback_only === false;
  const facts = {
    atboot: mavlink.autocast === true ? "Automatic" : "Manual",
    ingest: open ? "Any network" : "Loopback only",
    ...tcpServer(mavlink, open),
    keys: ingestKeys(open),
  };

  const rows: NodeMessage[] = [];
  for (let i = 0; i < ENDPOINT_ROWS; i += 1) {
    const endpoint = mavlink.endpoints?.[i];
    rows.push({ payload: box(endpoint?.host) }, { payload: box(endpoint?.port) });
  }

  return [{ payload: facts }, ...rows];
}

/**
 * `export default` rather than `export =`: this file also carries the named
 * export `endpointsMessage`, matching `state.ts`, `join.ts` and
 * `yonder-modem-form`'s own reasoning for the same split.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-mav-endpoints", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as RedNode;

    node.on("input", (msg, send, done) => {
      const seeds = endpointsMessage(msg.payload);
      // Never a value, and never a count derived from one, the same
      // reasoning `yonder-modem-form`'s own status carries: this is a
      // configuration, not a credential, but the node status is read off a
      // flow editor and the discipline is worth keeping uniform.
      node.status(seeds[0] === null
        ? { fill: "red", shape: "ring", text: "nothing to read" }
        : { fill: "green", shape: "dot", text: "seeded" });
      send(seeds);
      done();
    });
  });
}
