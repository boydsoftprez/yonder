// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * `yonder-diag` — ping a host, or check reachability (R-DIA-01, R-DIA-02).
 *
 * Input-driven, never polled. A probe sends packets off this device, and
 * Yonder does not contact anything off the device on its own — it happens
 * when an operator presses something, and only then.
 *
 * The host is not validated here. It is validated in `yonder-core`, at the
 * point it arrives from the operator and again at the route, because that is
 * where the rule belongs and a third copy in a node is a third copy to keep
 * in step. This node's job is to carry the string and to render whatever the
 * daemon says about it.
 */

interface DiagNode extends RedNode {
  client: DaemonClient;
  probe: string;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-diag", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as DiagNode;
    node.client = clientFor(RED.settings);
    // "ping" or "reachable". A value that is neither is treated as
    // reachability, which sends nothing an operator did not ask for.
    node.probe = config.probe === "ping" ? "ping" : "reachable";

    node.on("input", (msg, send, done) => {
      void (async () => {
        const request = node.probe === "ping"
          ? {
            method: "POST",
            path: "/diag/ping",
            body: {
              host: typeof msg.payload === "string" ? msg.payload : (msg as { host?: unknown }).host,
              ...(typeof (msg as { count?: unknown }).count === "number"
                ? { count: (msg as { count: number }).count }
                : {}),
            },
          }
          : { method: "GET", path: "/diag/reachable" };

        const result = fetched(await node.client.request(request));
        if (!result.ok) {
          // Never a silent nothing: a probe that did not run and a host that
          // did not answer are different facts and an operator has to be able
          // to tell them apart (R-UI-05).
          node.status({ fill: "red", shape: "ring", text: "probe failed" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        const reachable = (result.value as { reachable?: unknown } | undefined)?.reachable === true;
        node.status({
          fill: reachable ? "green" : "yellow",
          shape: "dot",
          text: reachable ? "replied" : "no reply",
        });
        send({ payload: result.value } as NodeMessage);
        done();
      })();
    });
  });
};
