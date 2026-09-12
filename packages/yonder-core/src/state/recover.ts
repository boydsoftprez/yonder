// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import { StateCoordinatorError } from "./coordinator.js";
import type { DurableState } from "./types.js";

const SecretBagSchema = z.record(z.string().max(256), z.string().max(256 * 1024));

function unavailable(): StateCoordinatorError {
  return new StateCoordinatorError(
    "STATE_UNAVAILABLE",
    "managed durable state storage is unavailable; use recovery diagnostics or reflash this device",
  );
}

function unescapeMountInfo(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Refuse to initialize into the root filesystem when a managed-state marker says a mount must exist. */
export function assertManagedStateMount(input: {
  stateRoot: string;
  markerPath: string;
  mountInfoText?: string;
  mountInfoPath?: string;
}): void {
  if (!existsSync(input.markerPath)) return;
  let mountInfo: string;
  try {
    mountInfo = input.mountInfoText ?? readFileSync(input.mountInfoPath ?? "/proc/self/mountinfo", "utf8");
  } catch {
    throw unavailable();
  }
  const mounted = mountInfo.split("\n").some((line) => {
    const halves = line.trim().split(" - ");
    if (halves.length !== 2) return false;
    const fields = (halves[0] ?? "").split(" ");
    const filesystem = (halves[1] ?? "").split(" ")[0];
    const options = new Set((fields[5] ?? "").split(","));
    return fields.length >= 6
      && unescapeMountInfo(fields[4] ?? "") === input.stateRoot
      && filesystem === "ext4"
      && options.has("rw");
  });
  if (!mounted) throw unavailable();
}

function privateYaml(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    throw unavailable();
  }
}

/** One-time importer for installations that predate the durable generation store. */
export function loadConventionalState(input: {
  configPath: string;
  secretsPath: string;
  /** Known-old config from the legacy config-only apply journal. */
  rollbackConfig?: DurableState["config"];
}): DurableState {
  try {
    const config = input.rollbackConfig ?? loadConfig(input.configPath);
    const secrets = SecretBagSchema.parse(privateYaml(input.secretsPath) ?? {});
    return { config, secrets, linuxOwner: null, zeroTier: null };
  } catch {
    throw unavailable();
  }
}
