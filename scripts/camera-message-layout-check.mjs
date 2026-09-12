// SPDX-License-Identifier: GPL-3.0-or-later
// Production camera fixture: transient adaptive status must not move the picture.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = await createServer({ configFile: resolve('packages/node-red-dashboard-2-yonder/gallery/vite.config.mjs'), server: { port: 18937, strictPort: true } });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await mkdir('/tmp/yonder-camera-message-layout', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://localhost:18937/camera-workflow.html');
    await page.locator('.y-ov__step').waitFor();
    for (const palette of ['day', 'night']) {
      const css = await page.request.get(`http://localhost:18937/theme.${palette}.css`);
      assert.equal(css.status(), 200);
      await page.addStyleTag({ content: await css.text() });
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--yonder-theme').trim()), `"${palette}"`);
      const boxes = [];
      for (const step of ['', 'Bitrate increased: delivery is healthy.', 'Bitrate reduced because receiver delivery is below the configured target. '.repeat(8), '']) {
        boxes.push(await page.locator('.y-pic').evaluate(async (el, step) => {
          const vm = el.__vueParentComponent.proxy;
          vm.deliveryState = { ...vm.deliveryState, overlay: { head: 'adaptive', size: '1280×720', rate: '30 fps', bitrate: '1.19 Mb/s', step } };
          await vm.$nextTick();
          const r = el.querySelector('.y-pic__frame').getBoundingClientRect();
          const slot = el.querySelector('.y-ov__step');
          if (slot.textContent !== step) throw new Error('Fixture did not render the new status');
          return { y: r.y, height: r.height, slot: slot.clientHeight, scroll: slot.scrollHeight };
        }, step));
        if (step.length > 100) {
          await page.locator('.y-ov__step').focus();
          await page.keyboard.press('End');
          await page.waitForFunction(() => document.querySelector('.y-ov__step').scrollTop > 0);
          await page.screenshot({ path: `/tmp/yonder-camera-message-layout/${width}-${palette}-message.png` });
        }
      }
      for (const box of boxes) { assert.ok(Math.abs(box.y - boxes[0].y) < 0.5, JSON.stringify({ width, palette, boxes })); assert.ok(Math.abs(box.height - boxes[0].height) < 0.5); }
      assert.ok(boxes[2].scroll > boxes[2].slot, 'Long reason must remain scrollable');
      await page.screenshot({ path: `/tmp/yonder-camera-message-layout/${width}-${palette}.png` });
      console.log(`${width} ${palette}: stable frame`, boxes[0]);
    }
  }
} finally { await browser?.close(); await server.close(); }
