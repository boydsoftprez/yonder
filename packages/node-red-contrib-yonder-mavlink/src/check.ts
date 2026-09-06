// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { CheckLink, DaemonClient, PathCheck } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-mav-check` — the path check, drawn as a chain (R-DIA-04).
 *
 * `GET /mav/check` is already decided. `pathCheck` in `yonder-core`
 * (`mav/check.ts`) is a pure function with its own tests, and it has already
 * chosen `true`/`false`/`null` for `ok` and written the sentence for
 * `detail`. **This node does not re-derive any of that wording** — if a
 * sentence is wrong, it is wrong in `check.ts`. All that is left to decide
 * here is the mark, which is drawn from `ok` alone: `OK` for `true`, `✕` for
 * `false`, and `—` for `null` — a dash, never a cross, for a link nobody
 * attempted.
 */

/** `OK` · `✕` · `—` — never a cross for a link nobody attempted (R-DIA-04). */
function mark(ok: boolean | null): string {
  if (ok === true) return "OK";
  if (ok === false) return "✕";
  return "—";
}

function line(link: CheckLink): string {
  return `${mark(link.ok)} · ${link.detail}`;
}

/**
 * The three rows the rail's Path check panel shows, each `${mark} ·
 * ${detail}` — `tel-chain-1..3`'s exact shape in `flows/flows.json`'s own
 * mocks, though not their exact words: those are a rough placeholder for
 * a page layout, and `pathCheck`'s real sentences are longer and more
 * specific. The plan is explicit that this is expected and correct.
 */
export function messageFor(check: PathCheck): {
  payload: { autopilot: string; outbound: string; inbound: string };
} {
  return {
    payload: {
      autopilot: line(check.autopilot),
      outbound: line(check.outbound),
      inbound: line(check.inbound),
    },
  };
}

interface CheckNode extends RedNode {
  client: DaemonClient;
}

/**
 * `export default` rather than `export =`, matching `state.ts` and
 * `node-red-contrib-yonder-remote`'s own `state.ts` for the same reason:
 * this file also carries the named export `messageFor`.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-mav-check", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as CheckNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const result = fetched(await node.client.request({ method: "GET", path: "/mav/check" }));
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        const check = result.value as PathCheck;
        const allOk = check.autopilot.ok === true && check.outbound.ok === true && check.inbound.ok === true;
        node.status({
          fill: allOk ? "green" : "yellow",
          shape: "dot",
          text: allOk ? "checked" : "see rail",
        });
        send(messageFor(check));
        done();
      })();
    });
  });
}
