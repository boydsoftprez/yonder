// SPDX-License-Identifier: GPL-3.0-or-later
import { unlinkSync } from "node:fs";
import { stringify } from "yaml";
import { writeFileDurable } from "../fs/durable.js";
import type { Config } from "../schema/config.js";
import { ConfigError } from "./errors.js";

/**
 * Write atomically and durably: temp file in the same directory, fsync, rename,
 * fsync the directory. A rename within a directory is atomic, so a power loss
 * mid-write leaves either the old file or the new one, never a truncated hybrid
 * (R-STO-03).
 */
export function saveConfig(path: string, config: Config): void {
  try {
    writeFileDurable(path, stringify(config), 0o644);
  } catch (e) {
    try { unlinkSync(`${path}.tmp`); } catch { /* nothing to clean up */ }
    throw new ConfigError(`cannot write ${path}: ${(e as Error).message}`);
  }
}
