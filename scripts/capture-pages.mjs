// SPDX-License-Identifier: GPL-3.0-or-later
//
// The capture gate (R-UI-12).
//
// "Capture every page in both palettes on every build, and fail the build when
// a page changes shape unreviewed. A console nobody looks at is a console
// nobody has checked."
//
// That requirement exists because of a specific failure. The Network page's
// "Read this before you join a network" — the warning that tells an operator
// the access point is about to disappear and that they have five minutes to
// confirm — was 706 px of text in a 372 px widget. 39% of it was behind an
// inner scrollbar that nothing indicated was there. Every unit test passed.
// The daemon was right, the flows were right, the words were right, and the
// page was wrong, because nothing in this repository had ever looked at one.
//
// So this does three things, and they are deliberately different from each
// other:
//
//   1. **Rules.** Checks that a page cannot violate ADR-0009 silently: nothing
//      clipped, no action spanning its container, no page scrolling sideways,
//      no control whose text cannot be read against what is behind it
//      (R-UI-16), no page rendering nothing at all. These fail the build on
//      their own.
//   2. **Shape.** A manifest of every widget's geometry, committed and diffed.
//      Geometry rather than pixels, because "shape" is what the requirement
//      says and because a pixel diff across macOS and CI is a coin toss about
//      font rasterisation, not a check.
//   3. **A picture.** Written on every run so somebody can look. The committed
//      copy masks live readings — a load average changes between two runs and
//      would make the file dirty forever — so what it records is the layout.
//      The unmasked copy goes to an artifact directory for the full view.
//
// Usage:
//   node scripts/capture-pages.mjs --base-url URL --password PW --palette day
//   node scripts/capture-pages.mjs ... --accept     # adopt the new shape
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The pages, from the shipped flows rather than a list beside them. */
function pagesFromFlows() {
  const flows = JSON.parse(readFileSync(join(REPO, "flows/flows.json"), "utf8"));
  const base = flows.find((n) => n.type === "ui-base");
  const out = [];
  for (const p of flows.filter((n) => n.type === "ui-page")) {
    const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const url = (base?.path ?? "/dashboard") + p.path;
    // A tabbed page shows one group at a time, so "every page" would quietly
    // mean "the first tab" unless each tab is captured in its own right
    // (R-UI-12). The tab's label is its group's name.
    if (p.layout === "tabs") {
      const tabs = flows
        .filter((n) => n.type === "ui-group" && n.page === p.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const [i, g] of tabs.entries()) {
        out.push({
          name: `${slug}-${String(g.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          title: `${p.name} · ${g.name}`,
          url,
          tabIndex: i,
        });
      }
    } else {
      out.push({ name: slug, title: p.name, url });
    }
  }
  return out;
}

/**
 * What carries a live reading.
 *
 * These are masked in the committed picture and excluded from the shape
 * manifest's text, because their content changes between two runs of the same
 * console and neither the picture nor the manifest is about their values.
 */
const LIVE = [
  ".nrdb-ui-text-value",
  ".v-data-table td",
  ".y-gauge__value",
  ".y-bar__v",
  ".tape__box",
  // An annunciator caption is normally a state word — NOTHING, CONNECTED —
  // and those are exactly what somebody looking at these pictures needs to
  // read, so the widget is not masked as a kind. `CHANGE PENDING`'s is the
  // one that is a *reading*: a countdown, different on every run, which would
  // leave that committed picture permanently dirty. The widget says so about
  // itself with `yonder-live`, so nothing here has to know which page it is
  // on. The lamp and its box are untouched — the *caption* goes whole, the
  // word with the digits, because `YonderAnnunciator.vue` draws both in one
  // `.y-ann__text` and there is no smaller element to mask. The two lines
  // under it wear `yonder-fixed`, so what the banner is about is still
  // readable in the picture.
  ".yonder-live .y-ann__text",
];

/**
 * The exception to the list above: a widget that has said its values are the
 * same on every run.
 *
 * The kinds in `LIVE` are masked because *most* instances of them carry a
 * reading — a board's uptime, a load average, a countdown. `IF YOU LOSE THIS
 * CONSOLE` is the first panel whose values carry none: an SSID, an address, a
 * hostname, and either the published passphrase or the sentence that stands
 * in for a changed one. Masking those would commit a picture of the panel
 * with its content removed — and the two states R-UI-18 has to be seen in
 * would be indistinguishable in the artefact, which is most of the reason for
 * capturing the second one.
 *
 * The widget says so about itself, the mirror of the `yonder-live` the
 * pending countdown wears, so nothing here has to know which page it is on.
 * Nothing else may wear it: a value that moves and claims not to leaves a
 * committed picture dirty on every run, which is the failure the masking
 * exists to prevent.
 */
const FIXED = ".yonder-fixed";

/** Fixed, so geometry means the same thing on a laptop and on a CI runner. */
const VIEWPORT = { width: 1280, height: 900 };

/**
 * The debt list.
 *
 * These pages were built before ADR-0009 and they break its rules — that is
 * the reason the rules exist. A gate that failed on all of it from the first
 * run would be a gate somebody turned off within a week, so each known
 * violation is written down here, once, with a reason.
 *
 * It can only shrink. A finding not on the list fails the build, and an entry
 * on the list that no longer matches anything **also** fails, with "this is
 * fixed, delete the line" — because a debt list nobody prunes stops being a
 * list of debts and becomes a list of excuses.
 */
function acceptedViolations(dir) {
  const path = join(dir, "accepted-violations.json");
  if (!existsSync(path)) return { path, entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { path, entries: parsed.accepted ?? [] };
}

const matches = (entry, f) =>
  entry.rule === f.rule &&
  entry.page === f.page &&
  (entry.palette === "*" || entry.palette === f.palette) &&
  entry.key === f.key;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const baseUrl = arg("base-url", "http://127.0.0.1:18881");
const password = arg("password");
const palette = arg("palette", "day");
/**
 * Relative to the repository, or absolute if that is what was given.
 *
 * `join("/repo", "/tmp/x")` is `/repo/tmp/x`, not `/tmp/x` — so a caller
 * passing an absolute path got a directory created *inside the working tree*,
 * silently, with a name that looked like a system path. It happened here.
 */
const under = (value, fallback) => {
  const given = value ?? fallback;
  return isAbsolute(given) ? given : join(REPO, given);
};

const refs = under(arg("refs"), "docs/console");
const artifacts = under(arg("artifacts"), "vendor/capture");
const accept = has("accept");
/**
 * A soft key to press once the pages are captured.
 *
 * This exists because of a bug no layout check could see. Dashboard drops a
 * `widget-action` unless the widget registered `onAction`, silently — so every
 * soft key on every page shipped dead. The nodes were right, the wiring was
 * right, the pages captured correctly, and pressing a key did nothing at all.
 *
 * The gate already had to change palette to photograph the second one. Doing
 * that by pressing the actual control, rather than by posting to the socket,
 * turns a setup step into the only end-to-end proof that a control on this
 * console does anything.
 */
const press = arg("press");
/**
 * One page, under a name of its own.
 *
 * R-UI-12 says a surface that hides part of itself is captured in each of
 * those parts, and a panel drawn from live state hides its other states the
 * same way a tab hides its siblings. The `Way out` rows have four — a path
 * that is reaching something, one that reached nothing when it was last
 * tested, one nothing has looked at, and one whose interface is down.
 *
 * **They are not four different geometries, and the reference used to claim
 * they were.** An annunciator is `inline-flex` inside a grid-fixed wrapper
 * and the qualifier wraps to one line in every state, so no box moves: the
 * four committed files came out byte-identical to their bases and asserted
 * nothing. What actually differs is the words, which is why the manifest
 * records the text of anything wearing `yonder-fixed` — see `measure()`.
 *
 * The alternative was a second mechanism that drove state and photographed it
 * separately. This is the same one, told which page to take and what to call
 * the file, so a state capture is enforced by exactly the rules and the shape
 * reference every other page is.
 */
const only = arg("only");
const as = arg("as");

if (!password) {
  process.stderr.write("capture-pages: --password is required\n");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  process.stderr.write(
    "capture-pages: playwright is not installed.\n" +
    "  npm install --save-dev playwright && npx playwright install --with-deps chromium\n",
  );
  process.exit(2);
}

/**
 * Everything measured inside the page.
 *
 * Runs in the browser, so it can only use what is on the page. Returns plain
 * data; every judgement about it is made out here where it can be read.
 */
function measure([liveSelectors, fixedSelector]) {
  const round = (n) => Math.round(n);
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  };

  /**
   * A key that survives a reorder of unrelated widgets. The element's own
   * classes plus its position among its siblings — not an index into a flat
   * list, which would renumber everything below an insertion and report five
   * changes where there was one.
   */
  const keyOf = (el) => {
    const cls = [...el.classList]
      .filter((c) => !/^(v-|mdi-)/.test(c) && !c.includes("theme--"))
      .sort()
      .join(".");
    const siblings = [...(el.parentElement?.children ?? [])].filter(
      (s) => s.className === el.className,
    );
    const nth = siblings.indexOf(el);
    return cls + (siblings.length > 1 ? `#${nth}` : "");
  };

  const widgets = [...document.querySelectorAll('[class*="nrdb-ui-widget"], [class*="nrdb-ui-group"]')];

  /**
   * Content that does not fit its box, either way it fails.
   *
   * A scrollable box hides the excess — that is K-13, 39% of a safety warning
   * behind an inner scrollbar nothing indicated was there. A box that does
   * *not* scroll lets the excess escape instead, and the next widget is
   * painted over the top of it. Same cause, opposite symptom, and this check
   * only looked for the first one until an operator spotted the second: a
   * dropdown 48px tall with 70px of content, its message under the password
   * field that follows it.
   */
  const clipped = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    const scrolls = /auto|scroll|hidden/.test(style.overflowY);
    const isWidget = /nrdb-ui-widget/.test(el.className || "");
    // A scroller hides its overflow; a widget that does not scroll spills it
    // onto whatever is drawn next. Both are content that does not fit.
    if (!scrolls && !isWidget) continue;
    if (el.scrollHeight <= el.clientHeight + 2) continue;
    if (el.clientHeight === 0) continue;
    // The page's own scroller. A console taller than the window is a page you
    // scroll, not content that is hidden — the defect is a box *inside* the
    // page clipping what it holds.
    if (el === document.documentElement || el === document.body) continue;
    if (el.clientHeight >= window.innerHeight - 4) continue;
    // A table body scrolling is a table doing its job. Prose is not.
    if (el.closest(".v-data-table__wrapper, .v-table__wrapper")) continue;
    clipped.push({
      key: keyOf(el),
      how: scrolls ? "hides" : "spills over what follows it",
      visible: el.clientHeight,
      content: el.scrollHeight,
      hidden: Math.round((1 - el.clientHeight / el.scrollHeight) * 100),
      text: (el.textContent ?? "").trim().slice(0, 80),
    });
  }

  /**
   * An action spanning the surface it sits on. R-UI-10, checked in the DOM
   * rather than over the flows, because a widget width of "auto" that CSS
   * then stretches is exactly the case a JSON check cannot see.
   */
  const spanning = [];
  for (const el of document.querySelectorAll("button, .nrdb-ui-button .v-btn")) {
    const parent = el.parentElement;
    if (!parent) continue;
    const own = el.getBoundingClientRect().width;
    const around = parent.getBoundingClientRect().width;
    if (around < 8 || own / around < 0.9) continue;
    if (own < 240) continue; // a narrow column is allowed to be filled
    spanning.push({
      key: keyOf(el),
      label: (el.textContent ?? "").trim().slice(0, 40),
      width: Math.round(own),
      of: Math.round(around),
    });
  }

  /**
   * Text on a control that cannot be read against what is behind it (R-UI-16).
   *
   * This is the check the picture could not make. An operator reported that
   * in the night palette the text in the entry fields was "not able to be
   * read by human eyes"; every unit test passed, the shape reference was
   * unchanged, and the committed capture showed the words — at 1.05:1 against
   * their own recess, which is a picture of the defect that looks like a
   * picture of an empty field.
   *
   * **Computed colours, not pixels.** Each control's own colour is composited
   * over everything painted behind it, with the alpha and the accumulated
   * `opacity` of its ancestors folded in — because what made those labels
   * unreadable was Vuetify drawing black at 60% opacity, and a rule that read
   * `color` alone would have called that black and passed it in the day
   * palette for the same reason it failed in night.
   *
   * **Controls only.** The threshold is WCAG AA for body text, and the
   * console's own controls clear it in both palettes with room: the tightest
   * measured is 4.63:1 (a day label on a day recess) and most are 5.5–12.8:1.
   * Instrument faces, annunciator lamps and gauge bands are deliberately
   * coloured against their own backgrounds and are a different question; this
   * one is about the text that says what to type and the text that was typed.
   */
  const rgba = (s) => {
    const n = (s.match(/-?[\d.]+/g) ?? []).map(Number);
    return n.length >= 3 ? { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 } : null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = (c) => {
    const f = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // Everything painted behind this element, composited bottom-up. The page
  // itself is the floor: a transparent stack over a transparent body is still
  // read against something, and white is the browser's own answer.
  const behind = (el) => {
    const stack = [];
    for (let a = el; a !== null; a = a.parentElement) {
      const c = rgba(getComputedStyle(a).backgroundColor);
      if (c !== null && c.a > 0) stack.push(c);
    }
    let ground = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) ground = over(stack[i], ground);
    return ground;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let a = el; a !== null; a = a.parentElement) o *= Number(getComputedStyle(a).opacity || 1);
    return o;
  };

  const unreadable = [];
  const CONTROL_TEXT = [
    ".nrdb-ui-widget input", ".nrdb-ui-widget textarea", ".nrdb-ui-widget .v-label",
    ".nrdb-ui-widget label", ".nrdb-ui-widget .v-field__input",
    ".nrdb-ui-widget .v-select__selection-text", ".nrdb-ui-widget .v-messages__message",
    // The table's own search box is not inside a widget wrapper of its own,
    // and it is a field an operator types into. It measured 1.03:1.
    ".nrdb-ui-table-wrapper input", ".nrdb-ui-table-wrapper .v-label",
  ].join(",");
  for (const el of document.querySelectorAll(CONTROL_TEXT)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    const fill = style.webkitTextFillColor;
    const own = rgba(fill && fill !== "currentcolor" ? fill : style.color);
    if (own === null) continue;
    const ground = behind(el);
    const shown = over({ ...own, a: own.a * opacityOf(el) }, ground);
    const ratio = contrast(shown, ground);
    if (ratio >= 4.5) continue;
    unreadable.push({
      // `keyOf` drops framework classes, which is right for a widget and
      // leaves nothing at all for a Vuetify label — every class it has is a
      // `v-` one. So the framework's own two are kept here, because a finding
      // with an empty key cannot be told from another finding with an empty
      // key, either by a reader or by the debt list.
      key: keyOf(el) || `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => /^v-/.test(c)).slice(0, 2).join(".")}`,
      text: (el.tagName === "INPUT" ? (el.value || el.placeholder || "") : (el.textContent ?? "")).trim().slice(0, 40),
      color: style.color,
      opacity: Number(opacityOf(el).toFixed(2)),
      on: `rgb(${Math.round(ground.r)},${Math.round(ground.g)},${Math.round(ground.b)})`,
      ratio: Number(ratio.toFixed(2)),
    });
  }

  /**
   * What the committed picture masks, decided here and marked on the page.
   *
   * Marked rather than returned, because the caller needs Playwright locators
   * and this needs an ancestor test — "not inside a widget that declared
   * itself fixed" — which CSS has no combinator for and `element.closest`
   * does in one call. One attribute, set once, and the screenshot masks
   * exactly the elements this decided on.
   */
  const live = new Set();
  for (const sel of liveSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest(fixedSelector)) continue;
      live.add(el);
      el.setAttribute("data-yonder-mask", "");
    }
  }

  /**
   * The words on anything that has declared itself fixed.
   *
   * Geometry alone could not tell four of these states apart. The `Way out`
   * rows differ by a sentence and a lamp caption; an annunciator is
   * `inline-flex` inside a grid-fixed wrapper and the qualifier wraps to one
   * line in every state, so *no box moves* — and the four state references
   * came out byte-identical to their bases, asserting nothing the base did
   * not already assert. Same for `status-psk-changed`, whose whole subject is
   * one cell's text.
   *
   * `yonder-fixed` is the one declaration on this console that a value is the
   * same on every run, which is exactly the licence needed to freeze its
   * text. Nothing else's text is recorded: a load average in a reference
   * would leave it dirty for ever, which is what the masking exists to
   * prevent.
   */
  const fixed = [...document.querySelectorAll(fixedSelector)].map((el) => ({
    key: keyOf(el),
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  })).filter((f) => f.text !== "");

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    widgets: widgets.map((el) => ({ key: keyOf(el), box: boxOf(el) })),
    liveBoxes: [...live].map(boxOf).filter((b) => b.w > 0 && b.h > 0),
    fixed,
    clipped,
    spanning,
    unreadable,
  };
}

// ---------------------------------------------------------------------------

let pages = pagesFromFlows();
if (only !== undefined) {
  pages = pages.filter((p) => p.name === only);
  if (pages.length === 0) {
    process.stderr.write(`capture-pages: no page called "${only}" in the shipped flows\n`);
    process.exit(2);
  }
  if (as !== undefined) pages = pages.map((p) => ({ ...p, name: as, title: as }));
}
mkdirSync(join(refs, "shape"), { recursive: true });
mkdirSync(join(refs, "capture"), { recursive: true });
mkdirSync(artifacts, { recursive: true });

const debt = acceptedViolations(refs);
const seen = new Set();

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  colorScheme: "light",
});

// The console's own form login, so the capture goes through the gate every
// other client does rather than around it.
const login = await context.request.post(`${baseUrl}/login`, { form: { password } });
if (!login.ok()) {
  process.stderr.write(`capture-pages: sign-in failed (${login.status()})\n`);
  await browser.close();
  process.exit(1);
}

let failures = 0;
let changed = 0;
const note = (s) => process.stdout.write(s + "\n");

for (const page of pages) {
  const tab = await context.newPage();

  // A page that throws, or whose widget bundle 404s, renders as an empty box
  // and says nothing. That is how the first build of the instrument widgets
  // looked: every node registered, every group resolved, and the page drew
  // blank. Console errors and failed requests are collected so the gate can
  // say what happened instead of leaving a picture of nothing.
  const noise = [];
  tab.on("console", (m) => {
    if (m.type() === "error") noise.push(`console: ${m.text().slice(0, 200)}`);
  });
  tab.on("pageerror", (e) => noise.push(`uncaught: ${String(e.message).slice(0, 200)}`));
  tab.on("requestfailed", (r) => noise.push(`request failed: ${r.url().slice(-90)}`));
  tab.on("response", (r) => {
    if (r.status() >= 400) noise.push(`HTTP ${r.status()}: ${r.url().slice(-90)}`);
  });

  await tab.goto(baseUrl + page.url, { waitUntil: "networkidle" });
  // The dashboard renders its widgets after the socket connects, so waiting on
  // the network alone captures an empty page.
  await tab.waitForSelector('[class*="nrdb-ui-widget"], [class*="nrdb-ui-group"]', { timeout: 15000 })
    .catch(() => {});
  await tab.waitForTimeout(400);

  // Select this entry's tab. Vuetify renders every tab's panel but shows one,
  // so the click is what makes the measured shape the shape a person sees.
  //
  // 700ms, not 400: the click itself leaves a `v-ripple__container` clipped
  // by the tab's own overflow while its ripple animation finishes, which
  // `measure()` cannot tell apart from real content hidden behind a
  // scrollbar. 400ms still caught it mid-animation on every tab in this
  // page and failed the gate on a ripple, not a defect. 700ms was the
  // shortest wait, measured here, that let the animation finish first.
  if (page.tabIndex !== undefined) {
    const tabs = tab.locator('.v-tab, [role="tab"]');
    if ((await tabs.count()) > page.tabIndex) {
      await tabs.nth(page.tabIndex).click();
      await tab.waitForTimeout(700);
    }
  }

  const shape = await tab.evaluate(measure, [LIVE, FIXED]);
  const stem = `${page.name}.${palette}`;

  // The picture. Masked for the committed copy — a load average changes
  // between two runs and would leave the file permanently dirty — and whole
  // for the artifact a person actually looks at.
  //
  // The elements were marked by `measure()` a moment ago rather than selected
  // again here, so there is one decision about what is live rather than the
  // same list applied twice by two mechanisms that can drift.
  const masks = [tab.locator("[data-yonder-mask]")];
  await tab.screenshot({
    path: join(refs, "capture", `${stem}.png`),
    fullPage: true,
    mask: masks,
    // Opaque, and that is the whole point. This was #8891993d - 24% alpha -
    // so a live reading showed straight through its own mask and the
    // committed picture changed on every run: a load average, a timestamp, a
    // temporary directory name in the activity log. A mask you can read
    // through is not a mask, it is a tint.
    maskColor: "#8b8f94",
  });
  await tab.screenshot({ path: join(artifacts, `${stem}.png`), fullPage: true });

  // ---- rules ----
  // A finding on the debt list is reported and not counted; anything else
  // fails. Nothing is silently tolerated either way — the point of looking is
  // to see what is there.
  const report = (finding, line, detail) => {
    const known = debt.entries.find((e) => matches(e, finding));
    if (known) {
      seen.add(known);
      note(`  debt  ${line}`);
      if (known.note) note(`          accepted: ${known.note}`);
      return;
    }
    note(`  FAIL  ${line}`);
    if (detail) note(`          ${detail}`);
    failures += 1;
  };

  if (shape.widgets.length === 0) {
    note(`  FAIL  ${page.title} (${palette}) rendered no widgets at all`);
    failures += 1;
  }
  const unique = [...new Set(noise)];
  if (unique.length) {
    note(`  FAIL  ${page.title} (${palette}) reported ${unique.length} error(s) in the browser`);
    for (const n of unique.slice(0, 6)) note(`          ${n}`);
    failures += 1;
  }
  for (const c of shape.clipped) {
    report(
      { rule: "clipped", page: page.name, palette, key: c.key },
      `${page.title} (${palette}) ${c.how}: ${c.content}px of content in ${c.visible}px (${c.hidden}%)`,
      `${c.key}  "${c.text}"`,
    );
  }
  for (const a of shape.spanning) {
    report(
      { rule: "spanning", page: page.name, palette, key: a.label },
      `${page.title} (${palette}) has an action spanning its surface: "${a.label}" ${a.width}px of ${a.of}px`,
    );
  }
  for (const u of shape.unreadable) {
    report(
      { rule: "unreadable", page: page.name, palette, key: u.key },
      `${page.title} (${palette}) draws control text at ${u.ratio}:1, which is below 4.5:1`,
      `${u.key}  "${u.text}"  ${u.color} at ${u.opacity} on ${u.on}`,
    );
  }
  if (shape.scrollWidth > shape.viewport.w + 1) {
    note(`  FAIL  ${page.title} (${palette}) scrolls sideways: ${shape.scrollWidth}px in ${shape.viewport.w}px`);
    failures += 1;
  }

  // ---- shape, which fails when it changed and nobody said so ----
  // Only the geometry: the rule findings above are the current state of the
  // page, not something to freeze, and a reference that carried them would
  // let a defect become the accepted answer.
  // Geometry is not portable. The same page wraps differently on macOS and on
  // a CI runner, because the system font stack resolves to different faces
  // with different metrics and a wrapped line is twenty pixels of widget
  // height. One shared reference would fail on the first run somewhere and
  // teach everyone to ignore the gate.
  //
  // So there is a reference per platform, below, and each machine enforces its
  // own. The *rules* above need none of this: clipped content, a spanning
  // action and a sideways scroll are relative comparisons within one
  // rendering, and they hold anywhere.
  // Geometry, plus the words of anything that said its words do not move.
  // `fixed` is omitted where a page has none, so a page that declares nothing
  // fixed has exactly the reference it always had.
  const recorded = {
    platform: process.platform,
    viewport: shape.viewport,
    widgets: shape.widgets,
    ...(shape.fixed.length ? { fixed: shape.fixed } : {}),
  };
  // One reference per platform, so every machine enforces rather than one
  // machine enforcing and the rest printing a note nobody reads. A platform
  // with no reference yet records one and says so.
  const refPath = join(refs, "shape", `${stem}.${process.platform}.json`);
  const next = JSON.stringify(recorded, null, 2) + "\n";

  if (accept || !existsSync(refPath)) {
    writeFileSync(refPath, next);
    note(`  new   ${page.title} (${palette}) shape recorded for ${process.platform}`);
  } else {
    const previous = readFileSync(refPath, "utf8");
    if (previous === next) {
      note(`  ok    ${page.title} (${palette}) unchanged, ${shape.widgets.length} widgets`);
    } else {
      const was = JSON.parse(previous);
      const moved = recorded.widgets.filter((w, i) => {
        const before = was.widgets[i];
        return !before || before.key !== w.key || JSON.stringify(before.box) !== JSON.stringify(w.box);
      });
      const reworded = (recorded.fixed ?? []).filter((f, i) => {
        const before = (was.fixed ?? [])[i];
        return !before || before.key !== f.key || before.text !== f.text;
      });
      note(`  FAIL  ${page.title} (${palette}) changed shape: ${was.widgets.length} widgets -> ${recorded.widgets.length}, ${moved.length} moved, ${reworded.length} reworded`);
      for (const w of moved.slice(0, 4)) note(`          ${w.key} now ${w.box.w}x${w.box.h} at ${w.box.x},${w.box.y}`);
      for (const f of reworded.slice(0, 4)) note(`          ${f.key} now says "${f.text.slice(0, 70)}"`);
      note(`          look at ${join(artifacts, stem + ".png")}, then re-run with ACCEPT_SHAPE=1`);
      changed += 1;
    }
  }

  await tab.close();
}

// ---- press a key, and let the caller check the device reacted -------------
if (press) {
  let pressed = false;
  for (const page of pages) {
    const tab = await context.newPage();
    await tab.goto(baseUrl + page.url, { waitUntil: "networkidle" });
    await tab.waitForTimeout(500);
    const key = tab.locator("button", { hasText: press }).first();
    if (await key.count()) {
      await key.click();
      note(`  ok    pressed "${press}" on ${page.title}`);
      pressed = true;
      await tab.waitForTimeout(600);
      await tab.close();
      break;
    }
    await tab.close();
  }
  if (!pressed) {
    note(`  FAIL  no control labelled "${press}" exists on any page to press`);
    failures += 1;
  }
}

await browser.close();

// An accepted violation that no longer happens is a line to delete. Left in,
// it would quietly re-accept the same defect if it ever came back.
// Only on a full pass. A run of one page has not been anywhere near the
// entries about the others, and reporting them as fixed would be a lie that
// deletes a real debt.
const stale = only !== undefined ? [] : debt.entries.filter(
  (e) => !seen.has(e) && (e.palette === "*" || e.palette === palette),
);
for (const e of stale) {
  note(`  FAIL  ${e.page} (${e.palette}) no longer has the accepted "${e.rule}" on "${e.key}"`);
  note(`          it is fixed — delete that entry from ${join(refs, "accepted-violations.json")}`);
  failures += 1;
}

note("");
note(`  captured ${pages.length} pages in the ${palette} palette`);
if (failures) note(`  ${failures} rule failure(s)`);
if (changed) note(`  ${changed} page(s) changed shape without being accepted`);
process.exit(failures + changed === 0 ? 0 : 1);
