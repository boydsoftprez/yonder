// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema } from "./schema/config.js";
import { formatIssues } from "./config/errors.js";

/**
 * The reference configuration is the first thing anyone writing a config.yaml
 * copies. Documenting a shape the loader rejects wastes an operator's time in
 * the one place they cannot afford it — a device they are trying to reach.
 * Parsing the documented block here is what keeps the page honest.
 */
const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "configuration.md");
const MARKER = "<!-- yonder:reference-config -->";

function referenceConfig(): string {
  const page = readFileSync(DOC, "utf8");
  const marked = page.indexOf(MARKER);
  expect(marked, `${MARKER} is missing from docs/configuration.md`).toBeGreaterThanOrEqual(0);
  const fence = page.indexOf("```yaml", marked);
  expect(fence, "the marker is not followed by a yaml block").toBeGreaterThan(marked);
  const start = page.indexOf("\n", fence) + 1;
  const end = page.indexOf("```", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("the reference configuration in docs/configuration.md", () => {
  it("is a configuration the schema accepts", () => {
    const parsed = ConfigSchema.safeParse(parse(referenceConfig()));
    const issues = parsed.success ? [] : formatIssues(parsed.error);
    expect(issues, `docs/configuration.md has drifted from the schema:\n  ${issues.join("\n  ")}`)
      .toEqual([]);
  });

  it("shows secret references in the form the schema understands", () => {
    const parsed = ConfigSchema.parse(parse(referenceConfig()));
    // An unknown YAML tag resolves to a bare string, which is exactly what a
    // reference must not be: it would be read as a password rather than a
    // name to look up in secrets.yaml.
    expect(parsed.network.ap.psk).toEqual({ secret: "ap_psk" });
    // The administrator password is the other case: it has no reference at
    // all until an operator sets one (R-SEC-09), and the reference page has
    // to show that rather than naming a secret no device has.
    expect(parsed.ui.editor.password).toBeNull();
  });
});
