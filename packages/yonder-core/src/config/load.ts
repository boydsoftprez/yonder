// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "../schema/config.js";
import { withoutRetiredKeys, retirementNotice } from "../schema/retired.js";
import { warn } from "../log.js";
import { ConfigError, formatIssues } from "./errors.js";

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${(e as Error).message}`);
  }

  // Before validation, because the schema is strict and would otherwise
  // reject the whole document over a key an earlier build of Yonder wrote
  // (R-CFG-09). Only the keys this project has actually retired are dropped;
  // a misspelling the schema has never heard of still falls through to the
  // failure below, naming the offending path exactly as it always did.
  const { doc: current, dropped } = withoutRetiredKeys(doc);
  for (const key of dropped) {
    // Loud, once per read. A key dropped in silence is a setting an operator
    // believes is in force, which is the failure this whole mechanism exists
    // to avoid the other half of.
    warn(
      `${retirementNotice(path, key)}. The file is left exactly as it is — loading is a read; `
      + "the key will simply not be written back the next time the configuration is saved",
    );
  }

  const result = ConfigSchema.safeParse(current);
  if (!result.success) {
    throw new ConfigError(`${path} is not a valid Yonder configuration`, formatIssues(result.error));
  }
  return result.data;
}
