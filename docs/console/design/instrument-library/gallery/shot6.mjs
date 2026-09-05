import { chromium } from "playwright";
const b = await chromium.launch();

/* ---- Setup/Pocket 2: the shared draft's pending list ------------------- */
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
  await p.addStyleTag({ content: ".d-rail { position: static !important; }" }); // see shot2.mjs
  await p.locator(".d-nav__i", { hasText: "Cam 2" }).click(); await p.waitForTimeout(200);
  // Two Live edits to Stream/Preview fields — staged, not applied — so
  // Setup's pending list has real rows to show, one with a stated
  // interruption and one without. Effective (draft-aware) visibility means
  // switching Stream to Adaptive reveals Floor/Ceiling immediately, before
  // Apply — the operator can stage the whole change as one unit.
  await p.locator(".d-col", { hasText: "Stream" }).locator(".d-seg__b", { hasText: "Adaptive" }).click();
  await p.waitForTimeout(100);
  await p.locator("select[aria-label=Size]").selectOption("1280x720"); await p.waitForTimeout(150);
  await p.locator(".g-switch button", { hasText: /^setup$/i }).click(); await p.waitForTimeout(300);
  console.log("pending block present:", await p.locator(".d-pending").count());
  console.log("pending rows:", (await p.locator(".d-pending__row").allInnerTexts()).join(" || "));
  console.log("no Aim group on Setup (round 2, correction 4):", await p.locator(".d-col", { hasText: "Aim" }).count());
  await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/setup.pocket2.night.png" });
  await p.close();
}

/* ---- ELP Photo mode: the flash, and the new still at the top of Captures ---- */
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
  await p.addStyleTag({ content: ".d-rail { position: static !important; }" }); // see shot2.mjs
  await p.locator(".d-caps-toggle").click(); await p.waitForTimeout(150);
  await p.getByRole("button", { name: "Photo", exact: true }).click(); await p.waitForTimeout(80);
  await p.locator(".d-shutter__b.photo").click();
  await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/photo-and-captures.elp.png" });
  console.log("captures after photo:", await p.locator(".d-caps-toggle").innerText());
  await p.close();
}

/* ---- Stable columns (round 2, correction 3): two renders, Fixed and
   Adaptive, same camera and scroll position, so every group heading's x
   position can be compared directly rather than taken on trust. --------- */
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
  await p.addStyleTag({ content: ".d-rail { position: static !important; }" }); // see shot2.mjs

  const headingsX = async () => {
    const heads = await p.locator(".d-cols .d-h span:first-child").all();
    const out = {};
    for (const h of heads) { const box = await h.boundingBox(); out[(await h.innerText()).trim()] = Math.round(box.x); }
    return out;
  };

  await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/columns.fixed.png" });
  const fixedX = await headingsX();

  await p.locator(".d-col", { hasText: "Stream" }).locator(".d-seg__b", { hasText: "Adaptive" }).click();
  await p.waitForTimeout(200);
  await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/columns.adaptive.png" });
  const adaptiveX = await headingsX();

  let stable = true;
  for (const k of Object.keys(fixedX)) {
    if (adaptiveX[k] !== undefined && adaptiveX[k] !== fixedX[k]) {
      stable = false;
      console.log(`COLUMN MOVED: "${k}" was x=${fixedX[k]}, now x=${adaptiveX[k]}`);
    }
  }
  console.log("fixed:", JSON.stringify(fixedX));
  console.log("adaptive:", JSON.stringify(adaptiveX));
  console.log(stable ? "COLUMNS STABLE: every heading at the same x in both renders" : "COLUMNS UNSTABLE — see above");
  await p.close();
}

/* ---- The viewport contract (§5): 1440×900, above the fold; full page,
   one scroll, no horizontal overflow, no nested scroller. A measurement,
   not a claim — every number below is printed, not assumed. ------------- */
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
  await p.waitForTimeout(300);
  // The fold: exactly what the viewport shows, unscrolled. Not a full-page
  // capture cropped after the fact — a real viewport screenshot.
  await p.screenshot({ path: ".superpowers/gallery/fold.1440.png", fullPage: false });

  const fold = await p.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const pic = r(".d-vid"), aim = r(".d-aimpanel"), cap = [...document.querySelectorAll(".d-col")]
      .find((el) => el.innerText.trim().toUpperCase().startsWith("CAPTURE"));
    const capBox = cap ? cap.getBoundingClientRect() : null;
    return { viewport: { w: window.innerWidth, h: window.innerHeight }, picture: pic, aim: aim, capture: capBox };
  });
  console.log("FOLD MEASUREMENT:", JSON.stringify(fold));

  const overflow = await p.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  console.log("PAGE SIZE:", JSON.stringify(overflow));

  // Nested scroller check: any element (besides the root) whose own
  // content actually overflows its own box under a non-visible overflow.
  const nested = await p.evaluate(() => {
    const offenders = [];
    document.querySelectorAll("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      const scrollsY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const scrollsX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (scrollsY || scrollsX) offenders.push({ tag: el.tagName, cls: el.className, scrollsY, scrollsX });
    });
    return offenders;
  });
  console.log("NESTED SCROLLERS:", JSON.stringify(nested));

  // Full page: proves the one-scroll, no-overflow claim visually too. Same
  // sticky-screenshot artifact as shot2.mjs's full-shell captures — real
  // behavior is the scroll-position measurement above, not this image;
  // neutralised here only so the picture matches what it measures.
  await p.addStyleTag({ content: ".d-rail { position: static !important; }" });
  await p.screenshot({ path: ".superpowers/gallery/fullpage.1440.png", fullPage: true });
  await p.close();
}

await b.close(); console.log("done");
