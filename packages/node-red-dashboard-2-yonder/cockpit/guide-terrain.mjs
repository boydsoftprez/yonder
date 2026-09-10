// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-10/22: real prepared terrain, synthetic flight; no aircraft connection.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createGroundServer} from '../../../scripts/cockpit/ground-data-server.mjs';
const base=process.env.COCKPIT_URL||'http://127.0.0.1:4192';assert(['localhost','127.0.0.1'].includes(new URL(base).hostname));assert(!new URL(base).searchParams.has('live'));
const app=await createGroundServer({allowOrigin:new URL(base).origin,terrainDirectory:fileURLToPath(new URL('../../yonder-core/src/terrain/assets/cove/',import.meta.url)),fetchImpl:async()=>new Response('Public providers disabled for this terrain walkthrough',{status:503})});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const relay='http://127.0.0.1:'+app.server.address().port;
const dir=fileURLToPath(new URL('../.cockpit-artifacts/guide/',import.meta.url));await mkdir(dir,{recursive:true});
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(30000);
let progress;const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));await page.route('**/cockpit/api/**',r=>r.abort());await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
const b=name=>page.getByRole('button',{name,exact:true}),l=name=>page.getByLabel(name,{exact:true});
try{
 await page.goto(base);await b('Display & data').click();await l('Ground relay origin').fill(relay);await b('Apply ground relay').click();await page.getByRole('combobox',{name:/^Verified aircraft height datum/}).selectOption('EGM96');await page.getByLabel('Enable terrain data',{exact:true}).check();await b('Close cockpit panel').click();
 await page.waitForFunction(()=>document.querySelector('.display-foot')?.textContent.includes('Cove terrain'),{},{timeout:60000});await b('Open flight planning profile').click();await page.waitForFunction(()=>{const s=document.querySelector('.profile-status');return s&&/ground 100%/.test(s.textContent)&&!s.textContent.includes('Loading')});
 await l('Inspect distance along route').fill('700');await page.screenshot({path:dir+'terrain-profile.png'});
 const profile=await page.locator('.profile-status').innerText(),probe=await page.locator('.profile-probe').innerText();assert.match(probe,/\d+ FT AGL/);
 await l('Profile waypoint').selectOption('9');await b('Edit waypoint altitude').click();assert.equal(await l('Alt parameter 7').inputValue(),'300');await b('Close mission controls').click();
 await l('Plan MSL datum').selectOption('Unknown');await page.waitForFunction(()=>document.querySelector('.profile-probe')?.textContent.includes('— FT AGL'));await l('Plan MSL datum').selectOption('EGM96');
 await b('Waypoints').click();await b('Return to full PFD').click();await page.waitForTimeout(2500);await page.screenshot({path:dir+'terrain-overview.png'});
 console.log('Streaming terrain and profile passed');await b('Display & data').click();await page.getByLabel('Enable terrain data',{exact:true}).uncheck();await page.waitForTimeout(500);const preloadStart=Date.now();await b('Preload terrain from ground relay').click();progress=setInterval(()=>console.log('Preload requests',requests.filter(u=>u.startsWith(relay)).length),15000);await page.getByText(/saved in this browser/).waitFor({timeout:120000});
 clearInterval(progress);console.log('Preload saved',Date.now()-preloadStart);await l('Public data connection').selectOption('offline');await b('Close cockpit panel').click();const before=requests.length;await page.reload();await b('Display & data').click();await l('Public data connection').selectOption('offline');await page.getByLabel('Enable terrain data',{exact:true}).check();await b('Close cockpit panel').click();await b('Open flight planning profile').click();await page.waitForFunction(()=>/ground 100%/.test(document.querySelector('.profile-status')?.textContent||''));
 assert.equal(requests.slice(before).filter(u=>u.startsWith(relay)).length,0,'Offline reload must use browser pack only');
 assert.equal(await page.evaluate(()=>window.cockpitFixture.calls.length),0);assert.deepEqual(errors,[]);
 await writeFile(dir+'terrain-results.json',JSON.stringify({source:'USGS 2016 Cove terrain pack through ground-only local relay; synthetic fixture flight',profile,probe,checks:['native ground and surface profile','slider clearance','profile altitude edit','unknown datum suppresses AGL','complete pack preload','offline reselection after reload with zero relay requests','zero aircraft requests'],errors},null,2)+'\n');console.log('Terrain guide checks passed');
}catch(e){await page.screenshot({path:dir+'terrain-failure.png'});console.error(await page.locator('body').innerText());throw e}finally{clearInterval(progress);await browser.close();await app.close()}
