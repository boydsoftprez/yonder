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
//   3. **A picture.** Written on every run so somebody can look. Every reading
//      on it is its **widest honest specimen** (R-UI-23) rather than the value
//      that happened to be there, so the file is the same on two runs of the
//      same console *and* shows what the page does with the longest value the
//      field can actually carry. A reading with no specimen is masked and
//      named, because a load average changes between two runs and would make
//      the file dirty for ever. The unmasked copy goes to an artifact
//      directory for the full view.
//
//   4. **A camera.** R-UI-03 builds navigation from detected hardware, so with
//      none attached there is no camera page — and this gate then covers none
//      of the camera work and does not complain, because from its point of
//      view there is nothing there. `--synthetic-cameras` names the fixture the
//      harness seeded the daemon from, and this checks that those pages really
//      were photographed rather than quietly skipped.
//   5. **The viewport contract** (`--fold`, spec §5). A tall full-page PNG is
//      not evidence that anything fits above the fold, so `--fold` also
//      photographs the viewport alone, asserts the picture, the Aim panel and
//      the shutter key are inside it, asserts nothing inside a deck has a
//      scrollbar of its own, and asserts the rail is still in the viewport at
//      the bottom of the page.
//   6. **A credential check**, which is the one thing here that is not a mask.
//      The stream-address surface shows a *resolved* RTSP password (R-VID-15) and
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
//   node scripts/capture-pages.mjs ... --viewport 1440x900 --fold
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
// The rules that run inside the page. Their own module so they can be
// tested against a synthetic DOM without a console — see measure-page.mjs.
import { measure, railAtBottom } from "./measure-page.mjs";

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
 * What carries a reading.
 *
 * Each of these is photographed at the widest honest value its field can show
 * (R-UI-23) — see `scripts/fixtures/specimens.json`. A field with no specimen
 * there is masked instead, and named on every run, because its content changes
 * between two runs of the same console and neither the picture nor the shape
 * manifest is about its value.
 *
 * The two are the same list on purpose. A reading that is worth freezing is a
 * reading that is worth photographing, and a second list of "things that carry
 * a value" is a second list to forget to add to.
 */
const LIVE = [
  ".nrdb-ui-text-value",
  ".v-data-table td",
  ".y-gauge__value",
  ".y-bar__v",
  // The four instruments this list did not name, found by asking what is on a
  // page rather than what used to need painting over. `ui-yonder-facts` is
  // the one that matters: it draws a sentence per capability composed by the
  // probe, it is one of the two largest overflow findings in the run, and
  // until now its widest value was the only thing on the page nothing had
  // measured. This is `.tape__box` one level up — a reading the list does not
  // name is a reading nothing complains about.
  ".y-facts__state",
  ".y-facts__reason",
  ".y-budget__total",
  // The sparkline's scale is inside a `v-if="known"`, so on a harness with no
  // mesh traffic it is never drawn and has no specimen here — the first run
  // on a board that has some will say so, by name, which is the whole point
  // of naming it in this list before anything renders it.
  ".y-spark__ceiling",
  ".y-spark__span",
  // `.y-tape__box`, with the prefix every other class in this file has.
  // It was `.tape__box` here, which is a class no component in this
  // repository has ever had, so it matched nothing — and matched nothing
  // silently, because there is no tape on a page yet either. A selector that
  // is wrong and a selector that has nothing to find look identical until
  // the day they stop being the same thing.
  ".y-tape__box",
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
 * **`.y-id__v` is deliberately not on that list**, and this is where that is
 * written down rather than left as an omission.
 *
 * `YonderIdentity` draws the resolved RTSP stream address, and R-SEC-10's whole
 * evidence in this repository is that the committed `camera-setup` capture
 * shows the fixture's `FIXTURE-NOT-A-REAL-PASSWORD` and not a device's real
 * one. A specimen written over that field would erase the only picture that
 * proves the rule holds. It is exempt from the sideways rule for a separate
 * and unrelated reason — a value to copy rather than to read — and neither
 * exemption implies the other.
 */

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
 * The three things spec §5 says fit above the fold on a notebook, by the
 * class each component's own root carries rather than by the Node-RED node
 * that happens to hold it today.
 *
 * `ui-yonder-aim` is a node and the shutter key is a part inside the deck, so
 * a check written against node types would go blind the moment one of them
 * moved. A component's root class is the one thing that is true wherever it
 * is mounted.
 *
 * A part that is not on the page at all is a finding, not a pass. A check that
 * cannot tell "there was nothing to find" from "I did not look" is not a
 * check — and the camera pages do not carry the Aim panel or the shutter key
 * yet, so this reports them missing on every run until they arrive. It goes
 * through `report()` like every other rule, so the debt list *could* hold one
 * with a reason and a way out; nothing is on it, deliberately. These are the
 * pages being rebuilt, and a finding accepted the week before it is fixed is
 * a line somebody has to remember to delete.
 */
const ABOVE_THE_FOLD = [
  ["the picture", ".y-pic"],
  ["the Aim panel", ".y-aimpanel"],
  ["the shutter key", ".y-shutter"],
];

/** A deck, however it is drawn: groups wearing the class today, one node later. */
const DECK = '[class*="yonder-deck"], .nrdb-ui-yonder-deck';

/** The soft-key rail, which must be reachable at the bottom of the page. */
const RAIL = ".yonder-rail";

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

/**
 * The widest honest value every reading is photographed at (R-UI-23).
 *
 * **This is the difference between a picture of a layout and a picture of a
 * page.** The committed captures used to paint a grey box over every reading,
 * because a load average is different on two runs and would leave the file
 * permanently dirty. That kept the file clean and it hid the defect the
 * pictures existed to catch: a readout row is only ever as wrong as its
 * *longest* value, and the value that happened to be on the page during a
 * capture is never the longest one. `2000 kb/s` fits; `20000 kb/s`, which the
 * schema allows, is what an operator's page actually has to hold.
 *
 * So each field is given one value here — the widest the code that composes
 * it can produce — and the gate renders that instead. The picture is still
 * identical on two runs, which is what the masking was for, and it is now a
 * picture of the hardest case rather than of the easiest.
 *
 * A field with no entry is masked exactly as before and **named on every
 * run**, so the list of things still hidden is visible rather than implied,
 * and can only shrink. An entry that matches no field on any page fails, the
 * way a stale accepted violation does: a specimen for a reading that no longer
 * exists is a value nobody is checking.
 */
const specimensPath = under(arg("specimens"), "scripts/fixtures/specimens.json");
const specimens = (() => {
  const parsed = JSON.parse(readFileSync(specimensPath, "utf8"));
  const fields = {};
  for (const [key, entry] of Object.entries(parsed.fields ?? {})) fields[key] = entry.value;
  return { fields, masked: Object.keys(parsed.masked ?? {}) };
})();

/**
 * The viewport this run measures in.
 *
 * Fixed at 1280x900 for the shape references, which is what makes geometry
 * mean the same thing twice. `--viewport` is for the surfaces spec §5 names
 * separately — a notebook at 1440x900 and a landscape tablet below the 1100 px
 * breakpoint — and each of those records a shape reference of its own under
 * its own `--as` name, so a width is never compared against a different width.
 */
const viewport = (() => {
  const given = arg("viewport");
  if (given === undefined) return VIEWPORT;
  const parsed = /^(\d+)x(\d+)$/.exec(given);
  if (parsed === null) {
    process.stderr.write(`capture-pages: --viewport wants WIDTHxHEIGHT, not "${given}"\n`);
    process.exit(2);
  }
  return { width: Number(parsed[1]), height: Number(parsed[2]) };
})();

/**
 * Hold the page to the viewport contract in spec §5, and photograph the
 * viewport on its own.
 *
 * Separate from the full-page capture rather than replacing it, because the
 * two answer different questions and the spec asks both: the full page proves
 * every control is reachable, and only the viewport proves what an operator
 * sees before scrolling. A tall PNG is not evidence that anything fits above
 * the fold.
 */
const fold = has("fold");

if (!password) {
  process.stderr.write("capture-pages: --password is required\n");
  process.exit(2);
}

/**
 * The value that must never appear in a captured page.
 *
 * R-VID-15 puts a *resolved* RTSP URL on the stream-address surface, R-UI-12
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
  viewport,
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
/** Every field name a reading was found under, for the stale-specimen check. */
const fieldsSeen = new Set();
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

  // **Read before anything is rewritten.** The specimens below replace the
  // text of every reading on the page, and the R-SEC-10 check further down
  // asks whether the device's real RTSP password is in the page's HTML — so
  // taking the HTML after the substitution would ask that question of a page
  // the gate had already overwritten, and it would always answer no. The
  // guard would still be there, still green, and checking nothing.
  const html = await tab.content();

  // **From the top of the page, always.** Every box in the shape manifest is a
  // `getBoundingClientRect`, which is measured from the viewport and not from
  // the document — so a page that happens to be scrolled records a different
  // geometry for the same layout. Reaching a deck presses a soft key on the
  // rail, and the browser scrolls that key into view to click it: `Camera ·
  // Setup` was measured 327 px down its own page — every widget in both of
  // its references moved by exactly that — and the viewport contract
  // below duly reported the picture as outside the viewport when it was in it.
  await tab.evaluate(() => { window.scrollTo(0, 0); });
  await tab.waitForTimeout(150);

  const stem = `${page.name}.${palette}`;

  // **The page as it really was**, before a specimen is written into it and
  // before anything is masked. The committed copy below is the layout under
  // the hardest value each field can hold, which is a different and equally
  // honest picture — and it is not a portrait of one board in one state, so
  // this is the copy to look at when the question is what the device was
  // actually doing.
  await tab.screenshot({ path: join(artifacts, `${stem}.png`), fullPage: true });

  const shape = await tab.evaluate(measure, [LIVE, FIXED, specimens.fields, specimens.masked, ABOVE_THE_FOLD, DECK]);
  for (const reading of shape.readings) fieldsSeen.add(reading.key);

  // The committed picture: every reading at its widest honest specimen, and a
  // mask over the few that have none — a load average changes between two runs
  // and would leave the file permanently dirty.
  //
  // The elements were marked by `measure()` a moment ago rather than selected
  // again here, so there is one decision about what is hidden rather than the
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

  // ---- the viewport contract, spec §5 ----
  //
  // The viewport on its own, and then the page scrolled to the bottom. The
  // full-page picture above proves every control is *reachable*; neither of
  // these two is evidence for the other, and the requirement asks for both.
  let rail = null;
  if (fold) {
    await tab.screenshot({
      path: join(refs, "capture", `${stem}.fold.png`),
      fullPage: false,
      mask: masks,
      maskColor: "#8b8f94",
    });
    await tab.screenshot({ path: join(artifacts, `${stem}.fold.png`), fullPage: false });
    await tab.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
    // A sticky rail is placed by the browser after the scroll settles, so a
    // measurement taken in the same tick is of where it used to be.
    await tab.waitForTimeout(300);
    rail = await tab.evaluate(railAtBottom, [RAIL]);
    await tab.evaluate(() => { window.scrollTo(0, 0); });
  }

  // ---- R-SEC-10, and this one is a check rather than a mask ----
  //
  // The stream-address surface shows a resolved credential. R-UI-12 commits
  // these images, so a captured page carrying the real one would put a secret
  // in the repository for ever — and R-SEC-10 says never in a log, an error,
  // or a support bundle. The fixture carries a visibly fake value; this is
  // what proves the real one never got in.
  //
  // Same shape as K-32: a rule nobody notices is broken until it already is.
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
  for (const t of shape.truncated) {
    report(
      { rule: "truncated", page: page.name, palette, key: t.key },
      `${page.title} (${palette}) ${t.how}: ${t.content}px of text in ${t.visible}px (${t.hidden}%)`,
      `${t.key}  "${t.text}"`,
    );
  }
  // A reading nobody has chosen a widest value for. Not an error in the page —
  // an error in `scripts/fixtures/specimens.json`, which is why it names the
  // key to add rather than the widget to fix.
  for (const r of shape.readings.filter((x) => x.state === "unspecified")) {
    report(
      { rule: "unspecified", page: page.name, palette, key: r.key },
      `${page.title} (${palette}) photographs a masked reading with no specimen`,
      `add "${r.key}" to ${join("scripts/fixtures", "specimens.json")}, or list it under "masked" with a reason  (it reads "${r.was}")`,
    );
  }
  if (fold) {
    for (const part of shape.fold.parts) {
      if (!part.present) {
        report(
          { rule: "fold", page: page.name, palette, key: part.name },
          `${page.title} (${palette}) has no ${part.name} on it at ${shape.viewport.w}x${shape.viewport.h}`,
          `spec §5 puts it above the fold; nothing matched ${part.sel}`,
        );
        continue;
      }
      if (part.inside) continue;
      report(
        { rule: "fold", page: page.name, palette, key: part.name },
        `${page.title} (${palette}) draws ${part.name} outside the ${shape.viewport.w}x${shape.viewport.h} viewport`,
        `${part.box.w}x${part.box.h} at ${part.box.x},${part.box.y}`,
      );
    }
    // A deck that is not there is a check that did not run, and this file
    // already argues that for the parts above. `nested` was empty on every
    // run because `querySelectorAll` matched nothing, and an empty list reads
    // exactly like a page with no scroller in it.
    if (shape.fold.decks === 0) {
      report(
        { rule: "nested", page: page.name, palette, key: "the deck" },
        `${page.title} (${palette}) has no deck on it, so nothing was checked for a scroller of its own`,
        `spec §5 gives this page one; nothing matched ${DECK}`,
      );
    }
    for (const n of shape.fold.nested) {
      report(
        { rule: "nested", page: page.name, palette, key: n.key },
        `${page.title} (${palette}) scrolls ${n.across ? "sideways" : "inside"} the deck: ${n.key}`,
        "one vertical page scroll, and no scroller of its own inside it (spec §5)",
      );
    }
    if (rail === null || !rail.present) {
      note(`  FAIL  ${page.title} (${palette}) has no rail to keep reachable`);
      failures += 1;
    } else if (!rail.inside) {
      note(`  FAIL  ${page.title} (${palette}) puts the rail outside the viewport at the bottom of the page`);
      note(`          ${rail.box.w}x${rail.box.h} at ${rail.box.x},${rail.box.y} in ${rail.viewport.w}x${rail.viewport.h}`);
      failures += 1;
    } else {
      note(`  ok    ${page.title} (${palette}) keeps the rail in the viewport at the bottom of the page`);
    }
    const held = shape.fold.parts.filter((x) => x.present && x.inside);
    if (held.length === shape.fold.parts.length) {
      note(`  ok    ${page.title} (${palette}) fits ${held.map((x) => x.name).join(", ")} above the fold`);
    }
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

/**
 * R-SEC-10, asked of the specimen file itself.
 *
 * These values are written into pages that are screenshotted and committed, so
 * a specimen carrying a credential is the same leak the page check further up
 * exists to prevent, arriving by the one route that check cannot see: it reads
 * the page *before* the substitution, precisely so the substitution cannot
 * hide a real value, which means it is also reading it before a specimen could
 * introduce one.
 */
{
  const secret = deviceSecret("rtsp_password");
  const carrying = secret === null
    ? []
    : Object.entries(specimens.fields).filter(([, value]) => String(value).includes(secret));
  for (const [key] of carrying) {
    note(`  FAIL  the specimen for "${key}" carries this device's RTSP credential`);
    note(`          it would be rendered into a committed page image (R-SEC-10)`);
    failures += 1;
  }
}

/**
 * A specimen for a field that no page has.
 *
 * The same rule the accepted-violations list is held to, for the same reason:
 * a value nobody is checking looks exactly like a value that is being checked,
 * and the file stops being a description of the console. Only on a full pass —
 * a run of one page has not been near the other ten, and calling their
 * specimens dead would delete a real one.
 */
if (only === undefined) {
  const declared = [...Object.keys(specimens.fields), ...specimens.masked];
  for (const key of declared.filter((k) => !fieldsSeen.has(k))) {
    note(`  FAIL  no reading on any page is called "${key}"`);
    note(`          nothing is photographed by it — delete that entry from ${join("scripts/fixtures", "specimens.json")}`);
    failures += 1;
  }
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
    note("          the stream address resolves one, and these images are committed (R-SEC-10)");
    failures += 1;
  }
  // Only on a full pass, and for the reason the stale-debt check gives one
  // paragraph up: a run of one page has not been anywhere near the other ten,
  // and "no captured page names the fixture's camera" is a claim about the
  // set. The other two assertions above hold on every run, which is what
  // keeps `--secrets` from being optional on the single-page fold captures.
  if (only === undefined && !seenText.some((t) => t.includes(wanted))) {
    note(`  FAIL  no captured page names "${wanted}", so the fixture reached no page`);
    failures += 1;
  }
}

note("");
note(`  captured ${pages.length} pages in the ${palette} palette at ${viewport.width}x${viewport.height}`);
{
  const rendered = [...fieldsSeen].filter((k) => Object.prototype.hasOwnProperty.call(specimens.fields, k));
  note(`  ${rendered.length} of ${fieldsSeen.size} field(s) photographed at their widest honest value`);
}
if (failures) note(`  ${failures} rule failure(s)`);
if (changed) note(`  ${changed} page(s) changed shape without being accepted`);
process.exit(failures + changed === 0 ? 0 : 1);
