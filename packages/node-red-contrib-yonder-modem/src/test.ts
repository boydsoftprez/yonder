// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, confirmed, fetched, presentation, readFailure, rejected } from "yonder-core";
import type { DaemonClient, PathName } from "yonder-core";
import type { RED, RedNode } from "./red.js";

interface TestNode extends RedNode {
  client: DaemonClient;
}

/**
 * `yonder-reach-test` — "does this path actually reach anything, right now"
 * (R-CEL-09, R-CEL-12).
 *
 * The same `ReachMonitor` the automatic probes use answers this on request;
 * there is deliberately no second way to decide whether a path works, only a
 * second reason to ask it.
 *
 * `msg.payload` is the path name — `ethernet`, `modem` or `wifi_client` —
 * carried through whatever it is, the same trust `yonder-remote-join` places
 * in `msg.payload` for a network id: `POST /reach/test` already refuses
 * anything that is not one of the three, and a second copy of that list here
 * is a copy that stops agreeing with it.
 *
 * **The node status is the only feedback an operator gets that TEST NOW did
 * anything**, because the answer itself travels to the page as data for a
 * lamp to read rather than as words a control prints: grey while the probe
 * is in flight, green once it reached something, red once it did not —
 * including when the daemon itself could not be asked.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-reach-test", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as TestNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        node.status({ fill: "grey", shape: "dot", text: "testing" });
        const now = Date.now();
        const result = fetched(
          await node.client.request({
            method: "POST",
            path: "/reach/test",
            body: { path: msg.payload },
          }),
        );
        if (!result.ok) {
          const status = readFailure(result.message, now);
          node.status({ fill: "red", shape: "ring", text: presentation(status.state).label });
          send({ payload: null, yonder: status });
          done();
          return;
        }
        const { path, reached } = result.value as { path: PathName; reached: boolean };
        const status = reached
          ? confirmed("Reached.", { at: now })
          : rejected("Did not reach anything.", { at: now });
        node.status({
          fill: reached ? "green" : "red",
          shape: reached ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        send({ payload: { path, reached }, yonder: status });
        done();
      })();
    });
  });
}
