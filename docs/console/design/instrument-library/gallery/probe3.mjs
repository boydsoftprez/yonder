import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
// See shot2.mjs: neutralises a Chromium screenshot-only artifact with the
// sticky rail on a tall `.d-shell` capture, verified correct under real
// scrolling separately. Capture-session only.
await p.addStyleTag({ content: ".d-rail { position: static !important; }" });
await p.locator(".d-nav__i", { hasText: "Cam 2" }).click(); await p.waitForTimeout(300);
const state = async () => (await p.locator(".d-state").innerText()).replace(/\n/g, " / ");
const step = async () => (await p.locator(".d-step").count()) ? await p.locator(".d-step").innerText() : "(none)";
console.log("good :", await state(), "|", await step());
await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/live.pocket2.night.png" });
await p.getByRole("button", { name: /link poor/i }).click(); await p.waitForTimeout(300);
console.log("poor :", await state(), "|", await step());
console.log("uplink:", (await p.locator(".d-strip").innerText()).replace(/\n/g, " "));
await p.locator(".d-shell").screenshot({ path: ".superpowers/gallery/live.pocket2.poor.png" });
await p.getByRole("button", { name: /link lost/i }).click(); await p.waitForTimeout(300);
console.log("lost :", await state(), "|", await step());
await p.getByRole("button", { name: /link good/i }).click(); await p.waitForTimeout(200);
await p.locator("select[aria-label=Size]").selectOption("640x360"); await p.waitForTimeout(200);
console.log("held :", await state());
await p.locator(".d-hold").dispatchEvent("pointerdown"); await p.waitForTimeout(150);
console.log("full :", await state());
await p.locator(".d-hold").dispatchEvent("pointerup");
console.log("preview column:", (await p.locator(".d-col", { hasText: "PREVIEW" }).innerText()).replace(/\n/g, " / ").slice(0, 220));
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no errors");
await b.close();
