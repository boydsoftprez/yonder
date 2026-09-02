// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/**
 * Day and night, as two designed palettes rather than a theme and its
 * inversion (R-UI-07, ADR-0005).
 *
 * ADR-0005 is explicit about why day is the default: **in direct sunlight a
 * dark screen becomes a mirror**, which is why every electronic flight bag
 * ships day-first. Night exists because the same aircraft gets flown after
 * dusk, and it is not the day palette with the lightness flipped — it is
 * warmer, dimmer and lower in contrast, because a screen that is correct at
 * noon destroys dark adaptation at midnight.
 *
 * The choice is the operator's and it persists in `ui.theme`. It is **never**
 * inferred from the browser or the host: `prefers-color-scheme` describes the
 * device somebody happens to be holding, not the light they are standing in,
 * and a console that switches itself to night because a phone is in dark mode
 * has guessed wrong about the one thing this requirement is about.
 *
 * **Generated as a stylesheet on the device, not fetched.** R-UI-01 says no
 * asset comes from the internet at runtime; this file produces the whole of
 * the console's palette as text, `ConsoleRenderer` writes it beside
 * `settings.js`, and the flows carry one same-origin `<link>`. There is no
 * webfont, no CDN and no `@import` — which is asserted as a test, because it
 * fails silently in a lab with internet and loudly in a field without.
 *
 * The tone names are the ones `command.ts` produces. That is the "shared CSS"
 * half of ADR-0005's command-state language: one module says a rejected
 * command has tone `bad`, and this one says what `bad` looks like in each
 * palette. A control cannot render differently in two places, because there is
 * only one place.
 */

export type ThemeName = Config["ui"]["theme"];

export interface Palette {
  /** The page behind everything. */
  background: string;
  /** Cards, groups, anything raised off the background. */
  surface: string;
  border: string;
  text: string;
  /** Labels and secondary text. Still legible: this is a field instrument. */
  muted: string;
  accent: string;
  /** The four command-state tones from command.ts, in order. */
  neutral: string;
  waiting: string;
  good: string;
  bad: string;
  /** Text placed on a tone. */
  onTone: string;
}

/**
 * Day.
 *
 * Near-white rather than white, so a page in sunlight is not a light source
 * of its own, and near-black text for the contrast that a screen behind
 * polarised sunglasses needs.
 */
const DAY: Palette = {
  background: "#f4f5f2",
  surface: "#ffffff",
  border: "#c9cdc6",
  text: "#16191c",
  muted: "#4d5560",
  accent: "#1d5b8f",
  neutral: "#5b6470",
  waiting: "#9a6400",
  good: "#1f6f43",
  bad: "#a3231d",
  onTone: "#ffffff",
};

/**
 * Night.
 *
 * Warm and dim rather than inverted. The accents are pulled towards amber and
 * away from blue, which is the part of the spectrum that costs dark
 * adaptation, and the background is a very dark grey rather than black so that
 * the edges of a card are still findable.
 */
const NIGHT: Palette = {
  background: "#12140f",
  surface: "#1c1f19",
  border: "#343930",
  text: "#e6e2d6",
  muted: "#a49d8c",
  accent: "#d29a3c",
  neutral: "#7d7869",
  waiting: "#c58a2a",
  good: "#6f9e5e",
  bad: "#c8654e",
  onTone: "#12140f",
};

export const PALETTES: Record<ThemeName, Palette> = { day: DAY, night: NIGHT };

/** Day, and this is the requirement rather than a preference. See above. */
export const DEFAULT_THEME: ThemeName = "day";

/**
 * A theme name from a configuration, or the default.
 *
 * The schema already constrains `ui.theme`, so this is the belt to that
 * braces — and the place a reader finds out that an unrecognised value is day
 * rather than an error. A console that refuses to render over a theme name is
 * a console an operator cannot reach.
 */
export function themeName(value: unknown): ThemeName {
  return value === "night" ? "night" : DEFAULT_THEME;
}

const HEADER = `/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * GENERATED FILE. Do not edit it.
 *
 * Written by yonder-core's ConsoleRenderer from ui.theme in
 * /etc/yonder/config.yaml, and rewritten from scratch on every apply — so an
 * edit here survives until the next one and then disappears. Change the
 * configuration instead.
 *
 * The generator is packages/yonder-core/src/console/theme.ts.
 *
 * Nothing in this file is fetched from anywhere: every colour is a literal,
 * there is no web font and no rule that pulls in another stylesheet
 * (R-UI-01). A theme that fetches a font works in a lab and fails in a field,
 * which is why a test asserts it about this text rather than a reviewer
 * asserting it about this comment.
 */`;

/**
 * The whole palette as a stylesheet.
 *
 * Custom properties first, so a page can use them, then the handful of rules
 * that put them onto the Dashboard's own surfaces. Overriding the widget
 * layer's styling wholesale is what ADR-0005 said this would take.
 */
export function themeCss(theme: ThemeName): string {
  const palette = PALETTES[theme];
  return [
    HEADER,
    "",
    ":root {",
    `  --yonder-theme: "${theme}";`,
    `  --yonder-background: ${palette.background};`,
    `  --yonder-surface: ${palette.surface};`,
    `  --yonder-border: ${palette.border};`,
    `  --yonder-text: ${palette.text};`,
    `  --yonder-muted: ${palette.muted};`,
    `  --yonder-accent: ${palette.accent};`,
    `  --yonder-neutral: ${palette.neutral};`,
    `  --yonder-waiting: ${palette.waiting};`,
    `  --yonder-good: ${palette.good};`,
    `  --yonder-bad: ${palette.bad};`,
    `  --yonder-on-tone: ${palette.onTone};`,
    "",
    "  /* The dashboard's own variables, pointed at ours. */",
    "  --v-theme-background: var(--yonder-background);",
    "  --v-theme-surface: var(--yonder-surface);",
    "  --v-theme-on-background: var(--yonder-text);",
    "  --v-theme-on-surface: var(--yonder-text);",
    "  --v-theme-primary: var(--yonder-accent);",
    "  --nrdb-page-background: var(--yonder-background);",
    "  --nrdb-group-background: var(--yonder-surface);",
    "  --nrdb-group-border: var(--yonder-border);",
    "  --nrdb-group-text: var(--yonder-text);",
    "  --nrdb-page-text: var(--yonder-text);",
    "  --nrdb-page-sidebar-background: var(--yonder-surface);",
    "}",
    "",
    "body, #app, .nrdb-layout {",
    "  background: var(--yonder-background);",
    "  color: var(--yonder-text);",
    "}",
    "",
    "/* The command-state language, in CSS. The tone names come from",
    "   console/command.ts, so a control cannot mean one thing on one page and",
    "   something else on another (ADR-0005, R-UI-05). */",
    ".yonder-tone-neutral { color: var(--yonder-neutral); }",
    ".yonder-tone-waiting { color: var(--yonder-waiting); font-weight: 600; }",
    ".yonder-tone-good    { color: var(--yonder-good); font-weight: 600; }",
    ".yonder-tone-bad     { color: var(--yonder-bad); font-weight: 600; }",
    "",
    ".yonder-note {",
    "  color: var(--yonder-muted);",
    "  line-height: 1.5;",
    "}",
    "",
    ".yonder-warning {",
    "  border-left: 4px solid var(--yonder-waiting);",
    "  padding: 0.6rem 0.9rem;",
    "  background: var(--yonder-surface);",
    "  color: var(--yonder-text);",
    "  line-height: 1.5;",
    "}",
    "",
  ].join("\n");
}
