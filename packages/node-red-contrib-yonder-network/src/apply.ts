// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-apply` — post a configuration and start the confirmation clock
 * (R-CFG-03, R-UI-05).
 *
 * The one node in this milestone that changes anything, and therefore the one
 * whose reporting matters most. A successful apply is **pending**, never done:
 * the change is in force and reverts unless the operator confirms it from the
 * other side. `applyStatus` in `yonder-core` decides that, and it decides the
 * wording too — including the different wording for an apply that moves the
 * Wi-Fi radio, which is the one that takes the access point away from under
 * the operator.
 *
 * The whole configuration goes on the wire, not a patch. The daemon validates
 * a complete document and snapshots it as the rollback target, and a node that
 * sent a fragment would be a node that had to know how to merge one — which is
 * a decision, in a node, about the shape of the thing that decides whether the
 * device is reachable.
 */

interface ApplyNode extends RedNode {
  client: DaemonClient;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-apply", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as ApplyNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        const reply = await node.client.request({
          method: "POST",
          path: "/apply",
          body: msg.payload,
        });
        const status = applyStatus(reply, Date.now());
        const shown = presentation(status.state);
        node.status({
          fill: status.state === "pending" ? "yellow" : "red",
          shape: status.state === "pending" ? "dot" : "ring",
          text: shown.label,
        });
        // The status travels on `msg.yonder` in every node in both packages,
        // so a control renders the same wherever it came from (ADR-0005).
        send({ payload: status, yonder: status });
        done();
      })();
    });
  });
};
