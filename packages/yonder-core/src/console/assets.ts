// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { brandSvg } from "./brand.js";

/**
 * The console's three pages, read from disk beside this module.
 *
 * They are `.html` files rather than template literals in TypeScript so that
 * they can be opened, read and reviewed as pages. A diff against markup
 * embedded in a string is a diff nobody checks.
 *
 * That does mean the build has to carry them into `dist/`: `tsc` copies only
 * what it compiles, so a console built from `dist/` would otherwise answer
 * every request with a stack trace about a missing setup.html — a failure
 * that appears on hardware, after a flash, because nothing running from
 * `src/` can see it. `scripts/copy-assets.mjs` carries them, and
 * `assets.test.ts` fails if the build ever stops calling it.
 */

export type PageName = "setup" | "login" | "restarting";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where an error message is spliced in, when there is one. */
const ERROR_MARKER = "<!--yonder:error-->";
const BRAND_MARKER = "<!--yonder:brand-->Yonder<!--/yonder:brand-->";

const cache = new Map<PageName, string>();

/** The page with its local vector identity, prepared once per process. */
export function pageSource(name: PageName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(HERE, "assets", `${name}.html`), "utf8")
    .replace(BRAND_MARKER, brandSvg({ treatment: "material", decorative: true }));
  cache.set(name, text);
  return text;
}

/**
 * The five characters that turn text into markup.
 *
 * The messages spliced in here come from this project — a length rule, a
 * refusal from the daemon — so this is belt and braces rather than the only
 * thing standing between a page and an injection. Belt and braces is the
 * correct amount for something a future caller may hand a different string.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A page, with an error banner if there is something to say. */
export function renderPage(name: PageName, error?: string): string {
  const source = pageSource(name);
  const banner = error === undefined || error === ""
    ? ""
    : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
  return source.replace(ERROR_MARKER, banner);
}
