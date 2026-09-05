import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
// The sticky rail (gallery.css) is correct under real scrolling — verified
// at real scroll offsets, not just claimed — but Chromium's own screenshot
// path for an element taller than the viewport renders a `position:sticky`
// descendant frozen at whatever offset it held at capture time instead of
// its normal flow position, which reads as a broken layout in a full-shell
// PNG. Neutralised for this capture session only; the served app a person
// scrolls is unaffected.
await p.addStyleTag({ content: ".d-rail { position: static !important; }" });
await p.locator(".d-nav__i", { hasText: "Cam 2" }).click();
await p.waitForTimeout(400);
const shell = p.locator(".d-shell");
await shell.screenshot({ path: ".superpowers/gallery/live.pocket2.night.png" });
await p.getByRole("button", { name: /^day$/i }).click(); await p.waitForTimeout(600);
await shell.screenshot({ path: ".superpowers/gallery/live.pocket2.day.png" });
await p.getByRole("button", { name: /^night$/i }).click(); await p.waitForTimeout(600);
await p.locator(".d-nav__i", { hasText: "Cam 1" }).click(); await p.waitForTimeout(400);
await shell.screenshot({ path: ".superpowers/gallery/live.elp.night.png" });
await p.locator(".g-switch button", { hasText: /^setup$/i }).click(); await p.waitForTimeout(400);
await shell.screenshot({ path: ".superpowers/gallery/setup.elp.night.png" });
await p.locator(".d-nav__i", { hasText: "Cameras" }).click(); await p.waitForTimeout(400);
await shell.screenshot({ path: ".superpowers/gallery/cameras.night.png" });
await b.close(); console.log("done");
