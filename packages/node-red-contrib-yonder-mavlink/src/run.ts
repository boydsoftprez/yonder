// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { DaemonClient, DetectOutcome, MavlinkDetectBody, MavlinkStateBody } from "yonder-core";
import type { RED, RedNode } from "./red.js";
import { formatBaud } from "./format.js";
import { stateMessage } from "./state.js";

/**
 * `yonder-mav-run` — start, stop or re-detect the telemetry link (R-MAV-09,
 * R-MAV-13, R-MAV-16).
 *
 * Three of the five `/mav/*` routes behind one node type, chosen by
 * `config.action`, the same way `yonder-diag`'s `config.probe` chooses
 * between `ping` and `reachable` — a decision the flow designer makes once,
 * in the editor, not a decision this node makes at runtime.
 *
 * **`toggle` is the default, and it is what today's "Stop telemetry" button
 * actually wires to.** R-MAV-09's own words: "one control reading the
 * current state, never an ON beside an OFF". A button configured with an
 * empty payload (`tel-runstop`, as shipped) carries no instruction of its
 * own, so the node reads `GET /mav/state` first and acts on the *opposite*
 * of `telemetryRunning` — not `routerRunning`, which is the trap the plan
 * names explicitly: the two come apart exactly while telemetry is stopped,
 * and asking the wrong one would toggle the wrong way the moment an operator
 * used it.
 *
 * Every action answers with the same `MavlinkStateBody` `state.ts`'s own
 * node reads (`MavlinkDetectBody` for `detect`, which is that body plus
 * `outcome`) — "reflecting the action just taken" — so this reuses
 * `stateMessage` rather than a second, disagreeing formatter, and the page
 * updates on the reply instead of waiting for the next poll.
 */

export type RunAction = "start" | "stop" | "detect" | "toggle";

/**
 * Which of the three routes to call.
 *
 * An explicit action always wins; `toggle` is the only one that consults
 * `telemetryRunning`, and it consults nothing else — not `routerRunning`,
 * which answers a different question (`state.ts`'s own docstring says why
 * the two must not be confused for this exact purpose).
 */
export function chooseAction(configured: RunAction, telemetryRunning: boolean): "start" | "stop" | "detect" {
  if (configured !== "toggle") return configured;
  return telemetryRunning ? "stop" : "start";
}

/**
 * What a re-detect actually found, in one sentence — R-MAV-13's three kinds
 * of nothing, or a link.
 *
 * Silence and noise reuse `mav/check.ts`'s own wording for the identical
 * fact rather than a second, disagreeing sentence about the same sweep —
 * the same discipline `check.ts` node's own docstring in this package
 * follows. `found` is this file's own words: nothing already says them,
 * because nothing before this milestone reported a detection's outcome to
 * an operator directly.
 */
export function outcomeMessage(outcome: DetectOutcome): string {
  if (outcome.kind === "found") {
    const baud = formatBaud(outcome.baud) ?? String(outcome.baud);
    return `${outcome.vehicle} found on ${outcome.device} at ${baud} baud`;
  }
  if (outcome.kind === "silent") {
    return outcome.triedBauds.length === 0
      ? `${outcome.device} could not be opened`
      : "No data on the wire, at any speed";
  }
  return "Bytes on the wire, but no MAVLink frame at any speed";
}

const ROUTE: Record<"start" | "stop" | "detect", string> = {
  start: "/mav/start",
  stop: "/mav/stop",
  detect: "/mav/detect",
};

interface RunNode extends RedNode {
  client: DaemonClient;
  action: RunAction;
}

/**
 * `export default` rather than `export =`, matching `state.ts` and
 * `check.ts` in this package: this file also carries named exports.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-mav-run", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as RunNode;
    node.client = clientFor(RED.settings);
    node.action = config.action === "start" || config.action === "stop" || config.action === "detect"
      ? config.action
      : "toggle";

    node.on("input", (_msg, send, done) => {
      void (async () => {
        let action: "start" | "stop" | "detect" = "start";
        if (node.action === "toggle") {
          const current = fetched(await node.client.request({ method: "GET", path: "/mav/state" }));
          if (!current.ok) {
            node.status({ fill: "red", shape: "ring", text: "not answering" });
            send({ payload: null, yonder: readFailure(current.message, Date.now()) });
            done();
            return;
          }
          action = chooseAction("toggle", (current.value as MavlinkStateBody).telemetryRunning);
        } else {
          action = node.action;
        }

        const result = fetched(
          await node.client.request({ method: "POST", path: ROUTE[action], body: {} }),
        );
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: `${action} failed` });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }

        if (action === "detect") {
          const body = result.value as MavlinkDetectBody;
          node.status({ fill: "green", shape: "dot", text: body.link.phase });
          const shaped = stateMessage(body, Date.now());
          send({ ...shaped, payload: { ...shaped.payload, outcome: outcomeMessage(body.outcome) } });
        } else {
          const body = result.value as MavlinkStateBody;
          node.status({ fill: "green", shape: "dot", text: action === "start" ? "started" : "stopped" });
          send(stateMessage(body, Date.now()));
        }
        done();
      })();
    });
  });
}
