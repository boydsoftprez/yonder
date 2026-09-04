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
//      no page rendering nothing at all. These fail the build on their own.
//   2. **Shape.** A manifest of every widget's geometry, committed and diffed.
//      Geometry rather than pixels, because "shape" is what the requirement
//      says and because a pixel diff across macOS and CI is a coin toss about
//      font rasterisation, not a check.
//   3. **A picture.** Written on every run so somebody can look. The committed
//      copy masks live readings — a load average changes between two runs and
//      would make the file dirty forever — so what it records is the layout.
//      The unmasked copy goes to an artifact directory for the full view.
//
//   4. **A camera.** R-UI-03 builds navigation from detected hardware, so with
//      none attached there is no camera page — and this gate then covers none
//      of the camera work and does not complain, because from its point of
//      view there is nothing there. `--synthetic-cameras` names the fixture the
//      harness seeded the daemon from, and this checks that those pages really
//      were photographed rather than quietly skipped.
//   5. **A credential check**, which is the one thing here that is not a mask.
//      The receive-line surface shows a *resolved* RTSP password (R-VID-15) and
//      these images are committed, so a capture taken against a real device
//      would put a real secret in the repository for ever. R-SEC-10 says never
//      in a log, an error, or a support bundle; a committed page is all three.
//      Same shape as K-32: a rule nobody notices is broken until it already is.
//
// Usage:
//   node scripts/capture-pages.mjs --base-url URL --password PW --palette day
//   node scripts/capture-pages.mjs ... --accept     # adopt the new shape
//   node scripts/capture-pages.mjs ... --synthetic-cameras scripts/fixtures/camera-globalshutter.json
//   node scripts/capture-pages.mjs ... --secrets /etc/yonder/secrets.yaml
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
      // A page whose deck is exchanged shows one deck at a time, so capturing
      // it once would quietly narrow "every page" to whichever deck the page
      // comes up on — the same hole a tabbed page has, reached a different
      // way. A deck is a `yonder-deck-<name>` in a group's className, and the
      // key that reveals it is the soft key whose action is that name.
      const decks = [];
      for (const g of flows.filter((n) => n.type === "ui-group" && n.page === p.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        const named = /yonder-deck-([a-z0-9-]+)/.exec(String(g.className ?? ""));
        if (named && !decks.includes(named[1])) decks.push(named[1]);
      }
      if (decks.length < 2) {
        out.push({ name: slug, title: p.name, url });
        continue;
      }
      const label = (action) => {
        for (const rail of flows.filter((n) => n.type === "ui-yonder-softkeys")) {
          for (const key of JSON.parse(String(rail.keys ?? "[]"))) {
            if (key.action === action) return key.label;
          }
        }
        return null;
      };
      for (const [i, deck] of decks.entries()) {
        out.push({
          name: `${slug}-${deck}`,
          title: `${p.name} · ${deck}`,
          url,
          // The first deck is the one the page comes up on, so it is captured
          // as found; every other one is reached by pressing its key.
          ...(i === 0 ? {} : { press: label(deck) }),
          // Group visibility lives in the daemon's state store, so it is
          // shared and it persists: a run that left the console on Setup would
          // photograph the next page's Live deck as Setup. The last deck puts
          // it back.
          ...(i === decks.length - 1 ? { restore: label(decks[0]) } : {}),
        });
      }
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
];

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
 * The fixture the harness seeded the daemon's camera layer from.
 *
 * Given here as well as to the daemon so that this can check the camera pages
 * were actually photographed. A page that renders nothing still produces a
 * picture, and "the camera pages are captured" is the whole claim this flag
 * exists to make true.
 */
const syntheticCameras = arg("synthetic-cameras");
/**
 * The device's own secret store, for the check below.
 *
 * Not a mask. A mask would paint over a leak and commit the picture anyway;
 * this fails the build.
 */
const secretsPath = arg("secrets");

if (!password) {
  process.stderr.write("capture-pages: --password is required\n");
  process.exit(2);
}

/**
 * The value that must never appear in a captured page.
 *
 * R-VID-15 puts a *resolved* RTSP URL on the receive-line surface, R-UI-12
 * commits these images, and R-SEC-10 says a credential belongs in none of a
 * log, an error or a support bundle — a committed page image is all three at
 * once. So the fixture the harness seeds carries a visibly fake password and
 * this reads the device's real one and asserts it is nowhere.
 *
 * Absent when no `--secrets` was given, and then the check says so rather than
 * passing silently: a guard that cannot tell "nothing to find" from "did not
 * look" is not a guard.
 */
function deviceSecret(name) {
  if (secretsPath === undefined) return null;
  try {
    const bag = parseYaml(readFileSync(secretsPath, "utf8")) ?? {};
    const value = bag[name];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

let parseYaml;
try {
  ({ parse: parseYaml } = await import("yaml"));
} catch {
  parseYaml = () => ({});
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
function measure(liveSelectors) {
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

  const live = new Set();
  for (const sel of liveSelectors) {
    for (const el of document.querySelectorAll(sel)) live.add(el);
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    widgets: widgets.map((el) => ({ key: keyOf(el), box: boxOf(el) })),
    liveBoxes: [...live].map(boxOf).filter((b) => b.w > 0 && b.h > 0),
    clipped,
    spanning,
  };
}

// ---------------------------------------------------------------------------

const pages = pagesFromFlows();
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
/** What every captured page rendered, for the whole-run checks at the end. */
const seenText = [];
const note = (s) => process.stdout.write(s + "\n");

for (const page of pages) {
  const tab = await context.newPage();

  // A page that throws, or whose widget bundle 404s, renders as an empty box
  // and says nothing. That is how the first build of the instrument widgets
  // looked: every node registered, every group resolved, and the page drew
  // blank. Console errors and failed requests are collected so the gate can
  // say what happened instead of leaving a picture of nothing.
  const noise = [];
  // A stream negotiation for a camera that is not running is not a page
  // defect — it is the case R-VID-14 exists for, and the component says so in
  // words on the frame. The browser logs it as a console error anyway, so the
  // filter is on the resource it names rather than on the words, which are the
  // browser's and not ours. A 404 on a widget bundle still fails, which is
  // what this check was written for.
  const aboutTheStream = (url) => /\/whep(\?|$)/.test(String(url ?? ""));
  tab.on("console", (m) => {
    if (m.type() !== "error") return;
    if (aboutTheStream(m.location()?.url)) return;
    noise.push(`console: ${m.text().slice(0, 200)}`);
  });
  tab.on("pageerror", (e) => noise.push(`uncaught: ${String(e.message).slice(0, 200)}`));
  tab.on("requestfailed", (r) => {
    if (aboutTheStream(r.url())) return;
    noise.push(`request failed: ${r.url().slice(-90)}`);
  });
  tab.on("response", (r) => {
    // The picture negotiating a stream for a camera that is not running is not
    // a page defect — it is the case R-VID-14 exists for, and the component
    // says so in words on the frame ("this camera is not streaming; start it
    // on the rail"). A 404 on a widget bundle still fails, which is what this
    // check was written for.
    if (aboutTheStream(r.url())) return;
    if (r.status() >= 400) noise.push(`HTTP ${r.status()}: ${r.url().slice(-90)}`);
  });

  // `load`, not `networkidle`. A page carrying a live picture never goes idle:
  // the WHEP session reconnects with backoff for as long as it is open, so
  // waiting for silence on a camera page is waiting for something that will
  // not happen. The widget wait below is what actually says the page is drawn.
  await tab.goto(baseUrl + page.url, { waitUntil: "load" });
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

  // The deck this entry is for, reached by pressing its key. Unlike a tab,
  // which the browser owns, a deck is exchanged by the *device*: the press
  // goes to Node-RED, the flow answers with a ui-control message, and the
  // groups appear. So this is also the only proof that path works at all.
  if (page.press) {
    const key = tab.locator("button", { hasText: page.press }).first();
    if (await key.count()) {
      await key.click();
      await tab.waitForTimeout(900);
    } else {
      note(`  FAIL  ${page.title} (${palette}) has no key labelled "${page.press}" to reach it`);
      failures += 1;
    }
  }

  const shape = await tab.evaluate(measure, LIVE);
  const stem = `${page.name}.${palette}`;

  // The picture. Masked for the committed copy — a load average changes
  // between two runs and would leave the file permanently dirty — and whole
  // for the artifact a person actually looks at.
  const masks = LIVE.map((s) => tab.locator(s));
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

  // ---- R-SEC-10, and this one is a check rather than a mask ----
  //
  // The receive-line surface shows a resolved credential. R-UI-12 commits
  // these images, so a captured page carrying the real one would put a secret
  // in the repository for ever — and R-SEC-10 says never in a log, an error,
  // or a support bundle. The fixture carries a visibly fake value; this is
  // what proves the real one never got in.
  //
  // Same shape as K-32: a rule nobody notices is broken until it already is.
  const html = await tab.content();
  seenText.push(html);
  const secret = deviceSecret("rtsp_password");
  if (secret !== null && html.includes(secret)) {
    note(`  FAIL  ${page.title} (${palette}) contains the resolved RTSP credential`);
    note("          capture with --synthetic-cameras so the pages render the fixture value");
    failures += 1;
  }

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
  const recorded = { platform: process.platform, viewport: shape.viewport, widgets: shape.widgets };
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
      note(`  FAIL  ${page.title} (${palette}) changed shape: ${was.widgets.length} widgets -> ${recorded.widgets.length}, ${moved.length} moved`);
      for (const w of moved.slice(0, 4)) note(`          ${w.key} now ${w.box.w}x${w.box.h} at ${w.box.x},${w.box.y}`);
      note(`          look at ${join("docs/console/capture", stem + ".png")}, then re-run with ACCEPT_SHAPE=1`);
      changed += 1;
    }
  }

  // Group visibility is the daemon's, so it is shared and it persists. A run
  // that walked off leaving the console on Setup would photograph the next
  // run's Live deck as Setup, and the shape reference would drift with it.
  if (page.restore) {
    const key = tab.locator("button", { hasText: page.restore }).first();
    if (await key.count()) {
      await key.click();
      await tab.waitForTimeout(700);
    } else {
      note(`  FAIL  ${page.title} (${palette}) has no "${page.restore}" key to put the deck back`);
      failures += 1;
    }
  }

  await tab.close();
}

// ---- press a key, and let the caller check the device reacted -------------
if (press) {
  let pressed = false;
  for (const page of pages) {
    const tab = await context.newPage();
    await tab.goto(baseUrl + page.url, { waitUntil: "load" });
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
const stale = debt.entries.filter(
  (e) => !seen.has(e) && (e.palette === "*" || e.palette === palette),
);
for (const e of stale) {
  note(`  FAIL  ${e.page} (${e.palette}) no longer has the accepted "${e.rule}" on "${e.key}"`);
  note(`          it is fixed — delete that entry from ${join(refs, "accepted-violations.json")}`);
  failures += 1;
}

/**
 * The claim `--synthetic-cameras` exists to make true.
 *
 * The fixture is only worth having if the camera pages were actually
 * photographed. Without this, a fixture that stopped being read — a renamed
 * key, a daemon started without it — would leave the camera pages rendering
 * nothing and every check above would still pass, because a page with no
 * camera on it is a page, and this gate would say so cheerfully.
 */
if (syntheticCameras !== undefined) {
  const fixture = JSON.parse(readFileSync(syntheticCameras, "utf8"));
  const wanted = String(fixture.camera?.name ?? "");
  const captured = pages.filter((p) => p.name.startsWith("camera"));
  if (captured.length === 0) {
    note("  FAIL  --synthetic-cameras was given and no camera page was captured");
    failures += 1;
  }
  if (secretsPath === undefined) {
    note("  FAIL  --synthetic-cameras without --secrets: nothing checked the real credential");
    note("          the receive line resolves one, and these images are committed (R-SEC-10)");
    failures += 1;
  }
  if (!seenText.some((t) => t.includes(wanted))) {
    note(`  FAIL  no captured page names "${wanted}", so the fixture reached no page`);
    failures += 1;
  }
}

note("");
note(`  captured ${pages.length} pages in the ${palette} palette`);
if (failures) note(`  ${failures} rule failure(s)`);
if (changed) note(`  ${changed} page(s) changed shape without being accepted`);
process.exit(failures + changed === 0 ? 0 : 1);
