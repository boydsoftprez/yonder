// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-remote-leave` — leave the joined ZeroTier network (R-VPN-01).
 *
 * No body: leaving clears the configured network id, and the daemon's
 * `/remote/leave` route needs nothing from the operator to do that.
 */

interface LeaveNode extends RedNode {
  client: DaemonClient;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-remote-leave", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as LeaveNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const status = applyStatus(
          await node.client.request({ method: "POST", path: "/remote/leave", body: {} }),
          Date.now(),
        );
        node.status({
          fill: status.state === "pending" ? "yellow" : "red",
          shape: status.state === "pending" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        send({ payload: status.message, yonder: status });
        done();
      })();
    });
  });
};
