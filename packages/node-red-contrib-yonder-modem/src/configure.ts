// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, clientFor, presentation, rejected } from "yonder-core";
import type { DaemonClient } from "yonder-core";
import type { RED, RedNode } from "./red.js";

/**
 * What the operator has put into the Connection group's fields, whatever
 * that is right now.
 *
 * This is `msg.payload` after a `change` node in `flows.json` has folded the
 * APN, dial number, username and password inputs into one object — this node
 * does not read a form itself, the same separation `yonder-apply` keeps
 * between reading a page and sending what it read.
 */
export interface ModemFields {
  apn?: string | null;
  username?: string | null;
  password?: string | null;
  dial?: string | null;
}

/** The body `POST /modem/configure` merges into `network.modem`. */
export interface ModemRequestBody {
  enabled: true;
  apn: string;
  username?: string;
  password?: string;
  dial?: string;
}

/**
 * The three rules that keep a half-filled form from doing the wrong thing
 * (R-CEL-12).
 *
 * 1. **An empty box is not an instruction to clear a setting.** `username`,
 *    `password` and `dial` are sent only when the operator actually put
 *    something in them; an untouched password box must never overwrite a
 *    working credential with the empty string.
 * 2. **Typing an APN is asking for the modem to be used.** `enabled: true`
 *    travels with it — there is no separate switch to remember to flip.
 * 3. **No APN, no request.** Without one, the merged body is indistinguishable
 *    from the configuration already in force: the daemon would apply it,
 *    report success, and change nothing at all — the worst kind of feedback,
 *    because it looks like it worked.
 *
 * **What R-UI-17 changed, and what it did not.** The boxes are now seeded from
 * `network.modem` when the page opens, so an *untouched* box holds the current
 * value rather than being empty, and the ordinary CONNECT restates the
 * configuration rather than sending three-quarters of it. Rule 1 is unchanged
 * and still right for the password, which `modemForm` never seeds: an empty
 * masked box means the operator did not enter one, and the stored credential
 * stays.
 *
 * For the three seeded boxes the rule now has an edge it did not have before.
 * An operator who *deliberately clears* a username they can see is asking for
 * it to be removed, and rule 1 drops the field instead, so the setting
 * survives and the form says it did not. Reading that intention needs the node
 * to know what it seeded — which is a decision about what an empty box means,
 * not a bug to fix quietly. It is recorded rather than guessed at; nothing
 * here has changed behaviour for it.
 *
 * `apn` is checked for being a string rather than for being `undefined` or
 * `""`, because a seed from an unconfigured device is `null` in the
 * configuration and `null` is neither. `modemForm` converts it to `""` on the
 * way out for the same reason; this is the second lock on the same door.
 *
 * Pure, and exported for that reason: this is the one decision in the node
 * worth testing on its own, without a Node-RED and without a daemon.
 */
export function modemRequest(fields: ModemFields): ModemRequestBody {
  if (typeof fields.apn !== "string" || fields.apn === "") {
    throw new Error("the modem needs an APN before there is anything to configure");
  }
  const body: ModemRequestBody = { enabled: true, apn: fields.apn };
  if (fields.username) body.username = fields.username;
  if (fields.password) body.password = fields.password;
  if (fields.dial) body.dial = fields.dial;
  return body;
}

interface ConfigureNode extends RedNode {
  client: DaemonClient;
}

/**
 * `yonder-modem-configure` — the Connection group's CONNECT softkey
 * (R-CEL-12).
 *
 * Merges the operator's fields into the modem section the same way
 * `yonder-remote-join` merges a network id: a partial section in, a whole
 * document applied, and the response is the apply's status, never the
 * configuration. `POST /modem/configure` never returns `gsm.password`
 * (R-SEC-10), and this node never puts it anywhere either — not in
 * `msg.yonder`, not in a `node.status()` text, not in an error. Every path
 * out of this node, including the one where `modemRequest` refuses to send
 * anything, carries a `CommandStatus` built from Yonder's own words, never
 * the value that was in the password box.
 *
 * As with `yonder-apply`: **a successful apply is pending, not done.** The
 * change is in force and reverts unless it is confirmed from the other side.
 *
 * `export default` rather than `export =`: this file also carries named
 * exports (`modemRequest` and its types), and TypeScript does not allow the
 * two forms together. Node-RED's loader unwraps a `__esModule` default
 * export, which `esModuleInterop` produces here, so this registers the same
 * way `export =` does in the sibling packages — `state.ts` in this package
 * does the same for the same reason.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-modem-configure", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as ConfigureNode;
    node.client = clientFor(RED.settings);

    node.on("input", (msg, send, done) => {
      let body: ModemRequestBody;
      try {
        body = modemRequest((msg.payload ?? {}) as ModemFields);
      } catch (err) {
        // Refused before anything was sent — `modemRequest` throws on a form
        // with no APN in it, and there is no daemon call to make about that.
        const status = rejected((err as Error).message, { at: Date.now() });
        node.status({ fill: "red", shape: "ring", text: presentation(status.state).label });
        send({ payload: status, yonder: status });
        done();
        return;
      }
      void (async () => {
        const status = applyStatus(
          await node.client.request({ method: "POST", path: "/modem/configure", body }),
          Date.now(),
        );
        node.status({
          fill: status.state === "pending" ? "yellow" : "red",
          shape: status.state === "pending" ? "dot" : "ring",
          text: presentation(status.state).label,
        });
        // The status travels on `msg.yonder` in every node in both packages,
        // so a control renders the same wherever it came from (ADR-0005).
        send({ payload: status, yonder: status });
        done();
      })();
    });
  });
};
