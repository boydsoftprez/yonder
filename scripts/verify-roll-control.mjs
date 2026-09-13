// SPDX-License-Identifier: GPL-3.0-or-later
// Run against the local gallery's camera-workflow.html; it has no hardware connection.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { measure } from './measure-page.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:5179/camera-workflow.html';
const artifacts = new URL('../vendor/pocket-roll-browser/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage();
page.on('pageerror', error => errors.push(String(error)));
const evidence = [];
try {
  for (const width of [1440, 390]) for (const palette of ['day', 'night']) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByLabel('Theme', { exact: true }).selectOption(palette);
    await page.waitForFunction(p => document.querySelector('#theme').sheet?.cssRules.length > 0
      && document.querySelector('#theme').href.endsWith(`theme.${p}.css`), palette);
    const track = page.locator('.y-roll__track');
    await track.waitFor({ state: 'visible' });
    const rollSpeed = page.getByRole('slider', { name: 'Maximum roll speed', exact: true });
    const panSpeed = page.getByRole('slider', { name: 'Maximum gimbal speed', exact: true });
    assert.equal(await rollSpeed.inputValue(), '30');
    assert.equal(await panSpeed.inputValue(), '60');
    await track.scrollIntoViewIfNeeded();
    const box = await track.boundingBox();
    assert(box && box.width >= 100 && box.height >= 40, 'Roll touch target fits');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 78, y);
    await page.waitForFunction(() => window.__aimFixture.calls.filter(c => c.op === 'slew' && c.roll > 0).length >= 3);
    await page.mouse.up();
    await page.waitForFunction(() => window.__aimFixture.calls.at(-1)?.op === 'stop');
    const positive = await page.evaluate(() => window.__aimFixture.calls.filter(c => c.op === 'slew'));
    assert(positive.every(c => c.pan === 0 && c.tilt === 0 && c.roll === 30));
    assert.equal(await page.locator('.y-roll__puck').evaluate(el => el.style.left), '50%');
    const count = await page.evaluate(() => window.__aimFixture.calls.length);
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate(() => window.__aimFixture.calls.length), count, 'Release stops renewals');
    await rollSpeed.focus();
    await rollSpeed.press('Home');
    for (let step = 1; step < 12; step++) await rollSpeed.press('ArrowRight');
    assert.equal(await rollSpeed.inputValue(), '12');
    assert.equal(await panSpeed.inputValue(), '60', 'Roll preference leaves pan/tilt speed unchanged');
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 78, y);
    await page.waitForFunction(() => window.__aimFixture.calls.some(c => c.op === 'slew' && c.roll < 0));
    const negative = await page.evaluate(() => window.__aimFixture.calls.filter(c => c.op === 'slew' && c.roll < 0));
    assert(negative.every(c => c.roll === -12), 'Selected roll speed reaches the request');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.waitForFunction(() => window.__aimFixture.calls.at(-1)?.op === 'stop');
    await page.reload();
    await rollSpeed.waitFor({ state: 'visible' });
    assert.equal(await rollSpeed.inputValue(), '12', 'Roll preference survives reload');
    await rollSpeed.focus(); await rollSpeed.press('End');
    assert.equal(await rollSpeed.inputValue(), '30');
    await page.getByLabel('Theme', { exact: true }).selectOption(palette);
    await page.waitForFunction(p => document.querySelector('#theme').sheet?.cssRules.length > 0
      && document.querySelector('#theme').href.endsWith(`theme.${p}.css`), palette);
    const measured = await page.evaluate(measure, [[], '.fixture-fixed', {}, {}, [], '.y-deck']);
    assert.deepEqual(measured.unreadable.filter(c => c.key.startsWith('y-roll')), [], 'Roll text contrast >=4.5:1');
    assert(measured.scrollWidth <= width, 'Page has no horizontal overflow');
    await page.locator('.y-aimpanel').screenshot({ path: new URL(`roll-${width}-${palette}.png`, artifacts).pathname });
    await page.getByLabel('Scenario', { exact: true }).selectOption('Roll unavailable');
    assert.equal(await track.getAttribute('aria-disabled'), 'true');
    assert.equal(await rollSpeed.isDisabled(), true);
    const before = await page.evaluate(() => window.__aimFixture.calls.length);
    await track.click({ force: true });
    assert.equal(await page.evaluate(() => window.__aimFixture.calls.length), before);
    const disabled = await page.evaluate(measure, [[], '.fixture-fixed', {}, {}, [], '.y-deck']);
    assert.deepEqual(disabled.unreadable.filter(c => c.key.startsWith('y-roll')), [], 'Unavailable roll text contrast >=4.5:1');
    await page.locator('.y-roll').screenshot({ path: new URL(`roll-unavailable-${width}-${palette}.png`, artifacts).pathname });
    evidence.push({ width, palette, sustained: positive.length, defaultRate: 30, independentSpeed: true, persistence: true, release: true, blur: true, disabled: true, legible: true });
  }
  assert.deepEqual(errors, [], 'No browser errors');
  await writeFile(new URL('results.json', artifacts), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
