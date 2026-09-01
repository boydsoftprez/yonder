// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { parse, stringify } from "yaml";
import { generateSecret } from "./generate.js";
import { ConfigError } from "../config/errors.js";
import type { SecretRef } from "../schema/config.js";

type Bag = Record<string, string>;

export class SecretStore {
  private readonly path: string;
  private bag: Bag;

  constructor(path: string) {
    this.path = path;
    this.bag = existsSync(path) ? (parse(readFileSync(path, "utf8")) as Bag) ?? {} : {};
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
    this.flush();
    return { value, created: true };
  }

  resolve(ref: SecretRef): string {
    const value = this.bag[ref.secret];
    if (value === undefined) {
      throw new ConfigError(`no secret named "${ref.secret}" in ${this.path}`);
    }
    return value;
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, stringify(this.bag), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw new ConfigError(`cannot write ${this.path}: ${(e as Error).message}`);
    }
  }
}
