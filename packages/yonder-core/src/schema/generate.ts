// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "./config.js";

const TITLE = "Yonder configuration";

export function toJsonSchema(): object {
  const schema = zodToJsonSchema(ConfigSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Set after the spread so our title always wins, regardless of whether the
  // generator ever starts emitting one of its own.
  return { ...schema, title: TITLE };
}

function main(): void {
  const out = process.argv[2] ?? "config/schema/yonder.schema.json";
  writeFileSync(out, JSON.stringify(toJsonSchema(), null, 2) + "\n");
  process.stdout.write(`wrote ${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
