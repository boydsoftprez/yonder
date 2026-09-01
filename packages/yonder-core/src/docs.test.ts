// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema } from "./schema/config.js";
import { RETIRED_KEYS } from "./schema/retired.js";
import { formatIssues } from "./config/errors.js";

/**
 * The reference configuration is the first thing anyone writing a config.yaml
 * copies. Documenting a shape the loader rejects wastes an operator's time in
 * the one place they cannot afford it — a device they are trying to reach.
 * Parsing the documented block here is what keeps the page honest.
 */
const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "configuration.md");
const MARKER = "<!-- yonder:reference-config -->";
const RETIRED_MARKER = "<!-- yonder:retired-keys -->";

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

/**
 * The retired-key table is the only place an operator is told why a setting
 * they wrote has stopped existing. A key retired in code and not written down
 * here is a key that vanishes from a device with an explanation that lives
 * only in the journal — which needs being on the device to read, and being on
 * the device is what an operator with a broken configuration may not be.
 */
describe("the retired-key table in docs/configuration.md", () => {
  /** `| \`path\` | reason |` rows, from the marker to the end of the table. */
  function documentedRows(): { key: string; note: string }[] {
    const page = readFileSync(DOC, "utf8");
    const marked = page.indexOf(RETIRED_MARKER);
    expect(marked, `${RETIRED_MARKER} is missing from docs/configuration.md`).toBeGreaterThanOrEqual(0);
    const rows: { key: string; note: string }[] = [];
    for (const line of page.slice(marked).split("\n").slice(1)) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length !== 2 || cells[0] === "Key" || /^-+$/.test(cells[0] ?? "")) continue;
      rows.push({ key: (cells[0] ?? "").replaceAll("`", ""), note: (cells[1] ?? "").replaceAll("`", "") });
    }
    return rows;
  }

  it("lists every key the loader actually retires, and no others", () => {
    expect(
      documentedRows().map((r) => r.key),
      "RETIRED_KEYS and docs/configuration.md disagree. Retiring a key is two lines:\n"
      + "one in src/schema/retired.ts, one in the table under the yonder:retired-keys marker.",
    ).toEqual(RETIRED_KEYS.map((k) => k.path));
  });

  it("gives each one the same reason the daemon logs", () => {
    // Same words in the journal and on the page, so an operator reading one
    // is not left wondering whether the other describes something else.
    const documented = documentedRows().map((r) => r.note.toLowerCase());
    expect(documented).toEqual(RETIRED_KEYS.map((k) => k.note.toLowerCase()));
  });
});
