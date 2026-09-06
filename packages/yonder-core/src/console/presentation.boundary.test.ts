// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The boundary `presentation.ts` exists to hold, pinned rather than commented.
 *
 * That file's own opening comment states the rule — *it must be a pure
 * function of its arguments, it must import nothing from `node:`* — and until
 * now the rule was held by nothing but the comment. Appending
 * `export { validateDraft } from "../apply/draft.js"` to it drags the config
 * schema, and therefore zod, into the one entry point a browser bundles, and
 * every suite and every lint stayed green. This task added a second thing
 * depending on that boundary (`apply/draft-shape.ts` was split out of
 * `apply/draft.ts` for exactly this reason), so the boundary now needs a
 * guard of its own.
 *
 * **Walked over the source, not the build.** CI runs the tests before the
 * build, so a check that read `dist/` would either fail on a clean checkout
 * or pass against something stale — the same reasoning `vitest.config.ts`
 * gives for resolving `yonder-core` from source in the sibling packages.
 *
 * **What counts as reachable.** A runtime `import`/`export … from` is
 * followed; `import type` and `export type` are erased by TypeScript and are
 * not. That distinction is the whole mechanism: `video/present.ts` is on this
 * graph and its `import type { Camera } from "../schema/config.js"` is
 * precisely why it may be.
 */

/** Block and line comments removed. See `runtimeImports`. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n"'`]*\/\/.*$/gm, "");
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "presentation.ts");

/**
 * Every specifier a module needs *at runtime*, type-only lines removed.
 *
 * **Comments are stripped first**, and finding out why is the reason this
 * function is written down rather than being a one-line regex: this file's
 * own tree is heavily commented in prose, and `… — it accepts the command
 * and nothing moves` sails past a naive `from "…"` match. The first run
 * reported `video/present.ts imports "this page failed"`.
 */
function runtimeImports(source: string): string[] {
  const code = withoutComments(source)
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*["'][^"']+["'];?$/gm, "")
    .replace(/^\s*export\s+type\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?$/gm, "");
  const out: string[] = [];
  // A multi-line `export { a, type B } from "x"` is one statement; match the
  // whole thing rather than line by line, and drop the `type` members.
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?)from\s*["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    const source = readFileSync(file, "utf8");
    const specifiers = runtimeImports(source);
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      walk(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  };
  walk(entry);
  return seen;
}

describe("yonder-core/presentation is bundleable by a browser", () => {
  /**
   * The assertion is *zero bare specifiers anywhere on the graph*, not "no
   * zod" — a list of forbidden packages is a list somebody has to remember to
   * add to. Everything on this side of the boundary is a pure function of its
   * arguments, so it needs nothing from `node:` and nothing from npm; the day
   * one legitimately does, this test is where the decision gets made.
   */
  it("reaches nothing outside its own source tree at runtime", () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of reachable(ENTRY)) {
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) continue;
        offenders.push(`${file.slice(file.indexOf("/src/") + 1)} imports "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * And the walk really is walking — a check that followed nothing would
   * report zero offenders for ever. `video/present.ts` and
   * `apply/draft-shape.ts` are the two modules this task put on the graph,
   * and both are reached through a runtime `export … from`.
   */
  it("actually follows the graph it is checking", () => {
    const files = [...reachable(ENTRY).keys()].map((f) => f.slice(f.indexOf("/src/") + 5));
    expect(files).toContain("console/presentation.ts");
    expect(files).toContain("video/present.ts");
    expect(files).toContain("apply/draft-shape.ts");
    // And the module the split protects the boundary *from* is not on it.
    expect(files).not.toContain("apply/draft.ts");
    expect(files).not.toContain("schema/config.ts");
  });
});
