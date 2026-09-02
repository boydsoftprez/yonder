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
   * One design at two brightnesses, which is what ADR-0009 settled and what
   * this test used to forbid.
   *
   * It previously asserted that *every* value differs and that day is dark
   * text on a light ground. Both were true of the M1b palette and neither
   * survives the console becoming a glass cockpit display in a carbon panel:
   * a multi-function display does not turn white at noon, it lifts its
   * levels. So the assertion is now the thing that actually matters — night
   * is dimmer than day everywhere it counts, and neither is the other with
   * the lightness flipped.
   */
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };

  it("is one design at two brightnesses, never an inversion", () => {
    // The display face and the page behind it are dimmer at night.
    for (const key of ["display", "pane", "background", "value"] as const) {
      expect(
        luminance(PALETTES.night[key]),
        `${key}: night must be dimmer than day`,
      ).toBeLessThan(luminance(PALETTES.day[key]));
    }

    // Both are light-on-dark. An inversion would put one of them the other
    // way up, which is the thing R-UI-07 exists to prevent.
    for (const t of ["day", "night"] as const) {
      expect(
        luminance(PALETTES[t].value),
        `${t}: the reading must be brighter than the face it is on`,
      ).toBeGreaterThan(luminance(PALETTES[t].display));
    }
  });

  it("keeps the tones legible against the face in both", () => {
    for (const t of ["day", "night"] as const) {
      for (const tone of ["good", "waiting", "bad", "select"] as const) {
        expect(
          Math.abs(luminance(PALETTES[t][tone]) - luminance(PALETTES[t].display)),
          `${t}/${tone} is too close to the display face to read`,
        ).toBeGreaterThan(40);
      }
    }
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
    // element that is always on screen, still white. It is now transparent
    // over the carbon, which is a stronger answer than painting it a colour —
    // so the assertion is that it is claimed at all, and that the claim wins.
    for (const t of themes) {
      const rule = /\.v-app-bar[^{]*\{[^}]*\}/s.exec(themeCss(t))?.[0] ?? "";
      expect(rule, `${t}: nothing themes the app bar`).not.toBe("");
      expect(rule).toMatch(/background:[^;]*!important/);
      expect(rule).toMatch(/--yonder-value/);
    }
  });

  /**
   * The panel the display is mounted in (ADR-0009, R-UI-13).
   *
   * Generated from gradients rather than shipped as an image: it scales to any
   * display and follows the palette, and R-UI-13 requires it. A weave whose
   * tones sit within a few RGB values of each other renders as nothing, which
   * is how the first attempt shipped — so this checks the contrast is real.
   */
  it("draws the carbon panel, in CSS, with a weave you can actually see", () => {
    for (const t of themes) {
      const css = themeCss(t);
      expect(css, `${t}: no carbon`).toMatch(/repeating-linear-gradient/);
      const weave = /linear-gradient\(45deg,\s*(#[0-9a-f]{6})[^)]*\)/i.exec(css)?.[1];
      const shade = /linear-gradient\(135deg,\s*(#[0-9a-f]{6})[^)]*\)/i.exec(css)?.[1];
      expect(weave, `${t}: the twill has no light tone`).toBeDefined();
      expect(shade, `${t}: the twill has no dark tone`).toBeDefined();
      const gap = Math.abs(parseInt(weave.slice(1), 16) - parseInt(shade.slice(1), 16));
      expect(gap, `${t}: the weave tones are too close to see`).toBeGreaterThan(0x080808);

      // Vuetify's reset sets `background-repeat: no-repeat` on the element
      // this rule lands on. Leaving it to the CSS default painted one 16px
      // tile in the corner of the page and nothing else — a flat background
      // with a smudge, where the smudge was the entire panel. A tiled
      // texture that does not say it tiles is a texture that renders once.
      const rule = /\.nrdb-app,[\s\S]*?\}/.exec(css)?.[0] ?? "";
      expect(rule, `${t}: no carbon rule`).not.toBe("");
      expect(rule, `${t}: the carbon must state that it repeats`)
        .toMatch(/background-repeat:\s*repeat/);
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
 * Anything an operator has to read or fill in is never behind a scrollbar.
 *
 * Dashboard sizes a widget from a configured row span. Some content has no row
 * count that is correct at every width, and the default resolves that with
 * `overflow: auto` — silently. On the first board this ran on, the Network
 * page's "Read this before you join a network" was 706px of text in a 372px
 * widget: 39% hidden, with nothing to indicate it. That block is what tells an
 * operator the access point is about to disappear and that they have five
 * minutes to confirm — the mitigation written for K-13.
 *
 * The fix for that was named after prose, so it covered markdown and stopped.
 * The capture gate (R-UI-12) found the rest: the join form was 172px of
 * content in 48px with 72% hidden, and the ping form 112px in 48px with 57%
 * hidden (K-27). The join form is the one an operator fills in immediately
 * after reading the warning above — so the page explained what pressing Join
 * would cost and then hid the field they had to type into to do it.
 *
 * These tests are per widget type on purpose. A single assertion over a
 * combined selector would pass while a type was quietly dropped from it.
 */
/**
 * The instrument roles reach the page.
 *
 * The components in `node-red-dashboard-2-yonder` read these and carry night
 * fallbacks, so a missing token is not a blank widget — it is a **dark
 * instrument on a day board**, which is the one failure mode R-UI-07 exists to
 * prevent and the one nobody would notice in a lab at night. It shipped
 * exactly that way for one build.
 */
describe("themeCss carries the instrument roles (ADR-0009)", () => {
  const roles = [
    "display", "pane", "divider", "label", "value", "track", "select", "irreversible",
  ];
  for (const t of ["day", "night"] as ThemeName[]) {
    for (const role of roles) {
      it(`defines --yonder-${role} (${t})`, () => {
        expect(themeCss(t)).toMatch(new RegExp(`--yonder-${role}:\\s*#[0-9a-f]{6};`, "i"));
      });
    }
  }

  it("gives day and night different instrument faces", () => {
    // If these matched, one of the two palettes would be undesigned.
    const face = (t: ThemeName) => /--yonder-display:\s*(#[0-9a-f]{6})/i.exec(themeCss(t))?.[1];
    expect(face("day")).not.toBe(face("night"));
  });
});

describe("themeCss never clips content an operator has to act on", () => {
  /** The widget types whose height is a function of content, not of shape. */
  const sizesToContent = ["nrdb-ui-markdown", "nrdb-ui-form"];

  for (const t of ["day", "night"] as ThemeName[]) {
    for (const type of sizesToContent) {
      it(`lets ${type} widgets size to their content (${t})`, () => {
        const css = themeCss(t);
        // The selector may be shared with other types, so find the rule this
        // one is *in* rather than a rule that is only about it.
        const rule = new RegExp(
          `[^}]*\\.nrdb-ui-widget\\.${type}\\b[^{]*\\{[^}]*\\}`,
          "s",
        ).exec(css)?.[0] ?? "";
        expect(rule, `there must be a rule covering ${type} widgets`).not.toBe("");
        expect(rule).toMatch(/height:\s*auto/);
        expect(rule).toMatch(/overflow:\s*visible/);
        expect(rule).toMatch(/grid-row-end:\s*auto/);
      });
    }
  }

  /**
   * A form clips in two places, and only one of them is visible in a diff of
   * the widget rule: the widget growing does nothing if the box inside it
   * still scrolls.
   */
  for (const t of ["day", "night"] as ThemeName[]) {
    it(`unclips the form's own inner box too (${t})`, () => {
      const css = themeCss(t);
      const rule = /[^}]*\.nrdb-ui-form form[^{]*\{[^}]*\}/s.exec(css)?.[0] ?? "";
      expect(rule, "the inner form element needs its own rule").not.toBe("");
      expect(rule).toMatch(/overflow:\s*visible/);
      expect(rule).toMatch(/height:\s*auto/);
    });
  }
});
