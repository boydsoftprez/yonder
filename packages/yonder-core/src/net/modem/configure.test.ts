// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { MODEM_PASSWORD_SECRET, ModemRequest, configureModem } from "./configure.js";
import type { SecretSink } from "../join.js";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../../schema/config.js";

function sink(): SecretSink & { stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  return { stored, put: (name, value) => { stored[name] = value; } };
}

/** A device that already has a credential stored and referenced. */
function withStoredPassword(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.network.modem = {
    ...config.network.modem,
    enabled: true,
    apn: "ereseller",
    password: { secret: MODEM_PASSWORD_SECRET },
  };
  return config;
}

describe("configureModem", () => {
  /**
   * R-CEL-02, priority 1, and the whole reason this module exists. Before it,
   * a typed password failed the schema, the route refused the body, and the
   * APN beside it was discarded too.
   */
  it("stores a typed password and puts a reference in the configuration", () => {
    const secrets = sink();
    const result = configureModem(
      DEFAULT_CONFIG,
      { enabled: true, apn: "ereseller", username: "sim-user", password: "hunter2" },
      secrets,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(secrets.stored[MODEM_PASSWORD_SECRET]).toBe("hunter2");
    expect(result.config.network.modem.password).toEqual({ secret: MODEM_PASSWORD_SECRET });
    expect(result.config.network.modem.apn).toBe("ereseller");
    expect(result.config.network.modem.username).toBe("sim-user");
    // The whole document, not the one field: a key added later cannot carry
    // the credential out past an assertion that only looked where it expected.
    expect(JSON.stringify(result.config)).not.toContain("hunter2");
    // And it is a configuration the schema accepts, which is what the apply
    // engine is about to be handed.
    expect(ConfigSchema.safeParse(result.config).success).toBe(true);
  });

  it("leaves everything else exactly as it was", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    const result = configureModem(before, { enabled: true, apn: "ereseller" }, sink());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.ap).toEqual(before.network.ap);
    expect(result.config.network.client).toEqual(before.network.client);
    expect(result.config.ui).toEqual(before.ui);
    // And the caller's own document is untouched.
    expect(before).toEqual(DEFAULT_CONFIG);
  });

  /**
   * `configure.ts`'s rule 1, held on this side of the socket as well: an
   * untouched password box must never overwrite a working credential. The
   * node drops the field; this is what makes that a property of the daemon
   * rather than a promise from the caller.
   */
  it.each([
    ["absent", {}],
    ["empty", { password: "" }],
  ])("leaves a stored credential alone when the password is %s", (_case, extra) => {
    const secrets = sink();
    const result = configureModem(withStoredPassword(), { apn: "another", ...extra }, secrets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.modem.password).toEqual({ secret: MODEM_PASSWORD_SECRET });
    expect(result.config.network.modem.apn).toBe("another");
    expect(secrets.stored).toEqual({});
  });

  /**
   * The configuration's own word for "there is no password". Nothing on the
   * console sends one, and it exists so that clearing has an unambiguous way
   * to be said rather than being spelled the same as "I did not touch it".
   */
  it("clears the reference on an explicit null", () => {
    const result = configureModem(withStoredPassword(), { password: null }, sink());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.network.modem.password).toBeNull();
  });

  it("refuses a body that is not a modem configuration, without echoing it", () => {
    const result = configureModem(DEFAULT_CONFIG, { apn: 42, password: "hunter2" }, sink());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("hunter2");
    expect(result.error).toBe("that is not a modem configuration");
  });

  /**
   * Derived from the schema, not restated beside it — so `.strict()` travels
   * with it and a key nobody added to the configuration is still refused.
   */
  it("refuses a key the configuration does not have", () => {
    expect(ModemRequest.safeParse({ apn: "a", roaming: true }).success).toBe(false);
  });

  it("refuses a password longer than any carrier issues", () => {
    expect(ModemRequest.safeParse({ password: "x".repeat(257) }).success).toBe(false);
    expect(ModemRequest.safeParse({ password: "x".repeat(256) }).success).toBe(true);
  });

  /** Nothing is stored for a body that was refused. */
  it("stores nothing at all when the body is refused", () => {
    const secrets = sink();
    configureModem(DEFAULT_CONFIG, { apn: 42, password: "hunter2" }, secrets);
    expect(secrets.stored).toEqual({});
  });
});
