// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { writeFileDurable } from "../fs/durable.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { ConfigError } from "./errors.js";

/** 0644: the configuration is not a secret, and only the daemon writes it. */
const CONFIG_MODE = 0o644;

/**
 * 0750, matching the installer: this directory also holds secrets.yaml, and a
 * world-readable directory tells anyone with a shell what is in it.
 */
const CONFIG_DIR_MODE = 0o750;

const HEADER = `# SPDX-License-Identifier: GPL-3.0-or-later
# Yonder default configuration.
#
# Generated from DEFAULT_CONFIG in packages/yonder-core/src/schema/config.ts.
# Regenerate with \`npm run defaults -w yonder-core\`; do not hand-edit the copy
# under config/defaults/, or the shipped default drifts from the schema that
# validates it.
#
# The copy at /etc/yonder/config.yaml belongs to the device. It is seeded from
# this file on a clean install and is never overwritten afterwards.
`;

/**
 * The exact text shipped as config/defaults/config.yaml, seeded by the
 * installer and written by the daemon when it finds no configuration at all.
 * One renderer for all three so a device can never end up with a default the
 * schema would reject.
 */
export function renderDefaultConfig(): string {
  return HEADER + stringify(DEFAULT_CONFIG);
}

/**
 * Write the default configuration, but only when there is none.
 *
 * R-CFG-08: a freshly flashed device has to reach a joinable state with no
 * operator input, and the daemon cannot load a file nobody ever wrote. This is
 * the daemon's half of that — the installer seeds the same content, and this
 * covers a device installed by hand, upgraded from a build that shipped no
 * default, or one whose configuration was deleted.
 *
 * An existing file is never touched, whatever is in it. An operator's
 * configuration is theirs; if it is invalid, that is a loud failure to fix,
 * not something to silently overwrite with defaults.
 */
export function seedConfigIfAbsent(path: string): boolean {
  if (existsSync(path)) return false;
  try {
    // The durable write fsyncs the containing directory, so it has to exist.
    mkdirSync(dirname(path), { recursive: true, mode: CONFIG_DIR_MODE });
    writeFileDurable(path, renderDefaultConfig(), CONFIG_MODE);
  } catch (e) {
    throw new ConfigError(`cannot seed ${path}: ${(e as Error).message}`);
  }
  return true;
}

function main(): void {
  const out = process.argv[2] ?? "config/defaults/config.yaml";
  writeFileSync(out, renderDefaultConfig());
  process.stdout.write(`wrote ${out}\n`);
}

// Compare file URLs rather than strings so a path with a space or a
// non-ASCII character still matches (see daemon/server.ts).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
