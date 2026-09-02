// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { systemReader, type FileReader } from "./read.js";

/**
 * What is running, and on what (R-SYS-02).
 *
 * Both may be absent and both degrade to null. A device whose `/etc/os-release`
 * is missing is unusual but not broken, and a status page that throws rather
 * than saying "unknown" turns a cosmetic gap into a page that does not load.
 */

export interface Versions {
  /** Yonder's own version, from the installed package manifest. */
  yonder: string | null;
  /** The operating system, as it describes itself. */
  os: string | null;
}

/**
 * `/etc/os-release`, which is a shell fragment: `KEY=value`, values
 * optionally quoted.
 *
 * `PRETTY_NAME` first, because that is the line written to be read by a
 * person — `Debian GNU/Linux 13 (trixie)`. `NAME` and `VERSION` are the
 * fallback for a distribution that omits it, assembled in that order. Nothing
 * else is read: this is a version string for a status page, not a
 * distribution-detection routine, and a function that grows one of those by
 * accident is a function that starts making decisions.
 */
export function parseOsRelease(text: string | null): string | null {
  if (text === null) return null;

  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    // Quoted or bare, both are legal in this file.
    const value = /^"(.*)"$/.exec(rawValue)?.[1] ?? /^'(.*)'$/.exec(rawValue)?.[1] ?? rawValue;
    if (value !== "") values.set(key, value);
  }

  const pretty = values.get("PRETTY_NAME");
  if (pretty !== undefined) return pretty;
  const name = values.get("NAME");
  if (name === undefined) return null;
  const version = values.get("VERSION");
  return version === undefined ? name : `${name} ${version}`;
}

/**
 * `"0.1.0"` out of a package manifest, or null.
 *
 * Never throws. The manifest is JSON this project wrote, so a parse failure
 * means an install that has been damaged — and the correct thing for a status
 * page to do about a damaged install is render, saying what it does not know,
 * so that somebody can look at the rest of the page and work out why.
 */
export function parsePackageVersion(text: string | null): string | null {
  if (text === null) return null;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The installed `yonder-core` manifest, found relative to this module.
 *
 * Two directories up from `system/`, which is the package root whether this is
 * running from `src/` under vitest or from `dist/` on a device. Deriving it
 * rather than naming `/opt/yonder/...` is what keeps this true for a tree
 * installed anywhere — and the installer's prefix is a variable.
 */
export const DEFAULT_PACKAGE_MANIFEST = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "..",
  "package.json",
);

export const DEFAULT_OS_RELEASE = "/etc/os-release";

export interface ReadVersionsOptions {
  read?: FileReader;
  manifestPath?: string;
  osReleasePath?: string;
}

export function readVersions(opts: ReadVersionsOptions = {}): Versions {
  const read = opts.read ?? systemReader;
  return {
    yonder: parsePackageVersion(read(opts.manifestPath ?? DEFAULT_PACKAGE_MANIFEST)),
    os: parseOsRelease(read(opts.osReleasePath ?? DEFAULT_OS_RELEASE)),
  };
}
