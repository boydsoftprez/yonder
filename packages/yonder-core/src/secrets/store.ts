// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileDurable } from "../fs/durable.js";
import { generateSecret } from "./generate.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import { guardSecretValue } from "./redact.js";
import type { SecretRef } from "../schema/config.js";

type Bag = Record<string, string>;

const BagSchema = z.record(z.string());

/**
 * Parse the secrets file without letting its contents escape inside an error.
 *
 * The YAML parser reports a syntax error by quoting the offending lines back:
 *
 *     Tabs are not allowed as indentation at line 2, column 1:
 *
 *     ap_psk: <the access-point passphrase, in full>
 *     	admin_password: <the stored hash, in full>
 *     ^
 *
 * That message travelled. `parse()` threw straight past the `safeParse` guard
 * below, out of the constructor, out of `buildRenderers`, into
 * `ApplyStatus.degraded` — and `GET /status` is deliberately in front of the
 * administrator-password gate, so a device whose secrets.yaml had a stray tab
 * in it would hand its passphrase and password hash to an unauthenticated
 * caller on the access point. `warn()` put the same lines in the journal on
 * the way past.
 *
 * R-SEC-10 says redaction happens where the value is captured rather than
 * where it is printed, so that a new caller cannot reintroduce the leak.
 * This is that point: above this line no error ever carries the file's
 * contents, and no route, log call or support bundle has to remember to
 * strip them.
 *
 * The position survives, because an operator fixing the file needs it and it
 * names nothing. The parser's reason does not, because the reason is
 * inseparable from the quoted line that carries it.
 */
function parseSecretsFile(path: string, text: string): unknown {
  try {
    return parse(text);
  } catch (e) {
    const at = (e as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    const where = at === undefined ? "" : ` at line ${at.line}, column ${at.col}`;
    throw new ConfigError(`${path} is not valid YAML${where}`, [
      "the parser's reason is not repeated here: it quotes the offending line, "
        + "and every line of this file is a credential",
    ]);
  }
}

export class SecretStore {
  private readonly path: string;
  private bag: Bag;

  /**
   * Tell the redactor every value this store now holds.
   *
   * Here rather than at each call site, because R-SEC-10 says redaction
   * happens where the value is captured and this is the only place a value
   * enters the process. A caller that later writes one of these into a log
   * line — under no recognisable name, in a sentence nobody anticipated — has
   * it stripped without having to know that it should.
   */
  private guardAll(): void {
    for (const value of Object.values(this.bag)) guardSecretValue(value);
  }

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) {
      this.bag = {};
      return;
    }
    const parsed = BagSchema.safeParse(parseSecretsFile(path, readFileSync(path, "utf8")) ?? {});
    if (!parsed.success) {
      throw new ConfigError(
        `${path} must be a flat map of names to string values`,
        formatIssues(parsed.error),
      );
    }
    this.bag = parsed.data;
    this.guardAll();
  }

  get(name: string): string | undefined {
    return this.bag[name];
  }

  /** Return the secret, creating it if absent. `created` tells the caller to show it once. */
  ensure(name: string, kind: "psk" | "password" | "token"): { value: string; created: boolean } {
    const existing = this.bag[name];
    if (existing !== undefined) return { value: existing, created: false };
    const value = generateSecret(kind);
    this.bag[name] = value;
    guardSecretValue(value);
    this.flush();
    return { value, created: true };
  }

  /**
   * Set the secret to a given value if it is absent, and report whether it
   * had to. Used for a published default — the setup access-point passphrase
   * — where the value is fixed rather than drawn from the CSPRNG. An existing
   * value is never replaced, so an operator who changes the passphrase keeps
   * it across every later start.
   */
  ensureValue(name: string, value: string): { value: string; created: boolean } {
    const existing = this.bag[name];
    if (existing !== undefined) return { value: existing, created: false };
    this.bag[name] = value;
    guardSecretValue(value);
    this.flush();
    return { value, created: true };
  }

  /**
   * Set a secret, replacing whatever was there.
   *
   * The one writer that overwrites. `ensure` and `ensureValue` deliberately do
   * not — an operator who changed the access-point passphrase keeps theirs
   * across every start — but joining a *different* Wi-Fi network has to
   * replace the passphrase of the last one, and a store that could only ever
   * add would leave a device carrying a key for a network it is not on.
   *
   * Callers must be sure the value is a credential the operator meant to
   * change. Today there is one: POST /net/join.
   */
  put(name: string, value: string): void {
    if (this.bag[name] === value) return;
    this.bag[name] = value;
    guardSecretValue(value);
    this.flush();
  }

  resolve(ref: SecretRef): string {
    const value = this.bag[ref.secret];
    if (value === undefined) {
      throw new ConfigError(`no secret named "${ref.secret}" in ${this.path}`);
    }
    return value;
  }

  /**
   * Durable, not merely atomic. A secret this file records is one something
   * else is already relying on — an access-point passphrase an operator has
   * changed, an administrator password they have just set. If the write is
   * still in the page cache when power is cut, the device comes back without
   * it, and what they entered no longer opens anything.
   */
  private flush(): void {
    try {
      writeFileDurable(this.path, stringify(this.bag), 0o600);
    } catch (e) {
      try { unlinkSync(`${this.path}.tmp`); } catch { /* nothing to clean up */ }
      throw new ConfigError(`cannot write ${this.path}: ${(e as Error).message}`);
    }
  }
}
