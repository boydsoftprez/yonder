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
