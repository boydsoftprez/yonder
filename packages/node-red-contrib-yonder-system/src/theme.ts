// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RedNode, RED } from "./red.js";

/**
 * `yonder-theme` — choose the day or the night palette (R-UI-07).
 *
 * Posts the chosen name to `POST /ui/theme`, which reads the configuration,
 * sets one field of a copy of it, and puts the whole document through the
 * apply engine. None of that is here, for the reason `yonder-join` gives: a
 * node that merged a field into a configuration would be making a decision,
 * in a Node-RED package, about the document that decides whether the device
 * is reachable.
 *
 * It replaced wiring that did exactly that, and was wrong in a way no page
 * could show. Two `change` nodes held the last configuration in
 * `flow.yonderConfig`, copied it into the message and assigned
 * `payload.ui.theme` — and Node-RED's change node stores and reads flow
 * context by reference, so all three steps addressed one object. Choosing a
 * theme edited the cache in place whether or not the apply was confirmed, and
 * a revert left the cache holding a theme the device did not have. The old
 * wiring also had to *have* a cached configuration, so a deploy that happened
 * while the daemon was down left the control failing until someone pressed
 * Refresh on a different page.
 *
 * This reads nothing and caches nothing. The daemon holds the configuration,
 * which is the only place it was ever true.
 */

interface ThemeNode extends RedNode {
  client: DaemonClient;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-theme", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as ThemeNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        // A dropdown sends the bare string; a form sends `{theme}`. Neither is
        // checked here — the daemon holds the list of what a theme may be, and
        // a second copy of it in a node is a second copy to keep in step.
        const chosen = typeof msg.payload === "string"
          ? msg.payload
          : (msg.payload as { theme?: unknown } | null | undefined)?.theme;

        const status = applyStatus(
          await node.client.request({ method: "POST", path: "/ui/theme", body: { theme: chosen } }),
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
