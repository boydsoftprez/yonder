// SPDX-License-Identifier: GPL-3.0-or-later
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const base=process.env.COCKPIT_URL||'http://127.0.0.1:4192';
const artifacts=fileURLToPath(new URL('../.cockpit-artifacts/',import.meta.url));await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.route('**/cockpit/api/**',route=>route.abort('blockedbyclient'));
for(const [name,width,height] of [['laptop',1440,900],['tablet',1024,768],['portrait',768,1024],['phone',390,844]]){
 await page.setViewportSize({width,height});await page.goto(base);await page.getByRole('main').waitFor();
 assert.equal(await page.getByRole('main').getAttribute('data-layout'),'full');
 const pfd=page.locator('[aria-label="Primary flight display"]');assert.equal(await pfd.count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`${artifacts}/${name}-full.png`});
 if(width>=768){await page.getByRole('button',{name:'Expand mission',exact:true}).click();assert.equal(await page.getByRole('main').getAttribute('data-layout'),'mission');await page.screenshot({path:`${artifacts}/${name}-mission.png`});await page.getByRole('button',{name:'Return to full PFD',exact:true}).click();}
 await page.getByRole('button',{name:'Airspeed controls',exact:true}).click();await page.getByRole('dialog',{name:'Airspeed reference',exact:true}).waitFor();await page.screenshot({path:`${artifacts}/${name}-airspeed.png`});await page.getByRole('button',{name:'Close PFD controls'}).click();
 assert.equal(await page.evaluate(()=>window.cockpitFixture.calls.length),0);
}
await page.setViewportSize({width:1440,height:900});await page.goto(base);
await page.getByRole('button',{name:'Mission controls',exact:true}).click();await page.getByRole('button',{name:'Add mission item',exact:false}).click();assert.match(await page.locator('.mission-touch').innerText(),/55/);await page.getByRole('searchbox',{name:'Search mission commands'}).fill('Loiter');await page.screenshot({path:`${artifacts}/catalog.png`});await page.getByRole('button',{name:'Close mission controls'}).click();
await page.getByRole('button',{name:'Display & data',exact:true}).click();await page.getByLabel('Palette',{exact:true}).selectOption('day');await page.screenshot({path:`${artifacts}/day-settings.png`});await page.getByRole('button',{name:'Close cockpit panel'}).click();await page.screenshot({path:`${artifacts}/day-full.png`});
assert.equal(await page.locator('.pfd-hotspot').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).backgroundColor==='rgba(0, 0, 0, 0)')),true,'day palette must preserve transparent instrument hit regions');
await page.waitForTimeout(1000);const markerCount=await page.locator('.leaflet-tooltip').count();await page.waitForTimeout(1200);assert.equal(await page.locator('.leaflet-tooltip').count(),markerCount);assert.equal(markerCount,13);
await page.getByRole('button',{name:'Expand map',exact:true}).click();
const ownTrail=page.locator('path.cockpit-own-trail');await ownTrail.waitFor({state:'attached'});
assert.match(await ownTrail.getAttribute('d'),/L/,'ownship breadcrumb geometry must render');
await page.getByRole('button',{name:'Aircraft breadcrumb settings',exact:true}).click();
await page.getByLabel('Aircraft trail window',{exact:true}).selectOption('distance');
await page.getByLabel('Aircraft trail distance units',{exact:true}).selectOption('mi');
await page.getByLabel('Aircraft trail distance',{exact:true}).fill('2');
await page.getByLabel('Aircraft trail distance',{exact:true}).dispatchEvent('change');
await page.getByLabel('Aircraft trail window',{exact:true}).selectOption('power');
await page.screenshot({path:`${artifacts}/own-trail-settings.png`});
await page.getByRole('button',{name:'Clear displayed trail',exact:true}).click();
await page.getByRole('button',{name:'Close cockpit panel'}).click();
assert.doesNotMatch(await ownTrail.getAttribute('d'),/L/,'clear affects the actual map path');
await page.getByRole('button',{name:'Aircraft breadcrumb settings',exact:true}).click();
await page.getByRole('button',{name:'Restore recorded trail',exact:true}).click();
await page.getByRole('button',{name:'Close cockpit panel'}).click();
assert.match(await ownTrail.getAttribute('d'),/L/);
await page.screenshot({path:`${artifacts}/own-trail-map.png`});
await page.setViewportSize({width:1024,height:768});await page.screenshot({path:`${artifacts}/own-trail-tablet.png`});
assert.equal(await page.evaluate(()=>window.cockpitFixture.calls.length),0);
assert.deepEqual(errors,[]);await browser.close();console.log('Cockpit fixture browser checks passed; no vehicle requests. Artifacts: '+artifacts);
