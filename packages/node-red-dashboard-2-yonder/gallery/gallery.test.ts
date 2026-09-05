// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPECIMENS } from "./specimens.js";

const uiDir = join(import.meta.dirname, "../src/ui");

/**
 * The harness, not the specimens (Task 13's own scope).
 *
 * These two tests are what R-UI-25 is actually about: every component this
 * package ships gets rendered, and it is rendered from what is in `src/ui`
 * right now rather than from whatever a build last produced. Later tasks
 * add more specimens — more states of the same components — and both
 * tests keep holding as that list grows, because neither depends on how
 * many specimens exist, only on which components they cover and where they
 * come from.
 */
describe("the gallery covers every shipped instrument (R-UI-25)", () => {
  it("has a specimen for every component in src/ui", () => {
    const components = readdirSync(uiDir)
      .filter((f) => f.endsWith(".vue"))
      .map((f) => f.replace(/\.vue$/, ""));
    const shown = new Set(SPECIMENS.map((s) => s.component.name ?? s.component.__name));
    for (const c of components) expect(shown, `no specimen renders ${c}`).toContain(c);
  });

  it("renders from source, never from a built bundle", () => {
    const src = readFileSync(join(import.meta.dirname, "specimens.js"), "utf8");
    expect(src).not.toMatch(/resources\/|\/dist\//);
  });
});

/**
 * The coverage test above is the one most easily faked: a specimen whose
 * component renders an empty div satisfies it and proves nothing (this
 * plan's own history, eight times over — see the coordinator's notes on
 * Task 13). This is the guard against that shape of shortcut: a specimen
 * that carries neither a configured prop nor a payload cannot be drawing
 * anything but its own defaults, so it would not survive this test.
 *
 * It does not, and cannot, prove a specimen is drawing something *correct*
 * — that is what each component's own test file is for (budget, facts,
 * holdkey, picture), and what actually opening the built gallery in both
 * palettes is for. It only proves nobody went back to
 * `{ component: X, props: {}, payload: undefined }` to make the test above
 * pass.
 */
describe("a specimen is a real state, not a stub", () => {
  it("gives every specimen a title, a note, and something configured to draw", () => {
    for (const s of SPECIMENS) {
      expect(s.title, "every specimen needs a title").toBeTruthy();
      expect(s.note, `${String(s.title)} has no note saying what it demonstrates`).toBeTruthy();
      const hasProps = Boolean(s.props) && typeof s.props === "object" && Object.keys(s.props).length > 0;
      const hasPayload = s.payload !== undefined && s.payload !== null;
      expect(hasProps || hasPayload, `${String(s.title)} carries neither a configured prop nor a payload`).toBe(true);
    }
  });
});
