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
  await page.locator('.y-pic__state .y-ov__cap').filter({hasText: 'STILLS'}).waitFor();
  await page.locator('.y-pic__state .y-ov__bitrate').waitFor();
  assert.equal(await page.locator('.y-aimpanel').count(), 1, 'one independent Aim panel');
  assert.equal(await page.locator('.y-aim__dial').count(), 1, 'one aim dial, with none in the deck');
  assert.deepEqual((await page.locator('.y-pg__val').allTextContents()).map(s => s.trim()), ['—', '—'], 'unreported positions must not become zero');
  assert.equal(await page.locator('.y-aim__dial.is-inhibited').count(), 1, 'an advertised envelope alone must not authorize motion');
  assert.equal(await page.locator('.y-pg__ptr').count(), 0, 'no pointer for an unreported position');
  assert.equal(await page.locator('.y-strip__age').count(), 2, 'both actual frames have a reported age');

  if (await page.locator('.y-deck--workspace').count()) {
    const handle = page.locator('.y-aimpanel__handle');
    const picture = await page.locator('img.y-pic__video').elementHandle();
    const openWidth = (await page.locator('#nrdb-ui-group-group-cam-picture').boundingBox()).width;
    await handle.click();
    await page.locator('.y-aimpanel[data-aim-state="closed"]').waitFor({state: 'attached'});
    const card = await page.locator('#nrdb-ui-group-group-cam-aim > .v-card').evaluate(el => {
      const style = getComputedStyle(el);
      return {background: style.backgroundColor, border: style.borderTopWidth, padding: style.paddingTop, shadow: style.boxShadow};
    });
    assert.deepEqual(card, {background: 'rgba(0, 0, 0, 0)', border: '0px', padding: '0px', shadow: 'none'}, 'collapsed Aim has no empty dashboard frame');
    assert.equal(await page.locator('#nrdb-ui-group-group-cam-aim .v-card-text').evaluate(el => getComputedStyle(el).padding), '0px', 'collapsed Aim has no inner card padding');
    const handleBox = await handle.boundingBox();
    assert(handleBox.width >= 44 && handleBox.height === 44, 'collapsed Aim is a compact touch target');
    assert((await page.locator('.y-aimpanel').boundingBox()).height >= handleBox.height, 'collapsed Aim contains its touch target');
    const closedWidth = (await page.locator('#nrdb-ui-group-group-cam-picture').boundingBox()).width;
    assert(closedWidth >= openWidth, 'collapse preserves or expands preview width');
    assert(await picture.evaluate(el => el === document.querySelector('img.y-pic__video')), 'collapse preserves the preview element');
    await handle.click();
    await page.locator('.y-aimpanel[data-aim-state="open"]').waitFor({state: 'attached'});
    assert(await picture.evaluate(el => el === document.querySelector('img.y-pic__video')), 'reopen preserves the preview element');
    await picture.dispose();
  }

  if (selected === 'tail') {
    const previous = await page.locator('img.y-pic__video').getAttribute('src');
    await thumbs.filter({hasText: 'Tail camera'}).click();
    await page.locator('.y-pic__camera').filter({hasText: 'Tail camera'}).waitFor();
    await page.waitForFunction(old => {
      const img = document.querySelector('img.y-pic__video');
      return img?.complete && img.naturalWidth === 1280 && img.getAttribute('src') !== old;
    }, previous, {timeout: 45000});
    await page.locator('.y-pic__state .y-ov__cap').filter({hasText: 'STILLS'}).waitFor();
    await page.locator('.y-pic__state .y-ov__bitrate').waitFor();
    if (await page.locator('.y-deck--workspace').count()) {
      await page.locator('.y-aimpanel[data-aim-state="absent"]').waitFor({state: 'attached'});
      assert.equal(await page.locator('.y-aimpanel__handle').count(), 0, 'a camera without Aim has no drawer handle');
      assert.equal(await page.locator('#nrdb-ui-group-group-cam-aim').isVisible(), false, 'unsupported Aim consumes no workspace column');
    } else await page.locator('.y-aimpanel__fact').waitFor();
    assert.equal(await page.locator('.y-aim__dial').count(), 0, 'switching to a camera without aim retires the dial');
    assert.match(await page.locator('.y-strip__thumb.on').innerText(), /Tail camera/);
  }
}
