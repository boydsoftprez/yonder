// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

// Compare file URLs rather than strings so a path with a space or a
// non-ASCII character still matches (see daemon/server.ts).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
