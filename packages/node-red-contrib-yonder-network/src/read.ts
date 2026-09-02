// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * The shape both read-only nodes in this package take.
 *
 * `yonder-config` and `yonder-scan` differ only in the route they read, so
 * the adapter is written once. Input-driven rather than polled: reading the
 * configuration on a timer would show an operator their own half-typed form
 * being overwritten, and scanning on a timer would retune the radio behind
 * their back — on a single-radio board that is the radio they are connected
 * through (K-13).
 */

interface ReadNode extends RedNode {
  client: DaemonClient;
}

export function registerReader(
  RED: RED,
  type: string,
  path: string,
  describe: (value: unknown) => string,
): void {
  RED.nodes.registerType(type, function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as ReadNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const result = fetched(await node.client.request({ method: "GET", path }));
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        node.status({ fill: "green", shape: "dot", text: describe(result.value) });
        send({ payload: result.value });
        done();
      })();
    });
  });
}
