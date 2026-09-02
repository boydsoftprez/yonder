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
 * the console's shell as text, `ConsoleRenderer` writes it beside
 * `settings.js`, and the flows carry one same-origin `@import` of it from a
 * `ui-template` scoped `site:style`. Nothing here reaches another host: no
 * webfont, no CDN, no remote `@import` — asserted as a test, because that
 * fails silently in a lab with internet and loudly in a field without.
 *
 * **It is the whole shell, not only the palette.** Type, spacing, the app
 * bar, group headers, readout rows, buttons, tables and empty states all live
 * here, because a design system that arrives after the pages do means
 * restyling every page that was built without it. What waits is the
 * *composition* of screens whose content does not exist yet — a cockpit
 * cannot be laid out before there is telemetry to lay out — not the system
 * they will be composed in.
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
  const p = PALETTES[theme];
  return `${HEADER}

:root {
  --yonder-theme: "${theme}";

  /* ---- palette ---------------------------------------------------- */
  --yonder-background: ${p.background};
  --yonder-surface: ${p.surface};
  --yonder-border: ${p.border};
  --yonder-text: ${p.text};
  --yonder-muted: ${p.muted};
  --yonder-accent: ${p.accent};
  --yonder-neutral: ${p.neutral};
  --yonder-waiting: ${p.waiting};
  --yonder-good: ${p.good};
  --yonder-bad: ${p.bad};
  --yonder-on-tone: ${p.onTone};

  /* ---- type -------------------------------------------------------
     A system stack, never a webfont: R-UI-01 forbids fetching one, and a
     console that waits on a font it cannot reach shows an operator nothing
     at all. The mono stack is for values that are identifiers rather than
     quantities - an SSID, an address, a version - where a slashed zero and
     fixed width are what make them checkable. */
  --yonder-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  --yonder-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;

  --yonder-size-label: 0.875rem;
  --yonder-size-body: 1rem;
  --yonder-size-value: 1.25rem;
  --yonder-size-title: 0.9375rem;
  --yonder-size-page: 1.125rem;

  /* ---- space ------------------------------------------------------- */
  --yonder-space-1: 0.25rem;
  --yonder-space-2: 0.5rem;
  --yonder-space-3: 0.75rem;
  --yonder-space-4: 1rem;
  --yonder-space-5: 1.5rem;
  --yonder-radius: 4px;

  /* Anything an operator has to hit. A gloved finger on a tablet strapped to
     a leg is the input device this number is for (R-UI-04). */
  --yonder-touch: 44px;

  /* ---- the dashboard's own variables, pointed at ours ---------------- */
  --v-theme-background: var(--yonder-background);
  --v-theme-surface: var(--yonder-surface);
  --v-theme-on-background: var(--yonder-text);
  --v-theme-on-surface: var(--yonder-text);
  --v-theme-primary: var(--yonder-accent);
  --nrdb-page-background: var(--yonder-background);
  --nrdb-group-background: var(--yonder-surface);
  --nrdb-group-border: var(--yonder-border);
  --nrdb-group-text: var(--yonder-text);
  --nrdb-page-text: var(--yonder-text);
  --nrdb-page-sidebar-background: var(--yonder-surface);
}

html, body, .v-application, .nrdb-app {
  background: var(--yonder-background);
  color: var(--yonder-text);
  font-family: var(--yonder-font);
  font-size: var(--yonder-size-body);
  -webkit-text-size-adjust: 100%;
}

/* ---- the bar across the top -----------------------------------------
   Themed, because it was not: Vuetify paints it white from its own defaults,
   so on a night board the one element always on screen stayed a white slab -
   the single worst thing you can put in front of a dark-adapted eye. */
.v-app-bar,
.v-app-bar.v-toolbar {
  background: var(--yonder-surface) !important;
  color: var(--yonder-text) !important;
  border-bottom: 1px solid var(--yonder-border);
  box-shadow: none !important;
}

.v-app-bar-title,
.v-app-bar-title .v-toolbar-title__placeholder {
  font-size: var(--yonder-size-page);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--yonder-text);
}

/* The wordmark. Drawn in CSS rather than shipped as an image, so it costs no
   request and cannot be the one asset that fails to load. */
.v-app-bar-title::before {
  content: "YONDER";
  display: inline-block;
  margin-right: var(--yonder-space-3);
  padding-right: var(--yonder-space-3);
  border-right: 1px solid var(--yonder-border);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--yonder-accent);
  vertical-align: baseline;
}

/* ---- groups ---------------------------------------------------------- */
.nrdb-ui-group > .v-card {
  background: var(--yonder-surface) !important;
  border: 1px solid var(--yonder-border) !important;
  border-radius: var(--yonder-radius);
  box-shadow: none !important;
}

.nrdb-ui-group .v-card-title {
  font-size: var(--yonder-size-title);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--yonder-text);
  padding: var(--yonder-space-3) var(--yonder-space-4);
  border-bottom: 1px solid var(--yonder-border);
  margin-bottom: var(--yonder-space-2);
}

/* ---- a readout row ---------------------------------------------------
   Label left, value right. The value is the thing being read, so it is the
   larger of the two and the label is the quieter - the opposite of the stock
   widget, where both are the same weight and the eye has to hunt. */
.nrdb-ui-text.nrdb-ui-text--row-spread {
  align-items: baseline;
  gap: var(--yonder-space-4);
  min-height: var(--yonder-touch);
  padding: var(--yonder-space-2) var(--yonder-space-1);
}

.nrdb-ui-text-label {
  font-size: var(--yonder-size-label);
  font-weight: 500;
  color: var(--yonder-muted);
  line-height: 1.4;
}

/* Tabular figures, so a value that changes does not change width. A load
   average that reflows the row every two seconds is unreadable in motion,
   which is the condition this instrument is read in. */
.nrdb-ui-text-value {
  font-size: var(--yonder-size-value);
  font-weight: 600;
  color: var(--yonder-text);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  text-align: right;
}

/* ---- buttons ---------------------------------------------------------
   Sized to their words, not stretched across the group. Vuetify ships block
   buttons and uppercase labels; a 700px solid slab reading SCAN FOR NETWORKS
   reads as a warning rather than an action. */
.nrdb-ui-button .v-btn,
.nrdb-ui-form-actions .v-btn {
  text-transform: none !important;
  letter-spacing: 0 !important;
  font-weight: 600;
  font-size: var(--yonder-size-body);
  min-height: var(--yonder-touch);
  border-radius: var(--yonder-radius);
  box-shadow: none !important;
  padding-inline: var(--yonder-space-5);
}

.nrdb-ui-button .v-btn.v-btn--block {
  width: auto;
  min-width: 12rem;
}

/* Below this the column is too narrow for a button to sit beside anything,
   so it may as well take the width and be easy to hit. */
@media (max-width: 599px) {
  .nrdb-ui-button .v-btn.v-btn--block { width: 100%; }
}

.v-btn--variant-flat {
  background: var(--yonder-accent) !important;
  color: var(--yonder-on-tone) !important;
}

.v-btn--variant-outlined {
  border: 1px solid var(--yonder-border) !important;
  color: var(--yonder-text) !important;
}

/* ---- inputs ---------------------------------------------------------- */
.nrdb-ui-text-field input,
.nrdb-ui-form input {
  font-family: var(--yonder-font);
  font-size: var(--yonder-size-body);
  color: var(--yonder-text);
}

/* Visible, and visible in both palettes. A field device gets driven by
   keyboard more often than a desktop one, because a tablet keyboard is what
   is to hand. */
:focus-visible {
  outline: 2px solid var(--yonder-accent);
  outline-offset: 2px;
}

/* ---- tables ---------------------------------------------------------- */
.nrdb-ui-table table,
.v-data-table {
  background: transparent !important;
  color: var(--yonder-text) !important;
}

.v-data-table th,
.v-data-table-header__content {
  font-size: var(--yonder-size-label) !important;
  font-weight: 600 !important;
  color: var(--yonder-muted) !important;
  letter-spacing: 0.02em;
}

.v-data-table td {
  font-size: var(--yonder-size-body) !important;
  color: var(--yonder-text) !important;
  min-height: var(--yonder-touch);
  border-bottom: 1px solid var(--yonder-border) !important;
}

/* Signal strengths and channel numbers are quantities; an SSID is a name you
   compare character by character. */
.v-data-table td:not(:first-child) {
  font-variant-numeric: tabular-nums;
}

.v-data-table-rows-no-data {
  color: var(--yonder-muted) !important;
  font-size: var(--yonder-size-body);
  padding: var(--yonder-space-5) var(--yonder-space-4) !important;
}

/* ---- prose ------------------------------------------------------------
   The notes on these pages carry the parts an operator has to understand
   before pressing something - what happens to the access point, how long
   they have to confirm. They are content, not chrome, so they get a reading
   measure and a reading line-height. */
.nrdb-ui-markdown,
.nrdb-ui-markdown-content {
  font-size: var(--yonder-size-body);
  line-height: 1.55;
  color: var(--yonder-text);
  max-width: 68ch;
}

.nrdb-ui-markdown-content strong { font-weight: 600; }

.nrdb-ui-markdown-content code {
  font-family: var(--yonder-font-mono);
  font-size: 0.9375em;
  background: var(--yonder-background);
  border: 1px solid var(--yonder-border);
  border-radius: 3px;
  padding: 0.05em 0.35em;
}

.nrdb-ui-markdown-content h3 {
  font-size: var(--yonder-size-page);
  font-weight: 600;
  margin: var(--yonder-space-2) 0 var(--yonder-space-3);
}

.nrdb-ui-markdown-content hr {
  border: 0;
  border-top: 1px solid var(--yonder-border);
  margin: var(--yonder-space-4) 0;
}

/* ---- the command-state language, in CSS ------------------------------
   The tone names come from console/command.ts, so a control cannot mean one
   thing on one page and something else on another (ADR-0005, R-UI-05). */
.yonder-tone-neutral { color: var(--yonder-neutral); }
.yonder-tone-waiting { color: var(--yonder-waiting); font-weight: 600; }
.yonder-tone-good    { color: var(--yonder-good); font-weight: 600; }
.yonder-tone-bad     { color: var(--yonder-bad); font-weight: 600; }

.yonder-note {
  color: var(--yonder-muted);
  line-height: 1.55;
  max-width: 68ch;
}

.yonder-warning {
  border-left: 4px solid var(--yonder-waiting);
  padding: var(--yonder-space-3) var(--yonder-space-4);
  background: var(--yonder-surface);
  color: var(--yonder-text);
  line-height: 1.55;
  border-radius: 0 var(--yonder-radius) var(--yonder-radius) 0;
}
`;
}
