// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { DEFAULT_THEME, PALETTES, themeCss, themeName, type ThemeName } from "./theme.js";
import { presentation, type CommandState } from "./command.js";
import { DEFAULT_CONFIG } from "../schema/config.js";

const THEMES: ThemeName[] = ["day", "night"];

describe("the palettes", () => {
  /**
   * ADR-0005 and R-UI-07: in direct sunlight a dark screen becomes a mirror,
   * which is why every electronic flight bag ships day-first. The default is
   * the requirement, not a preference, so it is asserted in both places it is
   * expressed.
   */
  it("default to day, in the schema and here", () => {
    expect(DEFAULT_THEME).toBe("day");
    expect(DEFAULT_CONFIG.ui.theme).toBe("day");
  });

  it("defines the same variables in both, so a page cannot lose one at night", () => {
    expect(Object.keys(PALETTES.day).sort()).toEqual(Object.keys(PALETTES.night).sort());
  });

  /**
   * Two designed palettes rather than a theme and its inversion. If night were
   * day with the lightness flipped, these would be each other's complements —
   * and a screen correct at noon destroys dark adaptation at midnight.
   */
  it("are two designs, not one and its inversion", () => {
    for (const key of Object.keys(PALETTES.day) as (keyof typeof PALETTES.day)[]) {
      expect(PALETTES.day[key], key).not.toBe(PALETTES.night[key]);
    }
    // Day is light behind dark; night is dark behind light.
    expect(PALETTES.day.background > PALETTES.day.text).toBe(true);
    expect(PALETTES.night.background < PALETTES.night.text).toBe(true);
  });

  it("names a tone for every command state the language has", () => {
    const states: CommandState[] = ["idle", "pending", "confirmed", "rejected"];
    for (const state of states) {
      const tone = presentation(state).tone;
      expect(PALETTES.day, `${state} -> ${tone}`).toHaveProperty(tone);
      expect(PALETTES.night, `${state} -> ${tone}`).toHaveProperty(tone);
    }
  });
});

describe("themeName", () => {
  it("takes the operator's choice", () => {
    expect(themeName("night")).toBe("night");
    expect(themeName("day")).toBe("day");
  });

  /** A console that refuses to render over a theme name is one nobody can reach. */
  it("falls back to day rather than failing on anything else", () => {
    for (const value of [undefined, null, "", "dark", 7, {}]) {
      expect(themeName(value), JSON.stringify(value)).toBe("day");
    }
  });
});

describe("themeCss", () => {
  it("produces every variable for both themes", () => {
    for (const theme of THEMES) {
      const css = themeCss(theme);
      for (const name of Object.keys(PALETTES[theme])) {
        // camelCase in the palette, kebab-case in CSS.
        const variable = `--yonder-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        expect(css, `${theme} is missing ${variable}`).toContain(variable);
      }
    }
  });

  it("says which theme it is, so a page could tell", () => {
    expect(themeCss("day")).toContain('--yonder-theme: "day"');
    expect(themeCss("night")).toContain('--yonder-theme: "night"');
  });

  it("carries the actual colours of the theme it was asked for", () => {
    expect(themeCss("day")).toContain(PALETTES.day.background);
    expect(themeCss("day")).not.toContain(PALETTES.night.background);
    expect(themeCss("night")).toContain(PALETTES.night.background);
  });

  it("styles every tone the command-state language produces", () => {
    for (const theme of THEMES) {
      const css = themeCss(theme);
      for (const tone of ["neutral", "waiting", "good", "bad"]) {
        expect(css, `${theme}/${tone}`).toContain(`.yonder-tone-${tone}`);
      }
    }
  });

  /**
   * **R-UI-01, asserted rather than reviewed.** A Dashboard theme that pulls a
   * webfont from a CDN works in a lab with internet and fails in a field
   * without one — silently in the first case, loudly and at the worst moment
   * in the second. This is the same test `assets.test.ts` runs against
   * `setup.html`, applied to the thing most likely to regress it.
   */
  it("fetches nothing from anywhere", () => {
    for (const theme of THEMES) {
      const css = themeCss(theme);
      expect(css, theme).not.toMatch(/https?:\/\//);
      expect(css, theme).not.toMatch(/@import/);
      expect(css, theme).not.toMatch(/url\s*\(/);
      expect(css, theme).not.toMatch(/fonts\.googleapis|cdn|unpkg|jsdelivr/i);
    }
  });

  it("says it is generated and where from", () => {
    expect(themeCss("day")).toContain("GENERATED FILE");
    expect(themeCss("day")).toContain("theme.ts");
  });
});

/**
 * The shell, not just the palette.
 *
 * These assert the parts that were missing when the console was first put in
 * front of a person: a font stack that never fetches, figures that do not
 * reflow as they change, an app bar that is themed rather than Vuetify's
 * white, and touch targets sized for the device this runs on.
 */
describe("themeCss ships a whole shell", () => {
  const themes: ThemeName[] = ["day", "night"];

  it("uses a system font stack and no webfont", () => {
    for (const t of themes) {
      const css = themeCss(t);
      expect(css, t).toContain("--yonder-font:");
      expect(css, t).toContain("system-ui");
      // @font-face or a font URL would be an asset fetched at runtime.
      expect(css, t).not.toMatch(/@font-face/);
      expect(css, t).not.toMatch(/fonts\.(googleapis|gstatic)/);
    }
  });

  it("gives readouts tabular figures, so a changing value does not reflow", () => {
    for (const t of themes) {
      expect(themeCss(t), t).toContain("tabular-nums");
    }
  });

  it("themes the app bar, which Vuetify otherwise paints white in both palettes", () => {
    // The worst thing to put in front of a dark-adapted eye is the one
    // element that is always on screen, still white.
    for (const t of themes) {
      const css = themeCss(t);
      expect(css, t).toMatch(/\.v-app-bar[^{]*\{[^}]*--yonder-surface/s);
    }
  });

  it("sizes anything hittable for a gloved finger", () => {
    for (const t of themes) {
      const css = themeCss(t);
      expect(css, t).toContain("--yonder-touch: 44px");
      expect(css, t).toMatch(/min-height:\s*var\(--yonder-touch\)/);
    }
  });

  it("stops the dashboard shouting its buttons in capitals", () => {
    for (const t of themes) {
      expect(themeCss(t), t).toContain("text-transform: none");
    }
  });

  it("still reaches no other host, in either palette", () => {
    for (const t of themes) {
      const css = themeCss(t);
      expect(css, t).not.toMatch(/https?:\/\//);
      expect(css, t).not.toMatch(/@import/);
    }
  });
});

/**
 * Words an operator has to act on are never behind a scrollbar.
 *
 * Dashboard sizes a widget from a configured row span. Prose has no row count
 * that is correct at every width, and the default resolves that with
 * `overflow: auto` — silently. On the first board this ran on, the Network
 * page's "Read this before you join a network" was 706px of text in a 372px
 * widget: 39% hidden, with nothing to indicate it. That block is what tells an
 * operator the access point is about to disappear and that they have five
 * minutes to confirm — the mitigation written for K-13.
 */
describe("themeCss never clips prose", () => {
  for (const t of ["day", "night"] as ThemeName[]) {
    it(`lets markdown widgets size to their content (${t})`, () => {
      const css = themeCss(t);
      const rule = /\.nrdb-ui-widget\.nrdb-ui-markdown\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
      expect(rule, "there must be a rule for markdown widgets").not.toBe("");
      expect(rule).toMatch(/height:\s*auto/);
      expect(rule).toMatch(/overflow:\s*visible/);
      expect(rule).toMatch(/grid-row-end:\s*auto/);
    });
  }
});

/**
 * Vuetify's block button is `min-width: 100%` with `flex: 1 0 auto` — not
 * `width`. Overriding `width` alone does nothing, which is how the first
 * attempt at this shipped a console whose every action was still a 704px
 * slab. Asserted because the property that matters is not the obvious one.
 */
describe("themeCss sizes actions to their words", () => {
  for (const t of ["day", "night"] as ThemeName[]) {
    it(`overrides min-width, not just width (${t})`, () => {
      const rule = /\.nrdb-ui-button \.v-btn\.v-btn--block\s*\{[^}]*\}/s.exec(themeCss(t))?.[0] ?? "";
      expect(rule, "there must be a rule for block buttons").not.toBe("");
      expect(rule).toMatch(/min-width:\s*12rem\s*!important/);
      expect(rule).toMatch(/flex:\s*0 0 auto/);
    });
  }
});
