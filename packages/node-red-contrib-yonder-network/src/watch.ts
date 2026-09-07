// SPDX-License-Identifier: GPL-3.0-or-later
import { ConfigWatch, clientFor, fetched, pollIntervalMs } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * `yonder-config-watch` — the saved configuration, whenever it changes
 * (R-UI-20, R-UI-17, R-CFG-03).
 *
 * **The defect.** Every value on this console that comes from `config.yaml`
 * was read once, by an `inject` with `once: true` and no `repeat`, and never
 * again. So an operator who changed a setting kept looking at the old one
 * until somebody redeployed the flows. It was caught on *Accepting from* —
 * the readout saying whether the board takes MAVLink from anything that can
 * reach it or only from itself (R-MAV-07) — where the console went on saying
 * `Loopback only` with `THIS DEVICE` lit after the daemon had opened ingest.
 * K-25 recorded the same fault on a theme dropdown and said the fix belonged
 * "built once for every control". This is that.
 *
 * **Why it is not simply a `repeat` on the inject.** The same read seeds ten
 * boxes an operator types into. Re-seeding them every couple of seconds would
 * overwrite a half-typed ground-station address or APN, which is why that
 * inject was a one-shot and is a real constraint rather than an oversight.
 * So the read repeats and the *emit* does not: `ConfigWatch` in `yonder-core`
 * holds the last document seen, and this sends only when the answer is news.
 * A form is then disturbed at exactly the moment the setting under it moved,
 * which is the moment R-UI-17 wants it to be.
 *
 * **Why a poll rather than a signal from the apply.** `yonder-pending`
 * already reads `GET /status` and knows when an apply reached a terminal
 * state, and hanging this off it was the tempting shape. R-CFG-12 rules it
 * out by name: `mavlink.ingest` is deliberately *not* exempt from the
 * confirmation window, so opening ingest **pends** — and the new
 * configuration is in force for the whole window, up to five minutes
 * (R-CFG-10). A console waiting for the terminal state would hold
 * `Loopback only` on screen for five minutes while the board really was
 * accepting MAVLink from the network. Reading the document says the truth as
 * soon as it is true. It also catches what no apply of this console's ever
 * announces: the rollback the device performs by itself when nobody confirms,
 * a change made from a second browser, and a daemon restarted onto a
 * different file.
 *
 * **No input.** A read this node performs must be free to say nothing, and a
 * button wired to something that may answer nothing is a button that appears
 * broken. `yonder-config` is the input-driven read and stays exactly what the
 * Network page's *Refresh* is wired to.
 *
 * The whole judgement is `ConfigWatch`, which is pure and tested in
 * `yonder-core`. This carries the answer and decides nothing.
 */

/**
 * How long after deployment the seeding read happens.
 *
 * The same second the `inject` node this replaces waited (`onceDelay: 1`),
 * and for the same two reasons: a node has no wires while it is being
 * constructed, and Dashboard's datastore has to exist before a seeded value
 * can be kept for the first browser to arrive.
 */
const SEED_DELAY_MS = 1_000;

interface WatchNode extends RedNode {
  client: DaemonClient;
  intervalMs: number;
}

export = function register(RED: RED): void {
  RED.nodes.registerType("yonder-config-watch", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as WatchNode;
    node.client = clientFor(RED.settings);
    node.intervalMs = pollIntervalMs(config.interval);
    const watch = new ConfigWatch();

    const once = async (): Promise<void> => {
      const result = fetched(await node.client.request({ method: "GET", path: "/config" }));
      if (!result.ok) {
        // **Nothing is sent.** `yonder-config` answers a button and must say
        // something, so it emits `payload: null` and the seeders turn that
        // into "leave every box alone". Here there is no caller waiting, and
        // a daemon that did not answer has not said the configuration
        // changed — so the last good seed stays on the page, which is what a
        // form full of an operator's settings should do when a socket drops.
        node.status({ fill: "red", shape: "ring", text: "not answering" });
        return;
      }
      if (!watch.changed(result.value)) {
        node.status({ fill: "green", shape: "dot", text: "unchanged" });
        return;
      }
      // Never the document, never a fingerprint of it, never a count derived
      // from either: a node status is read off a flow editor, which is the
      // same class of place a credential does not go.
      node.status({ fill: "green", shape: "dot", text: "changed" });
      node.send({ payload: result.value });
    };

    /**
     * The first read is the seed, and it is early rather than immediate.
     *
     * R-UI-17 says a field opens showing its setting, so this cannot wait a
     * whole poll interval — an operator who reached the console first would
     * find every box empty. But it cannot happen inside the constructor
     * either: **a node has no wires yet while it is being built.** Node-RED
     * constructs the nodes and then connects them, and a `send` in between
     * goes nowhere at all, silently. The `inject` this node replaces made the
     * same allowance and made it explicitly — `onceDelay: 1` — and the same
     * second also gives Dashboard's datastore time to exist, which is what a
     * seeded widget needs if the value is to survive to the first browser.
     *
     * The repeat starts after that read rather than alongside it, so the two
     * cannot land together on a console that has only just come up.
     */
    let timer: ReturnType<typeof setInterval> | undefined;
    // `void`, not `await`: these run off timers, and an unhandled rejection
    // in a Node-RED node takes the runtime down. `DaemonClient.request` never
    // rejects — asserted in yonder-core's client tests — so there is nothing
    // to catch here.
    const first = setTimeout(() => {
      void once();
      timer = setInterval(() => { void once(); }, node.intervalMs);
    }, SEED_DELAY_MS);

    // A timer outliving its deployment is a node still asking a daemon
    // questions on behalf of a flow that no longer exists.
    node.on("close", (done) => {
      clearTimeout(first);
      if (timer !== undefined) clearInterval(timer);
      done();
    });
  });
};
