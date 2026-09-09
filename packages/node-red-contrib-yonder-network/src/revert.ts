// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, presentation, rejected, revertStatus } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-revert` — put the previous configuration back now (R-UI-15).
 *
 * The other half of `yonder-confirm`, and deliberately its twin rather than a
 * flag on it: confirming and reverting are opposite decisions about the same
 * change, and a single node with a mode is a node whose wiring diagram no
 * longer says which one a wire performs.
 *
 * Nothing here decides anything. The countdown already does this; this is the
 * same rollback taken early, because an operator who has decided the change
 * was wrong should not have to watch a five-minute timer to get their device
 * back — that is the wait during which somebody reaches for the power instead,
 * and a power cycle mid-apply is the case the daemon's own recovery has to
 * clean up after.
 *
 * The id comes from the apply, exactly as `yonder-confirm`'s does. Without one
 * there is nothing to put back, and that is a rejection with a reason rather
 * than a request the daemon will refuse for its own reasons a page cannot
 * explain.
 */

interface RevertNode extends RedNode {
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
  RED.nodes.registerType("yonder-revert", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as RevertNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        const id = idFrom(msg);
        if (id === undefined) {
          const status = rejected(
            "there is no change waiting to be put back",
            { at: Date.now() },
          );
          node.status({ fill: "red", shape: "ring", text: presentation(status.state).label });
          send({ payload: status, yonder: status });
          done();
          return;
        }
        const status = revertStatus(
          await node.client.request({ method: "POST", path: "/revert", body: { id }, timeoutMs: 60000 }),
          Date.now(),
          id,
        );
        node.status({
          fill: status.state === "confirmed" ? "green" : "red",
          shape: status.state === "confirmed" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        send({ payload: status, yonder: status });
        done();
      })();
    });
  });
};
