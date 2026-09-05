import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1512, height: 720 }, deviceScaleFactor: 2 });
await p.goto("http://127.0.0.1:18930/index.html", { waitUntil: "networkidle" });
await p.locator(".d-nav__i", { hasText: "Cam 2" }).click();
await p.getByRole("button", { name: /link poor/i }).click(); await p.waitForTimeout(300);
await p.locator(".d-stage").screenshot({ path: ".superpowers/gallery/stage.poor.1512.png" });
await b.close(); console.log("done");
