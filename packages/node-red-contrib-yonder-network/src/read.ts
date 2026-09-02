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
  /**
   * An optional second message, from the same answer.
   *
   * `yonder-scan` needs one: the same list has to reach a table an operator
   * reads and a dropdown an operator picks from, and a Dashboard form is fed
   * by `msg.ui_update` rather than by its input payload. Two outputs from one
   * request rather than two requests, because on a single-radio board a scan
   * retunes the radio the operator is connected through (K-13) and doing it
   * twice for one button is doing it once too often.
   */
  secondary?: (value: unknown) => Record<string, unknown> | null,
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
          const failed = { payload: null, yonder: readFailure(result.message, Date.now()) };
          send(secondary === undefined ? failed : [failed, null]);
          done();
          return;
        }
        node.status({ fill: "green", shape: "dot", text: describe(result.value) });
        const extra = secondary?.(result.value) ?? null;
        // One send with an array, so a node with one output is unchanged and
        // a node with two gets both in the order its wires are declared.
        send(secondary === undefined
          ? { payload: result.value }
          : [{ payload: result.value }, extra]);
        done();
      })();
    });
  });
}
