// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, confirmStatus, presentation, rejected } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-confirm` — the operator saying they can still reach the device
 * (R-CFG-03).
 *
 * The proof a configuration is good is that the operator can still reach the
 * device to say so. That is the whole design, and it is why this is a separate
 * node reached by a separate control rather than something the apply node does
 * on its way out: a confirmation sent by the same request that made the change
 * confirms nothing.
 *
 * The id comes from the apply. Without one there is nothing to confirm, and
 * that is a rejection with a reason rather than a request the daemon will
 * refuse for its own reasons a page cannot explain.
 */

interface ConfirmNode extends RedNode {
  client: DaemonClient;
}

/** The apply id, from wherever the wiring put it. */
function idFrom(msg: { payload?: unknown; yonder?: unknown }): string | undefined {
  for (const candidate of [
    (msg.yonder as { id?: unknown } | undefined)?.id,
    (msg.payload as { id?: unknown } | undefined)?.id,
    msg.payload,
  ]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-confirm", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as ConfirmNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        const id = idFrom(msg);
        if (id === undefined) {
          const status = rejected(
            "there is no change waiting to be confirmed",
            { at: Date.now() },
          );
          node.status({ fill: "red", shape: "ring", text: presentation(status.state).label });
          send({ payload: status, yonder: status, operation: 'confirm' });
          done();
          return;
        }
        const status = confirmStatus(
          await node.client.request({ method: "POST", path: "/confirm", body: { id } }),
          Date.now(),
          id,
        );
        node.status({
          fill: status.state === "confirmed" ? "green" : "red",
          shape: status.state === "confirmed" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        send({ payload: status, yonder: status, operation: 'confirm' });
        done();
      })();
    });
  });
};
