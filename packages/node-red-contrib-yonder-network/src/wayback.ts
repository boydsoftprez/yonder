// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, pollIntervalMs, wayBackInView } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * `yonder-wayback` — how to get back to this device (R-UI-18).
 *
 * Status is the page an operator is looking at while things go wrong, so the
 * way back in belongs on it: which network to join, the passphrase, the
 * address, the name.
 *
 * **The passphrase decision is not in this file, and must never be.** The
 * daemon has already made it — `publishableApPassphrase` in yonder-core
 * compares the stored row against the published default and hands back the
 * *constant* or `null`, never what it read — and `wayBackInView` turns the
 * `null` into words. A node that compared anything itself would be a second
 * place that rule lives, and the second copy is the one that stops matching.
 *
 * A poller rather than something an apply emits, for the same reason
 * `yonder-pending` is one: this has to be right for an operator who arrived
 * after the change, reloaded the browser, or is looking at a second device.
 *
 * It reads the *live* configuration, so during a pending apply it names the
 * hostname the device answers to now rather than the one it will go back to.
 * That is the honest answer for a panel whose job is to say how to reach this
 * device — and it is why the interval is the console's ordinary one rather
 * than something slower: the moment this changes is the moment an operator has
 * just applied a change and is watching.
 */

interface WaybackNode extends RedNode {
  client: DaemonClient;
  intervalMs: number;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-wayback", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as WaybackNode;
    node.client = clientFor(RED.settings);
    node.intervalMs = pollIntervalMs(config.interval);

    /**
     * **A failed read sends nothing**, which is this node's one departure
     * from "never a silent nothing" and is the whole point of it.
     *
     * Elsewhere a failed read raises a rejected state because a stale reading
     * is a lie. There is no reading here. The network to join and the address
     * to open do not stop being true because the daemon missed a poll, and
     * this is the one panel on the page that exists to still be useful when
     * things have gone wrong — so blanking it at the first sign of trouble
     * would be exactly backwards. The node's own status pill says the read
     * failed, and every other panel on the page already reports a daemon that
     * has gone quiet.
     */
    const once = async (send: (m: NodeMessage) => void): Promise<void> => {
      const shaped = wayBackInView(
        await node.client.request({ method: "GET", path: "/status" }),
        Date.now(),
      );
      if (shaped.payload === undefined) {
        node.status(shaped.yonder.state === "rejected"
          ? { fill: "red", shape: "ring", text: "not answering" }
          : { fill: "grey", shape: "ring", text: "no way back in reported" });
        return;
      }
      node.status({ fill: "green", shape: "dot", text: shaped.payload.join });
      send({ payload: shaped.payload, yonder: shaped.yonder });
    };

    // `void`, not `await`: this runs off a timer, and an unhandled rejection
    // in a Node-RED node takes the runtime down. `DaemonClient.request` never
    // rejects — asserted in yonder-core's client tests — so there is nothing
    // to catch here.
    const timer = setInterval(() => { void once((m) => { node.send(m); }); }, node.intervalMs);

    node.on("input", (_msg, send, done) => {
      void once(send).then(() => { done(); });
    });

    // A timer outliving its deployment is a node still asking a daemon
    // questions on behalf of a flow that no longer exists.
    node.on("close", (done) => {
      clearInterval(timer);
      done();
    });

    // One read immediately, so the panel is populated before the first tick
    // rather than a bar of em dashes for the length of the interval.
    void once((m) => { node.send(m); });
  });
};
