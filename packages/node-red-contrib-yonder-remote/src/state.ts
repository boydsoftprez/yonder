// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { DaemonClient, RemoteState } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * One object per state, so no widget has to know a client's vocabulary.
 *
 * `waiting` is its own field rather than a comparison the page makes, because
 * it is the state this whole surface is shaped around and it is neither a fault
 * nor a connection (R-VPN-06).
 */
export function messageFor(state: RemoteState): {
  payload: {
    label: string;
    waiting: boolean;
    networkId: string | null;
    deviceId: string | null;
    address: string | null;
    detail: string | null;
  };
} {
  const label =
    state.phase === "off"
      ? "Not configured"
      : state.phase === "no-client"
        ? "The mesh client is not installed"
        : state.phase === "joining"
          ? "Joining…"
          : state.phase === "waiting-for-approval"
            ? "Waiting for you to approve it"
            : state.phase === "connected"
              ? "Connected"
              : (state.detail ?? "Fault");

  return {
    payload: {
      label,
      waiting: state.phase === "waiting-for-approval",
      networkId: state.networkId,
      deviceId: state.deviceId,
      address: state.addresses[0] ?? null,
      detail: state.detail,
    },
  };
}

/**
 * `yonder-remote-state` — where the mesh join stands, in an operator's words
 * (R-VPN-01, R-UI-05).
 *
 * A read, shaped by `messageFor` rather than passed through raw: the page
 * that shows this never learns a client's vocabulary (`ACCESS_DENIED`,
 * `REQUESTING_CONFIGURATION`), only the words above.
 */
interface StateNode extends RedNode {
  client: DaemonClient;
}

/**
 * `export default` rather than `export =`: this file also carries the named
 * export `messageFor`, and TypeScript does not allow the two export forms
 * together. Node-RED's loader already unwraps a `__esModule` default export
 * (`r = r.__esModule ? r.default : r` in `@node-red/registry`), which is
 * exactly what `esModuleInterop` produces here, so this registers the same
 * way `export =` does in the sibling packages.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-remote-state", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as StateNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const result = fetched(await node.client.request({ method: "GET", path: "/remote/state" }));
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        const state = result.value as RemoteState;
        node.status({ fill: "green", shape: "dot", text: state.phase });
        send(messageFor(state));
        done();
      })();
    });
  });
};
