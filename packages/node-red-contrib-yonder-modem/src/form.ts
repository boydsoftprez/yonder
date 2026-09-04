// SPDX-License-Identifier: GPL-3.0-or-later
import type { NodeMessage, RED, RedNode } from "./red.js";

/**
 * What the password box says about itself (R-SEC-10).
 *
 * `ui-text-input` has no placeholder — Dashboard gives it a floating label and
 * nothing else — so the label is where this has to live. It sits inside an
 * empty field, which is exactly where a placeholder would be, and rises to the
 * border once the operator types.
 *
 * The two readings are the whole point. **A password that is set and a
 * password that has never been entered look identical in an empty masked
 * box**, and they mean opposite things: one must be left alone, the other is
 * simply absent. Saying which is true costs nothing and reveals nothing — an
 * operator who can see this box has already signed in, and that a modem has a
 * credential is not the credential.
 */
export const PASSWORD_LABEL = {
  set: "Password — set, leave blank to keep it",
  unset: "Password — optional",
} as const;

/**
 * `network.modem`, as much of it as a form may see.
 *
 * Deliberately not `Config["network"]["modem"]`. This is the shape read out of
 * an answer that may be anything — a failed read sends `payload: null` — and
 * naming the schema type here would invite a cast that says the daemon
 * answered when it did not.
 */
interface ModemSection {
  apn?: unknown;
  username?: unknown;
  dial?: unknown;
  password?: unknown;
}

function modemSection(value: unknown): ModemSection | null {
  if (value === null || typeof value !== "object") return null;
  const network = (value as { network?: unknown }).network;
  if (network === null || typeof network !== "object") return null;
  const modem = (network as { modem?: unknown }).modem;
  if (modem === null || typeof modem !== "object") return null;
  return modem as ModemSection;
}

/**
 * A configured value as a box shows it: the string, or an empty box.
 *
 * **`""` and never `null`, and that is not cosmetic.** `modemRequest` refuses
 * a form with no APN in it — applying a document identical to the one already
 * in force reports success and changes nothing, which is the worst kind of
 * feedback — and it tests for `undefined` and `""`. A `null` seeded from an
 * unconfigured device would sail straight past that guard and be applied,
 * turning the modem on with no APN: the exact failure the guard is for.
 */
function box(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Whether a credential is on file, as one of two fixed strings.
 *
 * Anything other than an absent or null reference counts as set: a device
 * whose configuration carries something under that key has a credential
 * whatever shape it is in, and the honest thing to tell an operator is that
 * leaving the box blank keeps it.
 */
function passwordLabel(password: unknown): string {
  return password === null || password === undefined
    ? PASSWORD_LABEL.unset
    : PASSWORD_LABEL.set;
}

/**
 * The configuration, as the four boxes of the Connection group show it
 * (R-UI-17, R-CEL-12).
 *
 * **The form says what is *configured*; the fact cell above it says what is
 * *in use*.** They are different questions and they are allowed to differ —
 * while an apply is pending the configuration carries the new APN and the
 * connected bearer is still on the previous one — so this reads the
 * configuration and never the modem's state. Papering over the difference
 * would hide the one moment an operator most needs to see both.
 *
 * **The password is never seeded.** `network.modem.password` is a `SecretRef`
 * into secrets.yaml; putting either the credential or the reference to it into
 * a form value is what R-SEC-10 forbids. What the box may carry is whether one
 * exists, which it says in its own label. Every message here is built field by
 * field out of strings — nothing from the configuration is spread into one —
 * so a key added to the schema later cannot arrive on a page by being carried
 * along.
 *
 * Four messages, one per output, in the order the flows wire them: APN, dial,
 * username, password. `null` on every output when there is no configuration to
 * read: a failed read must leave the boxes as they are, because blanking a
 * form on a lost socket looks exactly like a device that has forgotten its own
 * settings.
 *
 * Pure, and exported for that reason: this is the whole decision, testable
 * without a Node-RED and without a daemon.
 */
export function modemForm(config: unknown): (NodeMessage | null)[] {
  const modem = modemSection(config);
  if (modem === null) return [null, null, null, null];
  return [
    { topic: "apn", payload: box(modem.apn) },
    { topic: "dial", payload: box(modem.dial) },
    { topic: "username", payload: box(modem.username) },
    // No payload at all, so the box stays empty and Dashboard's datastore has
    // no value to hand a browser. Only the label travels.
    { topic: "password", ui_update: { label: passwordLabel(modem.password) } },
  ];
}

/**
 * `yonder-modem-form` — what the Connection group's boxes say when the page
 * opens (R-UI-17, R-CEL-12, R-SEC-10).
 *
 * The defect it exists for: the fact cell read `APN ereseller` and every box
 * under it was empty on every load, so one page gave two answers to the same
 * question, an operator correcting an APN had to remember what it was, and one
 * glancing at the form would have concluded the modem was unconfigured while
 * it was plainly connected.
 *
 * **It takes the configuration on its input and asks for nothing.** The flows
 * already read `/config` once when the console opens; a node with a socket
 * client of its own would be a second read of the same document, and a node
 * that polled would show an operator their own half-typed form being
 * overwritten. The read stays where it is, and this shapes its answer.
 *
 * Every judgement is in `modemForm` above, which is pure and tested there.
 * This carries the answer and decides nothing.
 *
 * `export default` rather than `export =`: this file also carries named
 * exports, and TypeScript does not allow the two forms together. Node-RED's
 * loader unwraps a `__esModule` default export, which `esModuleInterop`
 * produces here, so this registers the same way `export =` does in the sibling
 * packages — `state.ts` and `configure.ts` do the same for the same reason.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-modem-form", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as RedNode;

    node.on("input", (msg, send, done) => {
      const seeds = modemForm(msg.payload);
      // Never a value, and never a count derived from one: a node status is
      // read off a flow editor, which is the same class of place a credential
      // does not go.
      node.status(seeds[0] === null
        ? { fill: "red", shape: "ring", text: "nothing to read" }
        : { fill: "green", shape: "dot", text: "seeded" });
      send(seeds);
      done();
    });
  });
}
