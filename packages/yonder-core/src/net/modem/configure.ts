// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { ConfigSchema, type Config } from "../../schema/config.js";
import type { SecretSink } from "../join.js";

/**
 * Turning "use this SIM" into a configuration (R-CEL-02, R-CEL-12).
 *
 * The same shape `joinNetwork` has, for the same reason and with the same
 * split. A browser form produces four strings; the apply engine takes a whole
 * configuration document, because that is what it validates and what it
 * snapshots as the rollback target. The step in between is here rather than
 * in a page (CLAUDE.md rule 2).
 *
 * **The password is the half that needed this function to exist.** A form
 * sends what the operator typed — a string. `network.modem.password` in the
 * configuration is a `SecretRef`, because `config.yaml` is `0644` and travels
 * in a support bundle while `secrets.yaml` is `0600 root` and does not. Those
 * two shapes are different on purpose, and until this existed nothing
 * converted between them: a typed password failed the schema and the route
 * refused the whole body, so an operator who filled the password box lost the
 * APN they had typed beside it as well (R-CEL-02 is priority 1).
 */

/** The name the modem's password is stored under in secrets.yaml. */
export const MODEM_PASSWORD_SECRET = "modem_password";

/**
 * Long enough for any credential a carrier issues, and bounded so that a body
 * cannot make this daemon store an arbitrary amount of text under a name it
 * chose. The same reasoning as `join.ts`'s WPA2 bounds, without a standard to
 * borrow the numbers from: APN credentials have no defined maximum, so this
 * is a sanity limit rather than a rule about what is valid.
 */
const MAX_PASSWORD = 256;

/**
 * What a form may send.
 *
 * Derived from the schema's own modem section rather than restated as a
 * second list of fields, so a key added to the configuration is accepted here
 * without anybody remembering to add it twice — and `.strict()` travels with
 * it, so a key nobody added is still refused.
 *
 * `password` is the one field overridden, and the override is the point: at
 * this boundary it is the operator's typed string, not the reference the file
 * holds. `configureModem` is what converts one into the other.
 *
 * `network.modem` is declared as `Modem.default({})`, so the shape at this
 * path is a `ZodDefault`, not the object itself — `.removeDefault()` is what
 * gets back to the object `.partial()` can act on.
 */
export const ModemRequest = ConfigSchema.shape.network.shape.modem
  .removeDefault()
  .partial()
  .extend({ password: z.string().max(MAX_PASSWORD).nullable().optional() });

export type ModemRequest = z.infer<typeof ModemRequest>;

export type ModemConfigureResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/**
 * The configuration this device should have in order to use that SIM.
 *
 * The whole document, with `network.modem` merged and everything else left
 * exactly as it was.
 *
 * **What each password value means**, and the three are deliberately not the
 * same answer:
 *
 *   - a **string** — store it, and reference it. This is the case R-CEL-02
 *     asks for and the one that did not work.
 *   - **absent, or empty** — leave the stored credential alone. `configure.ts`
 *     states this rule in words for the console side ("an untouched password
 *     box must never overwrite a working credential"); it is held here too,
 *     because the socket is the boundary and a rule kept only by the caller
 *     is not one.
 *   - **null** — the configuration's own word for "there is no password", so
 *     an explicit null clears the reference. Nothing on the console sends one
 *     today; it exists so that "clear it" has an unambiguous way to be said
 *     rather than being spelled the same as "I did not touch the box".
 *
 * The stored row is left in place when the reference is cleared. Removing it
 * would be a second writer of `secrets.yaml` deciding what is garbage, and
 * a row nothing references costs nothing; `SecretStore` is the one thing that
 * owns that file.
 *
 * The typed value is never returned, never logged and never put on the
 * configuration (R-SEC-10): it goes to `secrets.put` and nowhere else, and
 * what lands in `config.yaml` is the name of a row.
 */
export function configureModem(
  current: Config,
  request: unknown,
  secrets: SecretSink,
): ModemConfigureResult {
  const parsed = ModemRequest.safeParse(request);
  if (!parsed.success) {
    // The submitted body is never echoed — it is unvalidated input on its way
    // back into a browser, and one of its fields is a credential.
    return { ok: false, error: "that is not a modem configuration" };
  }

  const { password, ...rest } = parsed.data;
  const config = structuredClone(current);
  config.network.modem = { ...config.network.modem, ...rest };

  if (typeof password === "string" && password !== "") {
    // Into secrets.yaml, never into config.yaml.
    secrets.put(MODEM_PASSWORD_SECRET, password);
    config.network.modem.password = { secret: MODEM_PASSWORD_SECRET };
  } else if (password === null) {
    config.network.modem.password = null;
  }

  return { ok: true, config };
}
