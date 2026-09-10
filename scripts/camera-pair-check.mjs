// SPDX-License-Identifier: GPL-3.0-or-later
// Real Dashboard widgets, subscriptions and JPEG decoding; no motion commands.
import assert from 'node:assert/strict';

export async function prepareCameraPair(page, selected) {
  assert(['front', 'tail'].includes(selected), 'camera-pair must be front or tail');
  const thumbs = page.locator('.y-strip__thumb');
  await page.waitForFunction(() => document.querySelectorAll('.y-strip__thumb').length === 2);
  await thumbs.filter({hasText: 'Front camera'}).click();
  await page.locator('.y-pic__camera').filter({hasText: 'Front camera'}).waitFor();
  await page.locator('.y-pic__view-modes').getByRole('button', {name: 'Stills', exact: true}).click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.y-strip__thumb img')];
    const picture = document.querySelector('img.y-pic__video');
    return images.length === 2 && [...images, picture].every(img => img?.complete && img.naturalWidth === 1280 && img.naturalHeight === 720);
  }, null, {timeout: 45000});
  await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('.y-strip__dl-v')?.textContent.trim() || ''), null, {timeout: 15000});
  await page.locator('.y-pic__state').waitFor();
  assert.equal(await page.locator('.y-aimpanel').count(), 1, 'one independent Aim panel');
  assert.equal(await page.locator('.y-aim__dial').count(), 1, 'one aim dial, with none in the deck');
  assert.deepEqual((await page.locator('.y-pg__val').allTextContents()).map(s => s.trim()), ['—', '—'], 'unreported positions must not become zero');
  assert.equal(await page.locator('.y-aim__dial.is-inhibited').count(), 1, 'an advertised envelope alone must not authorize motion');
  assert.equal(await page.locator('.y-pg__ptr').count(), 0, 'no pointer for an unreported position');
  assert.equal(await page.locator('.y-strip__age').count(), 2, 'both actual frames have a reported age');

  if (selected === 'tail') {
    const previous = await page.locator('img.y-pic__video').getAttribute('src');
    await thumbs.filter({hasText: 'Tail camera'}).click();
    await page.locator('.y-pic__camera').filter({hasText: 'Tail camera'}).waitFor();
    await page.waitForFunction(old => {
      const img = document.querySelector('img.y-pic__video');
      return img?.complete && img.naturalWidth === 1280 && img.getAttribute('src') !== old;
    }, previous, {timeout: 45000});
    await page.locator('.y-aimpanel__fact').waitFor();
    assert.equal(await page.locator('.y-aim__dial').count(), 0, 'switching to a camera without aim retires the dial');
    assert.match(await page.locator('.y-strip__thumb.on').innerText(), /Tail camera/);
  }
}
