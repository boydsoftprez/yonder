// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-join` — join the Wi-Fi network the operator chose (R-NET-03).
 *
 * Takes `{ ssid, psk }` from a form and posts it to `POST /net/join`, which is
 * where the three things that have to happen together happen: the passphrase
 * into `secrets.yaml`, a reference to it into the configuration, and the whole
 * document through the apply engine. None of that is here, deliberately — a
 * node that merged a configuration would be making a decision, in a Node-RED
 * package, about the document that decides whether the device is reachable.
 *
 * What comes back is an apply, so what this emits is a **pending** command
 * state with the deadline on it, exactly as `yonder-apply` does. On a
 * single-radio board this is the apply that takes the access point away, and
 * `movesRadio` is what tells a page to say so.
 */

interface JoinNode extends RedNode {
  client: DaemonClient;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-join", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as JoinNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        const form = (msg.payload ?? {}) as { ssid?: unknown; psk?: unknown };
        const status = applyStatus(
          await node.client.request({
            method: "POST",
            path: "/net/join",
            // Passed through untouched. The daemon validates the SSID and the
            // passphrase, and a second copy of those rules here is a second
            // copy to keep in step.
            body: { ssid: form.ssid, psk: form.psk },
          }),
          Date.now(),
        );
        node.status({
          fill: status.state === "pending" ? "yellow" : "red",
          shape: status.state === "pending" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        send({ payload: status, yonder: status });
        done();
      })();
    });
  });
};
