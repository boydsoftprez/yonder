// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderPage, pageSource, escapeHtml } from "./assets.js";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("renderPage", () => {
  it("returns the page as written when there is nothing to say", () => {
    const page = renderPage("setup");
    expect(page).toContain("Set an administrator password");
    // The marker is spliced out, not left in the served page.
    expect(page).not.toContain("yonder:error");
  });

  it("splices an error banner in where the marker was", () => {
    const page = renderPage("login", "That password was not accepted.");
    expect(page).toContain("That password was not accepted.");
    expect(page).toContain('class="error"');
    expect(page).toContain('role="alert"');
    expect(page).not.toContain("yonder:error");
  });

  it("treats an empty message as no message", () => {
    expect(renderPage("login", "")).toBe(renderPage("login"));
  });

  it("serves the login identity inline without changing the sign-in form", () => {
    const page = renderPage("login");
    expect(page).toContain('<h1 aria-label="Yonder"><svg');
    expect(page).not.toContain("yonder:brand");
    expect(page).not.toMatch(/<(?:script|image|img|foreignObject)\b|(?:href|src)=/i);
    expect(page).toContain('<form method="post" action="/login">');
    expect(page).toContain('autocomplete="current-password"');
  });

  /**
   * The messages spliced in come from this project, so this is belt and
   * braces rather than the only thing standing between a page and an
   * injection. Belt and braces is the right amount for something a later
   * caller may hand a different string.
   */
  it("escapes a message rather than trusting it", () => {
    const page = renderPage("login", '<script>alert("x")</script>');
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("has a place to put an error on both pages that can refuse something", () => {
    for (const name of ["setup", "login"] as const) {
      expect(pageSource(name), name).toContain("<!--yonder:error-->");
    }
    // The restarting page cannot refuse anything, so it has no banner.
    expect(pageSource("restarting")).not.toContain("<!--yonder:error-->");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that turn text into markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
  it("escapes the ampersand first, so nothing is double-escaped wrongly", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
  it("leaves ordinary text alone", () => {
    expect(escapeHtml("at least 8 characters")).toBe("at least 8 characters");
  });
});

/**
 * `tsc` copies only what it compiles, so a console built from `dist/` would
 * start, bind its port, and answer every request with a stack trace about a
 * missing setup.html — a failure that appears on hardware, after a flash,
 * because nothing running from `src/` can see it.
 *
 * The built tree itself is not asserted here: CI runs the tests before the
 * build, so a clean checkout has no dist/ to look at. What is asserted is
 * that the build is still the thing that carries them.
 */
describe("the build", () => {
  it("copies the assets into the built tree", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(
      manifest.scripts.build,
      "the build no longer copies src/**/assets into dist/; a console built from dist/ "
      + "would answer every request with a stack trace about a missing page",
    ).toContain("copy-assets");
    expect(existsSync(join(PACKAGE, "scripts", "copy-assets.mjs"))).toBe(true);
  });
});
