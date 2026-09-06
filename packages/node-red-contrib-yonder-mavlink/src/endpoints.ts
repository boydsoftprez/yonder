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
  tcp_server?: { port?: unknown };
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
 * The eight readings the Telemetry rail and the three ground-station rows
 * show when the page opens (R-UI-17), one per output, in the order the
 * flows wire them:
 *
 * 0. `{ atboot, ingest, tcpAddress }` — the rail's read-only facts
 *    (`tel-atboot`, `tel-ingest`) and the TCP server's own address fragment
 *    (`tel-tcp` needs this beside `state.ts`'s own client-count fragment,
 *    since the port is configuration and the client count is a measurement —
 *    two different questions this route answers and `/mav/state` does not).
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

  const facts = {
    atboot: mavlink.autocast === true ? "Automatic" : "Manual",
    ingest: mavlink.ingest?.loopback_only === false ? "Any network" : "Loopback only",
    tcpAddress: `:${box(mavlink.tcp_server?.port)}`,
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
