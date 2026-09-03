// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-remote-join` — join the ZeroTier network the operator named
 * (R-VPN-01).
 *
 * A network id is not a secret — it is the name of a network, not a way into
 * one — so unlike `yonder-join`'s SSID and passphrase, this node holds no
 * state between messages: `msg.payload` is posted as it arrives.
 *
 * The network id is not validated here. `POST /remote/join` already refuses
 * anything that is not sixteen lowercase hexadecimal characters, and a second
 * copy of that rule in this node is how the two stop agreeing.
 */

interface JoinNode extends RedNode {
  client: DaemonClient;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-remote-join", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as JoinNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        const status = applyStatus(
          await node.client.request({
            method: "POST",
            path: "/remote/join",
            body: { networkId: msg.payload },
          }),
          Date.now(),
        );
        node.status({
          fill: status.state === "pending" ? "yellow" : "red",
          shape: status.state === "pending" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        // `payload` is what a page displays; the whole state stays on
        // `msg.yonder` for anything that needs more than words.
        send({ payload: status.message, yonder: status });
        done();
      })();
    });
  });
};
