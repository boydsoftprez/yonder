// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "../schema/config.js";
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

  const result = ConfigSchema.safeParse(doc);
  if (!result.success) {
    throw new ConfigError(`${path} is not a valid Yonder configuration`, formatIssues(result.error));
  }
  return result.data;
}
