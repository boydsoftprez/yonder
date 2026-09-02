// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, pollIntervalMs, readFailure } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * The one thing both polling nodes in this package do.
 *
 * Read a route on a timer and on demand, send what came back, and say
 * something when it did not. Written once here rather than twice in two node
 * files, because the second copy is the one that stops matching the first —
 * and "a node whose daemon call fails emits a rejected state, never a silent
 * nothing" is a property that has to hold for every node, not most of them.
 *
 * There is no decision in this file. The floor on the interval, the meaning
 * of a reply and the wording of a failure all come from `yonder-core`, where
 * they are tested without a Node-RED.
 */

export interface PollOptions {
  /** The route to read, including any query string. */
  path: (node: PollingNode) => string;
  /**
   * Given the body, what to put on the outgoing message — or `undefined` to
   * send nothing at all this tick.
   *
   * Sending nothing is not the same as sending an empty list, and Dashboard's
   * table makes the difference load-bearing. `ui_table.js` appends with:
   *
   *     payload = payload && payload.length > 0
   *       ? [...existing, ...payload] : payload
   *
   * so an empty array falls through and **overwrites the store with it**. A
   * log that polls for new lines and finds none would therefore erase itself
   * on every quiet tick, which is exactly what an operator saw: entries
   * appearing and then flashing out again before they could be read.
   */
  payload: (value: unknown, node: PollingNode) => unknown;
  /** Called after a successful read, so a node can advance a cursor. */
  seen?: (value: unknown, node: PollingNode) => void;
  /** What the node's status pill says when a read succeeded. */
  describe?: (value: unknown) => string;
}

export interface PollingNode extends RedNode {
  client: DaemonClient;
  intervalMs: number;
  /** Node-specific state — the activity log's cursor lives here. */
  cursor: number;
}

/**
 * Register a node that reads one route.
 *
 * The timer starts on registration and is cleared on `close`. A node whose
 * timer outlives its deployment is a node still asking a daemon questions on
 * behalf of a flow that no longer exists — the same reason `FallbackWatchdog`
 * and `NetworkRenderer` both have a stop.
 */
export function registerPoller(RED: RED, type: string, opts: PollOptions): void {
  RED.nodes.registerType(type, function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as PollingNode;
    node.client = clientFor(RED.settings);
    node.intervalMs = pollIntervalMs(config.interval);
    node.cursor = 0;

    const once = async (send: (m: NodeMessage) => void): Promise<void> => {
      const reply = await node.client.request({ method: "GET", path: opts.path(node) });
      const result = fetched(reply);
      if (!result.ok) {
        // Never a silent nothing. An operator looking at a blank panel cannot
        // tell "there is nothing to show" from "this never loaded", and the
        // second is the one they have to act on (R-UI-05).
        node.status({ fill: "red", shape: "ring", text: "not answering" });
        send({ payload: null, yonder: readFailure(result.message, Date.now()) });
        return;
      }
      opts.seen?.(result.value, node);
      node.status({ fill: "green", shape: "dot", text: opts.describe?.(result.value) ?? "ok" });
      const payload = opts.payload(result.value, node);
      if (payload === undefined) return;
      send({ payload });
    };

    // `void`, not `await`: this runs off a timer and off an input handler, and
    // an unhandled rejection in a Node-RED node takes the runtime down.
    // `DaemonClient.request` never rejects, so there is nothing to catch —
    // asserted in yonder-core's client tests.
    const timer = setInterval(() => { void once((m) => { node.send(m); }); }, node.intervalMs);

    node.on("input", (_msg, send, done) => {
      void once(send).then(() => { done(); });
    });

    node.on("close", (done) => {
      clearInterval(timer);
      done();
    });

    // One read immediately, so a page shows something before the first tick.
    void once((m) => { node.send(m); });
  });
}
