// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileDurable } from "../fs/durable.js";
import { generateSecret } from "./generate.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import type { SecretRef } from "../schema/config.js";

type Bag = Record<string, string>;

const BagSchema = z.record(z.string());

export class SecretStore {
  private readonly path: string;
  private bag: Bag;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) {
      this.bag = {};
      return;
    }
    const parsed = BagSchema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
    if (!parsed.success) {
      throw new ConfigError(
        `${path} must be a flat map of names to string values`,
        formatIssues(parsed.error),
      );
    }
    this.bag = parsed.data;
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

  /**
   * Durable, not merely atomic. First boot generates the access-point password
   * and shows it once; if that write is still in the page cache when power is
   * cut, the device comes back with a different password and the one written
   * down no longer opens the only interface that is always there.
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
