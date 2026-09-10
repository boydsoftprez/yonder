// SPDX-License-Identifier: GPL-3.0-or-later
//
// The gate's own rules, against a page built to have the defect (R-UI-23).
//
// `verify-pages.sh` proves these rules on the real console, which is the
// claim that matters — but it can only prove the cases the console happens to
// have. A rule that has never been shown to *fire* on the case it was written
// for is a rule nobody has checked, and the sideways rule shipped with a false
// negative that no page on this console reaches: a box whose own text was cut
// off reported nothing at all as soon as anything absolutely positioned sat
// over its edge. The overlay exemption asked "is every spilling child placed"
// over element children, and an element's own text is not an element child.
//
// So each case below is a page of about six lines with one defect in it, and
// each is written as a mutation: the same box **without** the thing under test
// must report, so a case that passes because the rule never fires cannot pass
// quietly.
//
//     node scripts/measure-page.test.mjs
import { measure } from "./measure-page.mjs";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  process.stderr.write("measure-page.test: playwright is not installed\n");
  process.exit(2);
}

let failures = 0;
const ok = (what) => process.stdout.write(`  ok    ${what}\n`);
const bad = (what, detail) => {
  process.stdout.write(`  FAIL  ${what}\n`);
  if (detail !== undefined) process.stdout.write(`          ${detail}\n`);
  failures += 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const tab = await context.newPage();

/** Everything `measure()` needs that is not the page: no specimens, no parts. */
const ARGS = [[".reading"], ".yonder-fixed", {}, [".reading"], [], ".no-deck"];

/**
 * One page, measured. Wrapped in a widget so `keyOf` has something to name and
 * so the vertical rule's widget branch behaves as it does on a real page.
 */
async function sideways(body) {
  await tab.setContent(`<!doctype html><meta charset="utf-8">
    <style>
      body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
      .box { width: 100px; white-space: nowrap; }
      .hid { overflow-x: hidden; }
      .vis { overflow-x: visible; }
      .badge { position: absolute; left: 90px; width: 60px; height: 8px; background: #ccc; }
      .ghost { position: relative; }
      .ghost::after { content: ""; position: absolute; left: 90px; width: 60px; height: 8px; background: #ccc; }
      .host { position: relative; }
    </style>
    <div class="nrdb-ui-widget">${body}</div>`);
  const shape = await tab.evaluate(measure, ARGS);
  return shape.truncated;
}

const LONG = "a value far too long for one hundred pixels of box to hold";

// ---- the rule fires at all -------------------------------------------------
{
  const found = await sideways(`<div class="box hid">${LONG}</div>`);
  if (found.length === 1 && found[0].how === "cuts off" && found[0].visible === 100) {
    ok(`text cut off by overflow:hidden is reported (${found[0].content}px in 100px)`);
  } else {
    bad("text cut off by overflow:hidden is reported", JSON.stringify(found));
  }
}
{
  const found = await sideways(`<div class="box vis">${LONG}</div>`);
  if (found.length === 1 && found[0].how === "spills past") {
    ok("text escaping a box that does not clip is reported");
  } else {
    bad("text escaping a box that does not clip is reported", JSON.stringify(found));
  }
}

// ---- the overlay exemption, both directions --------------------------------
//
// This is the pair. An overlay over a box that fits must be exempt; the same
// overlay over a box whose own text is cut off must change nothing. The second
// half is the mutation the shipped rule failed.
{
  const found = await sideways(
    `<div class="box hid host">fits<i class="badge"></i></div>`,
  );
  if (found.length === 0) {
    ok("a placed overlay over a box that fits is not a finding");
  } else {
    bad("a placed overlay over a box that fits is not a finding", JSON.stringify(found));
  }
}
{
  const found = await sideways(
    `<div class="box hid host">${LONG}<i class="badge"></i></div>`,
  );
  if (found.length === 1 && found[0].how === "cuts off") {
    ok(`text cut off is still reported with a placed overlay on it (${found[0].content}px in 100px)`);
  } else {
    bad(
      "text cut off is still reported with a placed overlay on it",
      `this is the shipped false negative — got ${JSON.stringify(found)}`,
    );
  }
}

// **A pseudo-element overlay, which is the case that rules out the other fix.**
// The rejected approach measured the counterfactual — hide everything placed,
// re-read `scrollWidth` — and a `::after` is not a child that can be hidden, so
// a box that fits reported as cut off. Every other overlay case here uses a
// real `<i>`, which that approach handles correctly, so without this pair the
// suite passes under both implementations and pins neither.
{
  const fits = await sideways(`<div class="box hid ghost">fits</div>`);
  const cut = await sideways(`<div class="box hid ghost">${LONG}</div>`);
  if (fits.length === 0 && cut.length === 1 && cut[0].how === "cuts off") {
    ok(`a pseudo-element overlay is exempt over a box that fits, and silent over one that is cut (${cut[0].content}px in 100px)`);
  } else {
    bad(
      "a pseudo-element overlay is exempt over a box that fits",
      `fits -> ${JSON.stringify(fits)}; cut -> ${JSON.stringify(cut)}`,
    );
  }
}

// ---- the named exemptions, each with its mutation --------------------------
{
  const without = await sideways(`<div class="box hid"><span>${LONG}</span></div>`);
  const with_ = await sideways(`<div class="box hid y-id__v">${LONG}</div>`);
  if (with_.length === 0 && without.length === 1) {
    ok("an identity's value is exempt, and the same box without the class is not");
  } else {
    bad("an identity's value is exempt", `${JSON.stringify(with_)} / ${JSON.stringify(without)}`);
  }
}
{
  const found = await sideways(
    `<div class="box hid host"><i class="badge"></i></div>`,
  );
  if (found.length === 0) {
    ok("a box with no text of its own is not a finding");
  } else {
    bad("a box with no text of its own is not a finding", JSON.stringify(found));
  }
}

// ---- innermost only --------------------------------------------------------
{
  const found = await sideways(
    `<div class="box hid"><div class="box hid">${LONG}</div></div>`,
  );
  if (found.length === 1) {
    ok("one overflow is reported once, at the innermost box");
  } else {
    bad("one overflow is reported once, at the innermost box", JSON.stringify(found));
  }
}

// ---- specimens, and the three-way decision ---------------------------------
{
  const scaled = await sideways('<svg width="100" height="100" viewBox="0 0 400 400"><g transform="rotate(30 200 200)"><text x="100" y="200" font-size="40">NORTH</text></g></svg>');
  const clipped = await sideways('<svg width="100" height="100" style="overflow:hidden"><text x="85" y="50" font-size="30">NORTH</text></svg>');
  if (scaled.length === 0 && clipped.length === 1 && clipped[0].how === "cuts off") {
    ok("scaled SVG labels fit their viewport; genuinely clipped SVG text is reported");
  } else {
    bad("SVG text is measured in rendered coordinates", `${JSON.stringify(scaled)} / ${JSON.stringify(clipped)}`);
  }
}
{
  const map = await sideways(`<div class="leaflet-container box hid host"><div style="position:absolute;left:400px;top:400px">geographic target</div><button class="box hid">${LONG}</button></div>`);
  if (map.length === 1 && map[0].text === LONG.slice(0, 80)) ok("a geographic viewport clips placed targets, while overflowing control text is reported");
  else bad("map viewport retains control-text checks", JSON.stringify(map));
}
{
  await tab.setContent(`<!doctype html><meta charset="utf-8">
    <div class="nrdb-ui-widget nrdb-ui-text">
      <span class="nrdb-ui-text-label">UPLINK</span><span class="reading">4.55 Mb/s</span>
    </div>`);
  const shape = await tab.evaluate(measure, [
    [".reading"], ".yonder-fixed", { "nrdb-ui-text · UPLINK": "169.49 Mb/s at IP" }, [], [], ".no-deck",
  ]);
  const drawn = await tab.evaluate(() => document.querySelector(".reading").textContent);
  const state = shape.readings[0];
  if (drawn === "169.49 Mb/s at IP" && state.state === "rendered" && state.key === "nrdb-ui-text · UPLINK") {
    ok("a field with a specimen is rendered at it, under the key a person can check");
  } else {
    bad("a field with a specimen is rendered at it", `${drawn} / ${JSON.stringify(state)}`);
  }

  const none = await tab.evaluate(measure, [[".reading"], ".yonder-fixed", {}, [], [], ".no-deck"]);
  if (none.readings[0].state === "unspecified") {
    ok("a field with neither a specimen nor a reason is unspecified");
  } else {
    bad("a field with neither a specimen nor a reason is unspecified", JSON.stringify(none.readings));
  }
}

// A noninteractive mode fact still has to be readable beside its controls.
for (const [ink, expected] of [['#000', 1], ['#fff', 0]]) {
  await tab.setContent(`<body style="background:#000"><div class="nrdb-ui-widget"><div class="y-aimpanel__mode" style="color:${ink}">Gimbal mode: follow.</div></div></body>`);
  const result = await tab.evaluate(measure, ARGS);
  if (result.unreadable.length === expected) ok(`gimbal mode contrast detects ${ink} on black correctly`);
  else bad('gimbal mode contrast', JSON.stringify(result.unreadable));
}

await browser.close();
process.stdout.write("\n");
process.stdout.write(failures === 0 ? "  the page rules hold\n" : `  ${failures} rule(s) do not hold\n`);
process.exit(failures === 0 ? 0 : 1);
