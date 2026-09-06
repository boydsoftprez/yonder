// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, confirmed, fetched, readFailure } from "yonder-core";
import type { CommandStatus, DaemonClient } from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * The shape every node in this package takes.
 *
 * Written once, as `node-red-contrib-yonder-network/src/read.ts` is, because
 * these four nodes differ only in the route they call and the sentence they
 * put on the status. **Nothing here decides anything about a camera**:
 * detection, capability, refusal, composition and the receive line are all
 * `yonder-core`'s, where they have tests that need neither a running Node-RED
 * nor a camera. A node that started deciding would be a decision reviewable
 * only by running a runtime — which is CLAUDE.md rule 2 one layer up.
 *
 * Input-driven, never polled. A camera page reads when the operator opens it
 * or presses a key; a timer here would re-probe the board behind their back,
 * and a probe is subprocesses against the very device the picture comes from.
 */

/** One request, or the reason there is nothing to ask for. */
export type Ask =
  | {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    /**
     * Which camera this request is about, when it is about one.
     *
     * Carried back out on the answer (see below), because a node emits a
     * fresh message and `msg.camera` does not survive the round trip. Only
     * the camera routes set it; `yonder-cameras` sweeps the board and is
     * about no single camera.
     */
    camera?: string;
  }
  | { refuse: string };

/**
 * Which camera this message is about.
 *
 * The message first, then the node's own configured id. That order is what
 * lets one page's wiring name its camera once, in the node, while a shared
 * flow can still address any of them — and it is the same order
 * `yonder-confirm` takes an apply id in.
 */
export function cameraId(msg: NodeMessage, config: Record<string, unknown>): string | null {
  for (const candidate of [msg.camera, config.camera]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

/** What a node says when nothing named a camera. It calls the daemon nothing. */
export const NO_CAMERA =
  "this control is not pointed at a camera; name one on the node or in the message";

interface AdapterNode extends RedNode {
  client: DaemonClient;
}

export function registerAdapter(
  RED: RED,
  type: string,
  /** Which route this message asks for. Pure — it makes no call of its own. */
  ask: (msg: NodeMessage, config: Record<string, unknown>) => Ask,
  /** One line about the answer, for the node's status badge and the message. */
  describe: (value: unknown) => string,
  /**
   * What state that answer puts the control in, when *read* is the wrong word
   * for it.
   *
   * Every route in this package but one answers a question, and a question
   * answered is `confirmed` — which is the default below. The exception is a
   * settings change: it goes through the apply engine, so its answer may be a
   * change that is **in force and will revert unless it is confirmed**
   * (R-CFG-03). Reporting that as `confirmed` would be the page saying a thing
   * is done while a timer runs to undo it, in the tone that means it is
   * staying — so the one route that can arm a window supplies its own status.
   */
  status?: (value: unknown, said: string, at: number) => CommandStatus,
): void {
  RED.nodes.registerType(type, function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as AdapterNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      void (async () => {
        // Every path out of here puts a `CommandStatus` on `msg.yonder`
        // (ADR-0005, R-UI-05), so a control means the same thing on every
        // page whether it was fed by a stock widget or a hand-written
        // component. A node inventing its own status text is the drift that
        // language was written to prevent.
        const wanted = ask(msg, config);
        if ("refuse" in wanted) {
          node.status({ fill: "red", shape: "ring", text: "no camera" });
          send({ payload: null, yonder: readFailure(wanted.refuse, Date.now()) });
          done();
          return;
        }

        const reply = await node.client.request({
          method: wanted.method,
          path: wanted.path,
          ...(wanted.body === undefined ? {} : { body: wanted.body }),
        });
        const result = fetched(reply);
        if (!result.ok) {
          // Never nothing. An operator looking at a panel that is simply
          // blank cannot tell "there is nothing to show" from "this never
          // loaded", and the second is the one they have to act on.
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          /**
           * **The refusal's own detail, kept.** `fetched()` reduces a
           * non-200 to one sentence, which is right for a status badge and
           * loses the one thing a *form* needs: `POST /cameras/:id/apply`
           * answers `problems` — a message per draft path — precisely so the
           * page can mark the field the operator has to change rather than
           * showing a sentence about a form. Dropped here, that whole design
           * stopped at the route: the deck cleared its draft, the operator
           * retyped everything, and nothing anywhere read `problems`.
           *
           * On the message and not in the payload, because `payload` is
           * `null` on a failure by design (an operator must be able to tell
           * "nothing to show" from "this never loaded") and a widget's own
           * report must not be overwritten by a refusal.
           */
          const problems = (reply.ok ? reply.body : undefined) as
            { problems?: unknown } | undefined;
          send({
            payload: null,
            yonder: readFailure(result.message, Date.now()),
            ...(Array.isArray(problems?.problems) ? { problems: problems.problems } : {}),
            // **Which camera this answer is about.** The node emits a fresh
            // object rather than the message it was given, so `msg.camera`
            // — set by whatever addressed this node — does not survive the
            // round trip on its own. A refusal that does not say which
            // camera it is about is a refusal that can be shown against a
            // different one: `previewFloor` on camera B rendering camera A's
            // "the floor is above the ceiling" beside a perfectly valid
            // value, which is what happened.
            ...(wanted.camera === undefined ? {} : { camera: wanted.camera }),
          });
          done();
          return;
        }

        const said = describe(result.value);
        const at = Date.now();
        const state = status?.(result.value, said, at) ?? confirmed(said, { at });
        node.status({
          fill: state.state === "pending" ? "yellow" : "green",
          shape: "dot",
          text: said,
        });
        send({ payload: result.value, yonder: state });
        done();
      })();
    });
  });
}
