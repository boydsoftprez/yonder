// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, confirmed, fetched, readFailure } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * The shape every node in this package takes.
 *
 * Written once, as `node-red-contrib-yonder-network/src/read.ts` is, because
 * these four nodes differ only in the route they call and the sentence they
 * put on the status. **Nothing here decides anything about a camera**:
 * detection, capability, refusal, composition and the receive line are all
 * `yonder-core`'s, where they have tests that need neither a running Node-RED
 * nor a camera. A node that started deciding would be a decision reviewable
 * only by running a runtime — which is CLAUDE.md rule 2 one layer up.
 *
 * Input-driven, never polled. A camera page reads when the operator opens it
 * or presses a key; a timer here would re-probe the board behind their back,
 * and a probe is subprocesses against the very device the picture comes from.
 */

/** One request, or the reason there is nothing to ask for. */
export type Ask =
  | { method: "GET" | "POST"; path: string; body?: unknown }
  | { refuse: string };

/**
 * Which camera this message is about.
 *
 * The message first, then the node's own configured id. That order is what
 * lets one page's wiring name its camera once, in the node, while a shared
 * flow can still address any of them — and it is the same order
 * `yonder-confirm` takes an apply id in.
 */
export function cameraId(msg: NodeMessage, config: Record<string, unknown>): string | null {
  for (const candidate of [msg.camera, config.camera]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

/** What a node says when nothing named a camera. It calls the daemon nothing. */
export const NO_CAMERA =
  "this control is not pointed at a camera; name one on the node or in the message";

interface AdapterNode extends RedNode {
  client: DaemonClient;
}

export function registerAdapter(
  RED: RED,
  type: string,
  /** Which route this message asks for. Pure — it makes no call of its own. */
  ask: (msg: NodeMessage, config: Record<string, unknown>) => Ask,
  /** One line about the answer, for the node's status badge and the message. */
  describe: (value: unknown) => string,
): void {
  RED.nodes.registerType(type, function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as AdapterNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        // Every path out of here puts a `CommandStatus` on `msg.yonder`
        // (ADR-0005, R-UI-05), so a control means the same thing on every
        // page whether it was fed by a stock widget or a hand-written
        // component. A node inventing its own status text is the drift that
        // language was written to prevent.
        const wanted = ask(msg, config);
        if ("refuse" in wanted) {
          node.status({ fill: "red", shape: "ring", text: "no camera" });
          send({ payload: null, yonder: readFailure(wanted.refuse, Date.now()) });
          done();
          return;
        }

        const result = fetched(await node.client.request({
          method: wanted.method,
          path: wanted.path,
          ...(wanted.body === undefined ? {} : { body: wanted.body }),
        }));
        if (!result.ok) {
          // Never nothing. An operator looking at a panel that is simply
          // blank cannot tell "there is nothing to show" from "this never
          // loaded", and the second is the one they have to act on.
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }

        const said = describe(result.value);
        node.status({ fill: "green", shape: "dot", text: said });
        send({ payload: result.value, yonder: confirmed(said, { at: Date.now() }) });
        done();
      })();
    });
  });
}
