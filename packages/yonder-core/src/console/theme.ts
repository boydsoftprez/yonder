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

  /* ---- the instrument roles (ADR-0009) -------------------------------
     Named for what they mean, not for a colour. `cyan` set to amber at
     night would be a stylesheet that lies about itself. */

  /** The face an instrument is drawn on. */
  display: string;
  /** A recess within it: a meter track, a tape scale. */
  pane: string;
  /** Hairlines between instruments. */
  divider: string;
  /** A micro-label above or beside a reading. */
  label: string;
  /** The reading itself. */
  value: string;
  /** An unfilled meter track. */
  track: string;
  /** Something addressable or selected — an address, a bug on a tape. */
  select: string;
  /** The one control on a page that takes the page away from the operator. */
  irreversible: string;
}

/**
 * Day — the display at daylight brightness (ADR-0009).
 *
 * Not a light page. ADR-0009 settled the console as a glass cockpit display
 * mounted in a carbon panel, and a multi-function display does not turn white
 * at noon: it lifts its levels. So day and night are the same layout in the
 * same materials at two brightnesses, which is what R-UI-07 has been asking
 * for and what a light-page day mode could never be.
 *
 * The cost is named in ADR-0009's Open section and is not hidden here: a real
 * MFD is legible at noon because it is a high-brightness transflective panel
 * and a consumer tablet is not. If the field says so, the answer is a third,
 * genuinely light palette — the layout does not change to add one.
 */
const DAY: Palette = {
  // The page behind the display is the panel: carbon, painted as an image in
  // the chrome section below. This is its base colour, and what shows through.
  background: "#12151a",
  // The display face itself, lifted for daylight.
  surface: "#0c1015",
  border: "#3e4854",
  text: "#ffffff",
  muted: "#9aa6b2",
  accent: "#4fe0f7",
  neutral: "#7f8a95",
  waiting: "#ffd944",
  good: "#4ee07f",
  bad: "#ff5a4e",
  onTone: "#04060a",
  display: "#0c1015",
  pane: "#11161c",
  divider: "#3e4854",
  label: "#9aa6b2",
  value: "#ffffff",
  track: "#1f262e",
  select: "#4fe0f7",
  irreversible: "#ff6fd8",
};

/**
 * Night — the same display, dimmer.
 *
 * Every value here is the day one brought down; nothing moves, nothing is
 * renamed, no element appears or disappears. That is the whole point of
 * ADR-0009's "one design in two materials": the operator who learns this
 * console in daylight is looking at the same instrument after dusk.
 */
const NIGHT: Palette = {
  background: "#0a0c0f",
  surface: "#04060a",
  border: "#2b333c",
  text: "#e8ecf0",
  muted: "#7f8a95",
  accent: "#2ad4f0",
  neutral: "#6b7580",
  waiting: "#ffcf28",
  good: "#35d06a",
  bad: "#ff4034",
  onTone: "#04060a",
  display: "#04060a",
  pane: "#090d12",
  divider: "#2b333c",
  label: "#7f8a95",
  value: "#e8ecf0",
  track: "#161b21",
  select: "#2ad4f0",
  irreversible: "#f03fce",
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

  /* ---- the instrument roles (ADR-0009) ------------------------------
     Read by the components in node-red-dashboard-2-yonder. They carry
     fallbacks, so a widget still draws if this sheet has not arrived - but
     the fallbacks are night values, and on a day board that would be the
     one thing you must not put in front of an eye. These are what make
     day and night one design in two materials rather than two designs. */
  --yonder-display: ${p.display};
  --yonder-pane: ${p.pane};
  --yonder-divider: ${p.divider};
  --yonder-label: ${p.label};
  --yonder-value: ${p.value};
  --yonder-track: ${p.track};
  --yonder-select: ${p.select};
  --yonder-irreversible: ${p.irreversible};

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
  --v-theme-surface: var(--yonder-display);
  --v-theme-on-background: var(--yonder-value);
  --v-theme-on-surface: var(--yonder-value);
  --v-theme-primary: var(--yonder-select);
  --nrdb-page-background: transparent;
  --nrdb-group-background: var(--yonder-display);
  --nrdb-group-border: var(--yonder-divider);
  --nrdb-group-text: var(--yonder-value);
  --nrdb-page-text: var(--yonder-value);
  --nrdb-page-sidebar-background: transparent;
}

html, body {
  background: var(--yonder-background);
  color: var(--yonder-text);
  font-family: var(--yonder-font);
  font-size: var(--yonder-size-body);
  -webkit-text-size-adjust: 100%;
}

/* ---- carbon -----------------------------------------------------------
   The panel the display is mounted in (ADR-0009).

   A 2x2 twill from four offset checker gradients, a raked sheen across the
   whole surface, and a fine grain pass. **Generated, never fetched and never
   shipped as an image** (R-UI-01, R-UI-13): it costs no request, it scales to
   any display, and it follows the palette instead of needing a second file
   per theme.

   The weave is 16px. Smaller reads as noise at arm's length; larger reads as
   a checkerboard. The first attempt used four tones within ten RGB values of
   each other and rendered as nothing at all, which is a way of getting this
   wrong that survives code review and dies the moment somebody looks.

   The sheen is a soft radial from the top left rather than a raking linear
   one. A linear sheen across the whole page lit one corner and washed the
   weave out of everywhere else - fine on a 200px swatch, wrong on a 1280px
   panel, and only visible in a capture. */
.nrdb-app,
.v-application,
.v-application__wrap {
  background-color: #12151a;
  background-image:
    radial-gradient(120% 80% at 22% 0%, rgba(255,255,255,0.07), transparent 62%),
    repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 4px),
    linear-gradient(45deg, #2c333d 25%, transparent 25%, transparent 75%, #2c333d 75%),
    linear-gradient(45deg, #2c333d 25%, transparent 25%, transparent 75%, #2c333d 75%),
    linear-gradient(135deg, #090b0e 25%, transparent 25%, transparent 75%, #090b0e 75%),
    linear-gradient(135deg, #090b0e 25%, transparent 25%, transparent 75%, #090b0e 75%);
  background-size: 100% 100%, 6px 6px, 16px 16px, 16px 16px, 16px 16px, 16px 16px;
  background-position: 0 0, 0 0, 0 0, 8px 8px, 0 0, 8px 8px;
  background-attachment: fixed;
}

/* ---- the bar across the top -----------------------------------------
   Machined chrome, not a white slab. It carries the wordmark as a placard:
   letterspaced caps with a dark shadow, the way a legend is engraved into a
   panel rather than printed on a card. */
.v-app-bar,
.v-app-bar.v-toolbar {
  background: transparent !important;
  color: var(--yonder-value) !important;
  border-bottom: 1px solid rgba(0, 0, 0, 0.6);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) !important;
}

.v-app-bar-title,
.v-app-bar-title .v-toolbar-title__placeholder {
  font-size: 0.9375rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--yonder-value);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.85);
}

.v-app-bar-title::before {
  content: "YONDER";
  display: inline-block;
  margin-right: var(--yonder-space-3);
  padding-right: var(--yonder-space-3);
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.07);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.22em;
  color: var(--yonder-select);
  vertical-align: baseline;
}

/* The navigation drawer is panel, not page. */
.v-navigation-drawer {
  background: rgba(6, 8, 11, 0.72) !important;
  color: var(--yonder-label) !important;
  border-right: 1px solid rgba(0, 0, 0, 0.6) !important;
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.05);
}

.v-navigation-drawer .v-list-item-title {
  font-family: var(--yonder-font-mono);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.v-navigation-drawer .v-list-item--active .v-list-item-title {
  color: var(--yonder-value);
}

.v-navigation-drawer .v-list-item--active {
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 2px 0 0 var(--yonder-select);
}

/* ---- groups: a display seated in the panel ----------------------------
   Not a white card. A dark display face inside a machined bezel: a hard dark
   outer edge, a lit inner lip, and a drop shadow so it reads as mounted
   rather than drawn. */
.nrdb-ui-group > .v-card {
  background: var(--yonder-display) !important;
  border: 1px solid #000 !important;
  border-radius: 3px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 6px 18px rgba(0, 0, 0, 0.55) !important;
  color: var(--yonder-value);
}

/* The group's name as a placard: letterspaced caps on the bezel, engraved. */
.nrdb-ui-group .v-card-title {
  font-family: var(--yonder-font-mono);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--yonder-label);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.8);
  padding: var(--yonder-space-3) var(--yonder-space-4);
  border-bottom: 1px solid var(--yonder-divider);
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

/* A form's own submit is the one action not on the rail, because it belongs
   to the field above it. It is still machined rather than flat. */
.v-btn--variant-flat {
  background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(0,0,0,0.28)),
              var(--yonder-select) !important;
  color: #04060a !important;
  border: 1px solid rgba(0, 0, 0, 0.55) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.28) !important;
}

.v-btn--variant-outlined {
  border: 1px solid var(--yonder-divider) !important;
  color: var(--yonder-value) !important;
  background: rgba(255, 255, 255, 0.04) !important;
}

/* ---- inputs ---------------------------------------------------------- */
.nrdb-ui-text-field input,
.nrdb-ui-form input {
  font-family: var(--yonder-font);
  font-size: var(--yonder-size-body);
  color: var(--yonder-value);
}

/* A field is a recess in the panel, not a white box laid on it. */
.nrdb-ui-form .v-field,
.nrdb-ui-text-field .v-field {
  background: var(--yonder-pane) !important;
  border-radius: 2px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6);
}

.nrdb-ui-form .v-field__outline,
.nrdb-ui-text-field .v-field__outline {
  --v-field-border-opacity: 1;
  color: var(--yonder-divider);
}

.nrdb-ui-form label,
.nrdb-ui-form .v-label {
  color: var(--yonder-label) !important;
  opacity: 1 !important;
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
  color: var(--yonder-value) !important;
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
  color: var(--yonder-value);
  max-width: 68ch;
}

.nrdb-ui-markdown-content strong { font-weight: 600; }

.nrdb-ui-markdown-content code {
  font-family: var(--yonder-font-mono);
  font-size: 0.9375em;
  color: var(--yonder-select);
  background: var(--yonder-pane);
  border: 1px solid var(--yonder-divider);
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

/* ---- content is never clipped ----------------------------------------
   A Dashboard widget takes its height from a configured row span, and some
   content has no row count that is right at every width: the same words are
   taller on a narrower screen, in a larger system font, in another language,
   and a form is as tall as the fields it holds however many rows somebody
   typed into the editor.

   The default silently wins that argument with overflow: auto. On the first
   board this ran on, the Network page's "Read this before you join a network"
   was 706px of text in a 372px widget - 39% of it behind an inner scrollbar
   that nothing indicated was there. That is the warning which tells an
   operator the access point is about to disappear, where to find the device
   afterwards, and that they have five minutes to confirm before it all rolls
   back. It is the mitigation this project deliberately wrote for K-13, and
   an operator would have read the first half, pressed Join, and lost the page
   before reaching the part that says what to do next.

   **That fix was scoped too narrowly, and the capture gate found the rest.**
   It named the defect "prose", so it covered markdown and stopped. Forms have
   the identical problem for the identical reason, and two of them shipped
   clipped: the join form was 172px of content in 48px with 72% hidden, and
   the ping form 112px in 48px with 57% hidden. The join form is the one an
   operator fills in immediately *after* reading the warning above - so the
   page explained carefully what pressing Join would cost, and then hid the
   field they had to type into to do it (K-27).

   The rule is not about prose. It is: **a widget whose height is a function
   of its content, rather than of its shape, sizes to that content and the
   grid takes the rows it needs.** A fixed height is legitimate for a chart or
   a gauge, where the shape is the point. It is never legitimate for something
   an operator has to read or fill in.

   Anything added here needs the same test in theme.test.ts, because the cost
   of getting it wrong is silent. */
.nrdb-ui-widget.nrdb-ui-markdown,
.nrdb-ui-widget.nrdb-ui-form {
  grid-row-end: auto !important;
  grid-template-rows: none !important;
  height: auto !important;
  min-height: 0;
  overflow: visible !important;
}

/* The form's own inner box, which is a second place the same clipping can
   happen: the widget growing does nothing if what is inside it still scrolls.
   Both are needed, and only one of them is visible in a stylesheet diff. */
.nrdb-ui-form .nrdb-ui-form-content,
.nrdb-ui-form form {
  height: auto !important;
  min-height: 0;
  overflow: visible !important;
}

/* ---- the command-state language, in CSS ------------------------------
   The tone names come from console/command.ts, so a control cannot mean one
   thing on one page and something else on another (ADR-0005, R-UI-05). */
.yonder-tone-neutral { color: var(--yonder-neutral); }
.yonder-tone-waiting { color: var(--yonder-waiting); font-weight: 600; }
.yonder-tone-good    { color: var(--yonder-good); font-weight: 600; }
.yonder-tone-bad     { color: var(--yonder-bad); font-weight: 600; }

/* The soft-key rail's group: part of the bezel, not another instrument. */
.nrdb-ui-group.yonder-rail > .v-card,
.yonder-rail > .v-card {
  background: rgba(0, 0, 0, 0.35) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 0 0 1px rgba(0, 0, 0, 0.7) !important;
}

.yonder-note {
  color: var(--yonder-label);
  line-height: 1.55;
  max-width: 68ch;
}

/* The boundary you have to understand before you cross it. A hard rule and a
   band fading inward, the way a chart marks one. */
.yonder-warning {
  border-left: 4px solid var(--yonder-waiting);
  padding: var(--yonder-space-3) var(--yonder-space-4);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--yonder-waiting) 16%, transparent), transparent 90px),
    var(--yonder-pane);
  color: var(--yonder-value);
  line-height: 1.55;
  border-radius: 0 var(--yonder-radius) var(--yonder-radius) 0;
}
`;
}
