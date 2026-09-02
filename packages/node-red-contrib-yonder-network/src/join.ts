// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation, JOIN_TOPIC } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-join` — join the Wi-Fi network the operator chose (R-NET-03).
 *
 * **Three inputs, one join.** The console cannot ask for this in a single
 * form: `ui-form` has no password field type — its rendered types are text,
 * email, number, multiline, checkbox, switch, date, time and dropdown — so a
 * passphrase typed into one would be on screen in clear. `ui-text-input` does
 * mask, with `mode: "password"`, but it is a separate widget, and separate
 * widgets emit separately.
 *
 * So the network, the passphrase and the button each arrive as their own
 * message, told apart by `msg.topic`, and this node is what holds the two
 * values until the button says go. That state lives here rather than in the
 * flow because a `change` node accumulating a credential in flow context is
 * both logic in wiring (CLAUDE.md rule 2) and a passphrase left lying in a
 * place nothing clears.
 *
 * The passphrase is held in memory only, replaced whenever a new one arrives,
 * and dropped the moment the join is sent. It is never logged and never put
 * on an outgoing message.
 */

interface JoinNode extends RedNode {
  client: DaemonClient;
  chosen: { ssid: string | null; psk: string | null };
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-join", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as JoinNode;
    node.client = clientFor(RED.settings);
    node.chosen = { ssid: null, psk: null };

    node.on("input", (msg, send, done) => {
      void (async () => {
        const topic = typeof msg.topic === "string" ? msg.topic : "";
        const value = typeof msg.payload === "string" ? msg.payload : "";

        if (topic === JOIN_TOPIC.ssid) {
          node.chosen.ssid = value === "" ? null : value;
          node.status({ fill: "grey", shape: "ring", text: node.chosen.ssid ?? "no network chosen" });
          done();
          return;
        }
        if (topic === JOIN_TOPIC.psk) {
          // Never echoed, never logged, never in a status line.
          node.chosen.psk = value === "" ? null : value;
          done();
          return;
        }

        // Anything else is the button. Refuse early and say which half is
        // missing, rather than spending a five-minute confirmation window on
        // an apply that was never going to associate.
        if (node.chosen.ssid === null) {
          node.status({ fill: "red", shape: "ring", text: "choose a network first" });
          send({
            payload: null,
            yonder: { state: "rejected", message: "Choose a network first." },
          });
          done();
          return;
        }

        const body = { ssid: node.chosen.ssid, psk: node.chosen.psk };
        // Dropped here, whatever the daemon says next. A passphrase that has
        // been sent has no reason to still be in this process.
        node.chosen.psk = null;

        const status = applyStatus(
          await node.client.request({ method: "POST", path: "/net/join", body }),
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
