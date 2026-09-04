// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "yonder-core";
import type { Config } from "yonder-core";
import { PASSWORD_LABEL, modemForm } from "./form.js";

/**
 * A device whose modem is configured, as `GET /config` answers it.
 *
 * `password` is a `SecretRef` — `{ secret: "modem_password" }` — because that
 * is what the schema stores and what the route returns. The credential itself
 * is in secrets.yaml, mode 0600, and is not in this object at all. Neither the
 * value nor the name of the box it is in may reach a form (R-SEC-10).
 */
const CONFIGURED: Config = {
  ...DEFAULT_CONFIG,
  network: {
    ...DEFAULT_CONFIG.network,
    modem: {
      enabled: true,
      mode: "auto",
      interface: null,
      apn: "ereseller",
      username: "sim-user",
      password: { secret: "modem_password" },
      dial: "*99#",
    },
  },
};

const payloads = (config: unknown) => modemForm(config).map((m) => m?.payload);

describe("modemForm", () => {
  /**
   * The defect. The fact cell read `APN ereseller` and every box under it was
   * empty on every load, so one page answered the same question two ways and
   * an operator correcting an APN had to remember what it was.
   */
  it("seeds the three plain boxes from the configuration", () => {
    expect(payloads(CONFIGURED)).toEqual(["ereseller", "*99#", "sim-user", undefined]);
  });

  /**
   * **R-SEC-10, and the whole payload rather than the one field.** A leak
   * through some other key is the failure that matters: a form value, a topic,
   * a label, a diagnostic field somebody added later. So the assertion is made
   * against everything the four messages serialise to.
   *
   * The reference is checked as well as the credential. `{ secret: "…" }` is a
   * name rather than a value, but it is the name of a row in secrets.yaml and
   * it says out loud that a credential exists — and it has no business on a
   * page either way.
   */
  it("puts no credential, and no reference to one, in anything the form is fed", () => {
    const wire = JSON.stringify(modemForm(CONFIGURED));
    expect(wire).not.toMatch(/modem_password/);
    expect(wire).not.toMatch(/"secret"/);
    expect(wire).not.toMatch(/hunter2/);
    // The reference does not survive as an object either — a `{}` where a
    // SecretRef was is a key that was stringified away, not one that was
    // never carried.
    for (const message of modemForm(CONFIGURED)) {
      expect(JSON.stringify(message ?? {})).not.toMatch(/secret/i);
    }
  });

  /**
   * A credential that was somehow inlined into the configuration — a
   * hand-edited config.yaml, a future schema change — must not ride out on the
   * form either. The password output carries no value whatever the shape of
   * what it was given.
   */
  it("never seeds the password box, whatever is in the configuration", () => {
    const inlined = {
      ...CONFIGURED,
      network: {
        ...CONFIGURED.network,
        modem: { ...CONFIGURED.network.modem, password: "hunter2" },
      },
    };
    const [, , , password] = modemForm(inlined);
    expect(password?.payload).toBeUndefined();
    expect(JSON.stringify(modemForm(inlined))).not.toMatch(/hunter2/);
  });

  /**
   * What the box may say is *whether* one is set, which is the difference
   * between a password an operator must leave alone and one they have never
   * entered. `ui-text-input` has no placeholder of its own, so the label
   * carries it.
   */
  it("says whether a password is set, and never what it is", () => {
    const [, , , set] = modemForm(CONFIGURED);
    expect(set?.ui_update).toEqual({ label: PASSWORD_LABEL.set });
    const none = {
      ...CONFIGURED,
      network: {
        ...CONFIGURED.network,
        modem: { ...CONFIGURED.network.modem, password: null },
      },
    };
    const [, , , unset] = modemForm(none);
    expect(unset?.ui_update).toEqual({ label: PASSWORD_LABEL.unset });
    expect(PASSWORD_LABEL.set).not.toEqual(PASSWORD_LABEL.unset);
  });

  /**
   * **An unset field seeds an empty box, never `null`.**
   *
   * `modemRequest` refuses a form with no APN in it, because applying a
   * document identical to the one in force reports success and changes
   * nothing. It tests for `undefined` and `""`; a `null` arriving from the
   * configuration would sail past that guard and be applied — turning the
   * modem on with no APN, which is the exact failure the guard exists for.
   */
  it("seeds an empty box for a setting that is not configured", () => {
    expect(payloads(DEFAULT_CONFIG)).toEqual(["", "", "", undefined]);
  });

  /**
   * A read that failed leaves the boxes alone rather than emptying them.
   * `payload: null` is what `yonder-config` sends when the daemon did not
   * answer, and blanking a form on a lost socket would look exactly like a
   * device that has forgotten its own settings.
   */
  it.each([null, undefined, "not a configuration", {}, { network: {} }])(
    "sends nothing at all when there is no configuration to read (%s)",
    (value) => {
      expect(modemForm(value)).toEqual([null, null, null, null]);
    },
  );

  /** Four outputs, in the order the flows wire them. */
  it("answers on one output per box", () => {
    expect(modemForm(CONFIGURED)).toHaveLength(4);
  });
});
