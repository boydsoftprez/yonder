// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, pendingChange, pollIntervalMs } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * `yonder-pending` — a change that will revert, wherever the operator is
 * (R-UI-15, R-CFG-03).
 *
 * The confirmation timer is what makes this device unbrickable. The apply
 * engine has tracked the pending change and its deadline all along, and until
 * this node the console rendered it **only on the page the change was made
 * on** — make a change on the Network page, walk to Status, and nothing said
 * the configuration reverts in ninety seconds unless somebody confirms it.
 *
 * A poller rather than something the apply node emits, and that is the point:
 * the banner has to be right for an operator who arrived after the change,
 * reloaded the browser, or is looking at a second device. `POST /apply`'s
 * answer reaches exactly one page, once.
 *
 * **The countdown is computed here, in words, from `pendingChange()` in
 * yonder-core.** A clock ticking inside `flows.json` would be arithmetic in
 * wiring (CLAUDE.md rule 2) on the one number that decides whether an
 * operator still has a device.
 */

interface PendingNode extends RedNode {
  client: DaemonClient;
  intervalMs: number;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-pending", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as PendingNode;
    node.client = clientFor(RED.settings);
    node.intervalMs = pollIntervalMs(config.interval);

    /**
     * The incoming message is carried through, and that is what makes one key
     * press cost one read.
     *
     * A soft key on the banner arrives here rather than going straight to the
     * confirm or revert node, so the id those act on is read from `/status`
     * at the moment of the press. Which key it was rides on `msg.topic`, which
     * this must not drop — the alternative is a flow caching the id between
     * polls and confirming one it has already watched expire.
     */
    const once = async (msg: NodeMessage, send: (m: NodeMessage) => void): Promise<void> => {
      const shaped = pendingChange(
        await node.client.request({ method: "GET", path: "/status" }),
        Date.now(),
      );
      node.status(
        shaped.yonder.state === "rejected"
          ? { fill: "red", shape: "ring", text: "not answering" }
          : shaped.payload.pending
            ? { fill: "yellow", shape: "dot", text: shaped.yonder.message }
            : { fill: "green", shape: "dot", text: "nothing pending" },
      );
      send({ ...msg, payload: shaped.payload, yonder: shaped.yonder });
    };

    // `void`, not `await`: this runs off a timer, and an unhandled rejection
    // in a Node-RED node takes the runtime down. `DaemonClient.request` never
    // rejects — asserted in yonder-core's client tests — so there is nothing
    // to catch here.
    const timer = setInterval(() => { void once({}, (m) => { node.send(m); }); }, node.intervalMs);

    node.on("input", (msg, send, done) => {
      void once(msg, send).then(() => { done(); });
    });

    // A timer outliving its deployment is a node still asking a daemon
    // questions on behalf of a flow that no longer exists.
    node.on("close", (done) => {
      clearInterval(timer);
      done();
    });

    // One read immediately, so the banner is down — or up — before the first
    // tick. A group's visibility is server-side state that starts unset, which
    // Dashboard reads as *visible*: without this the banner would be on screen
    // for one poll interval on every console start, saying nothing.
    void once({}, (m) => { node.send(m); });
  });
};
