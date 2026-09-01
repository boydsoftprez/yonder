// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { stringify } from "yaml";
import type { Config } from "../schema/config.js";
import { ConfigError } from "./errors.js";

/**
 * Write atomically: temp file in the same directory, fsync, then rename.
 * A rename within a directory is atomic, so a power loss mid-write leaves
 * either the old file or the new one, never a truncated hybrid (R-STO-03).
 */
export function saveConfig(path: string, config: Config): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, stringify(config), { mode: 0o644 });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw new ConfigError(`cannot write ${path}: ${(e as Error).message}`);
  }
}
