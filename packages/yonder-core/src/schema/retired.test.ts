// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";
import { RETIRED_KEYS, withoutRetiredKeys, retirementNotice } from "./retired.js";

describe("withoutRetiredKeys", () => {
  it("drops a retired key and says which one", () => {
    const seededByAnEarlierBuild = {
      network: { ap: { ssid: "yonder", dhcp: { start: "192.168.77.2", end: "192.168.77.50" } } },
    };
    const { doc, dropped } = withoutRetiredKeys(seededByAnEarlierBuild);

    expect(dropped.map((k) => k.path)).toEqual(["network.ap.dhcp"]);
    expect(doc).toEqual({ network: { ap: { ssid: "yonder" } } });
  });

  it("leaves the caller's document untouched", () => {
    // loadConfig is a read and apply() is handed a body it does not own.
    // Editing either in place is the sort of surprise that shows up three
    // callers away, as a value that was there a moment ago and is not now.
    const original = { network: { ap: { dhcp: { lease: "12h" } } } };
    withoutRetiredKeys(original);
    expect(original.network.ap.dhcp).toEqual({ lease: "12h" });
  });

  /**
   * The trap a bare key name walks straight into. `network.ap.dhcp` is
   * retired; `network.ethernet.dhcp` is a live setting that decides whether
   * the wired interface takes an address. Matching on the name rather than
   * the path would silently discard the second while retiring the first —
   * exactly the silent data loss this mechanism exists to avoid.
   */
  it("retires a key at its own path only", () => {
    const config = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    const { doc, dropped } = withoutRetiredKeys(config);
    expect(dropped).toEqual([]);
    expect((doc as typeof DEFAULT_CONFIG).network.ethernet.dhcp).toBe(true);
  });

  it("does nothing when the path is not there to drop", () => {
    const clean = { network: { ap: { ssid: "yonder" } } };
    const { doc, dropped } = withoutRetiredKeys(clean);
    expect(dropped).toEqual([]);
    // Same object, not a copy: nothing was dropped, so nothing was rebuilt.
    expect(doc).toBe(clean);
  });

  it("does nothing to a document that is not a mapping at all", () => {
    // An empty config.yaml parses to null, and a hand-edited one can parse to
    // a string. Both belong to the schema's error message, not to a crash in
    // here on the way to it.
    for (const junk of [null, undefined, "version: 1", 7, ["a"]]) {
      expect(withoutRetiredKeys(junk).dropped).toEqual([]);
      expect(withoutRetiredKeys(junk).doc).toEqual(junk);
    }
  });

  it("does not match a key the prototype provides", () => {
    // `"toString" in {}` is true. A retired path resolved with `in` rather
    // than an own-property check would claim to have dropped a key that was
    // never in the operator's file.
    expect(withoutRetiredKeys({ network: { ap: {} } }).dropped).toEqual([]);
  });

  it("names the key and the reason in one line an operator can act on", () => {
    const line = retirementNotice("/etc/yonder/config.yaml", RETIRED_KEYS[0]!);
    expect(line).toContain("/etc/yonder/config.yaml");
    expect(line).toContain("network.ap.dhcp");
    expect(line).toContain("no longer used");
    expect(line).toContain(RETIRED_KEYS[0]!.note);
  });
});

/**
 * The list is only safe while every entry on it is genuinely gone from the
 * schema. Put a key back into `ConfigSchema` and forget to take its line out
 * of `RETIRED_KEYS`, and the loader silently deletes a setting an operator
 * has deliberately set — the same silent-data-loss failure as a misspelling,
 * arriving from the opposite direction. So each entry is checked against the
 * schema itself rather than against a comment.
 */
describe("every retired key", () => {
  for (const retired of RETIRED_KEYS) {
    it(`${retired.path} is one the schema really has no place for`, () => {
      const segments = retired.path.split(".");
      const leaf = segments[segments.length - 1]!;
      const probe = structuredClone(DEFAULT_CONFIG) as unknown;

      let node = probe as Record<string, unknown>;
      for (const segment of segments.slice(0, -1)) {
        const next = node[segment];
        expect(next, `${retired.path}: nothing at ${segment} to hang the probe on`).toBeTypeOf("object");
        node = next as Record<string, unknown>;
      }
      node[leaf] = "a value from an earlier build";

      const parsed = ConfigSchema.safeParse(probe);
      expect(parsed.success, `${retired.path} is still accepted by the schema`).toBe(false);
      if (parsed.success) return;

      // Specifically unrecognised, not merely the wrong type: a key the
      // schema still declares would fail for a type reason here and pass a
      // looser assertion, leaving the stale entry in place.
      const issue = parsed.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(issue, `${retired.path} fails validation, but not as an unrecognised key`).toBeDefined();
      expect(issue?.path.join(".")).toBe(segments.slice(0, -1).join("."));
      expect(issue?.code === "unrecognized_keys" ? issue.keys : []).toContain(leaf);
    });
  }
});

/**
 * The mechanism only protects the paths that use it. A new validator added
 * beside these — a boot-partition importer, a second API route, a migration
 * tool — that calls the schema directly reintroduces the exact defect
 * R-CFG-09 exists to prevent, and reintroduces it silently, because every
 * test here would still pass.
 *
 * So the call sites are enumerated too. This test failing is not a problem
 * with the test: it means something new validates an operator's document, and
 * that something has to run `withoutRetiredKeys` over it first.
 */
describe("the schema's call sites", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const VALIDATES_OPERATOR_INPUT = [
    // The shipped default, built from a literal in that same file. Nothing an
    // operator wrote ever reaches it.
    "schema/config.ts",
    // The two that do read what an operator wrote, and both drop retired
    // keys first.
    "config/load.ts",
    "apply/engine.ts",
  ];

  it("are only the ones that drop retired keys first", () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => f.split("\\").join("/"));

    const callers = sources.filter((f) =>
      /ConfigSchema\.(safeParse|parse)\(/.test(readFileSync(join(SRC, f), "utf8")));

    expect(
      callers.sort(),
      "a new caller validates a configuration document directly. If it can be handed a\n"
      + "file or a request body an operator wrote, run it through withoutRetiredKeys()\n"
      + "first (R-CFG-09) and add it to this list; a device carrying a key an earlier\n"
      + "build wrote is otherwise stranded by the upgrade.",
    ).toEqual(VALIDATES_OPERATOR_INPUT.sort());
  });
});
