// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-10 / R-UI-12: user-guide walkthrough of the production Vue surfaces.
// Fixture mode only: aircraft HTTP is blocked, sends are collected in memory.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MISSION_COMMANDS} from '../src/ui/cockpit/mission-commands.mjs';
import {fixtureCamera} from './fixture.mjs';
const base=process.env.COCKPIT_URL||'http://127.0.0.1:4192';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
assert(!new URL(base).searchParams.has('live'),'Guide fixture must not use a vehicle');
const dir=fileURLToPath(new URL('../.cockpit-artifacts/guide/',import.meta.url));await mkdir(dir,{recursive:true});
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1});
page.setDefaultTimeout(10000);
const failures=[],checks=[],images=[];page.on('pageerror',e=>failures.push(e.message));
await page.route('**/cockpit/api/**',r=>r.abort());
await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
const button=(name,root=page)=>root.getByRole('button',{name,exact:true});
const label=name=>page.getByLabel(name,{exact:true});
const dialog=()=>page.getByRole('dialog').last();
async function check(name,run){console.log(name);await run();checks.push(name)}
async function shot(name,element=page){await element.screenshot({path:dir+name+'.png',animations:'disabled'});images.push(name)}
async function missionControls(){const regular=button('Mission controls');await (await regular.isVisible()?regular:button('Mission actions')).click()}
async function close(){await page.keyboard.press('Escape');}
async function calls(){return page.evaluate(()=>window.cockpitFixture.calls)}
async function reviewCancel(){await page.getByRole('dialog',{name:'Review aircraft command',exact:true}).waitFor();await button('Cancel command review').click()}
try{
 await page.goto(base);await page.getByRole('main').waitFor();
 await shot('overview');
 await check('PFD references: apply, persistence, clear; no aircraft request',async()=>{
  for(const [hotspot,title,value] of [['Airspeed controls','Airspeed reference','60'],['Set altitude reference','Altitude reference','1500'],['Set heading reference','Heading reference','270'],['Vertical speed scale reference','Vertical speed reference','500']]){
   await button(hotspot).first().click();await label(title+' value').fill(value);if(hotspot==='Airspeed controls')await shot('local-reference',dialog());await button('Apply',dialog()).click();
   await button(hotspot).first().click();assert.equal(await label(title+' value').inputValue(),value);await button('Clear',dialog()).click();
  }
  assert.equal((await calls()).length,0);
 });
 await check('Display units, transparency, strip and director controls',async()=>{
  await button('PFD Menu').click();await shot('pfd-menu',dialog());
  await page.getByRole('button',{name:/^Attitude & display/}).click();
  await label('Speed units').selectOption('mph');await label('Altitude units').selectOption('m');await label('Vertical speed units').selectOption('mps');
  await shot('display-units',dialog());await close();
  assert.match(await page.locator('.pfd-svg').textContent(),/MPH/);
  await button('Attitude and display settings').click();await label('Speed units').selectOption('kt');await label('Altitude units').selectOption('ft');await label('Vertical speed units').selectOption('fpm');await close();
  await button('FD').click();await label('Flight director style').selectOption('crossbar');await shot('flight-director',dialog());await label('Flight director style').selectOption('vbar');await close();
  for(const [hotspot,name] of [['Wind display settings','wind'],['Slip and skid indicator settings','slip-turn']]){await button(hotspot).click();await shot(name,dialog());await close()}
 });
 await check('All persistent flight controls reach review; cancelling never sends',async()=>{
  await button('Heading').click();await label('Requested true heading').fill('90');await button('Review heading').click();await shot('command-review',dialog());await reviewCancel();
  await button('Altitude / Speed').click();await label('Requested altitude FT').fill('500');await label('Requested vertical rate').fill('300');await shot('altitude-speed',dialog());await button('Review altitude').click();await reviewCancel();
  await button('Altitude / Speed').click();await button('Airspeed',dialog()).click();await label('Speed units').selectOption('mph');await label('Requested airspeed MPH').fill('60');await button('Review speed').click();await reviewCancel();
  await button('Loiter').click();await label('Requested altitude FT').fill('500');await label('Requested loiter radius').fill('180');await label('Requested loiter direction').selectOption('ccw');await shot('loiter-now',dialog());await button('Review loiter').click();await reviewCancel();
  await button('Resume Mission').click();await button('Review Resume Mission').click();await reviewCancel();
  await button('RTL').click();await button('Review RTL').click();await reviewCancel();
  await button('Modes').click();await dialog().getByRole('button',{name:/^LOITER/}).click();await reviewCancel();
  await button('Arm / Disarm').click();await button('Review disarm aircraft').click();await reviewCancel();
  assert.equal((await calls()).length,0);
 });
 await check('Direct-To map picker and one explicitly confirmed request',async()=>{
  await button('Direct-To').click();await button('Choose target on map').click();
  const map=page.locator('.leaflet-container');await map.click({position:{x:200,y:180}});
  await label('Requested altitude FT').fill('500');await shot('direct-to',dialog());await button('Review Direct-To').click();await button('Confirm & send').click();
  assert.equal((await calls()).length,1);assert.equal((await calls())[0].action.kind,'goto');
  await page.reload();await page.getByRole('main').waitFor();
 });
 await check('Mission bracket, altitude edit, loiter conversion and undo',async()=>{
  await button('Expand mission').click();await page.evaluate(()=>window.cockpitFixture.leg(9));await page.locator('[data-mission-seq="9"][aria-current="step"]').waitFor();
  assert.equal(await page.locator('.mission-leg-connector').getAttribute('data-from'),'8');await shot('mission-list');
  await button('Edit altitude at waypoint 9').click();await label('Alt parameter 7').fill('600');await shot('waypoint-altitude',dialog());await button('Save draft item').click();
  assert.match(await page.locator('.cockpit-mission-summary').innerText(),/LOCAL DRAFT/);assert.equal(await page.locator('.mission-leg-connector').count(),0);
  await page.locator('[data-mission-seq="9"]').locator('button').first().click();await button('Change mission action').click();await label('Search mission commands').fill('Loiter Unlim');await button('Change to Loiter Unlim').click();
  await label('Loiter radius metres').fill('180');await label('Loiter direction').selectOption('ccw');await shot('mission-loiter',dialog());await button('Save draft item').scrollIntoViewIfNeeded();await shot('mission-loiter-save',dialog());await button('Save draft item').click();
  await missionControls();await button('Undo edit').click();await shot('mission-controls',dialog());await close();
  await missionControls();await page.getByRole('button',{name:/Show aircraft mission Return/}).click();
  assert.equal((await calls()).length,0);
 });
 await check('Mission file export/import and arbitrary touch waypoint',async()=>{
  await missionControls();const download=page.waitForEvent('download');await button('Export .waypoints').click();const file=await download;const text=await readFile(await file.path(),'utf8');assert.match(text,/QGC WPL 110/);await close();
  await button('Display & data').click();const chooser=page.waitForEvent('filechooser');await button('Import WPL / QGC plan').click();await(await chooser).setFiles({name:'guide-export.waypoints',mimeType:'text/plain',buffer:Buffer.from(text)});await close();
  await missionControls();await page.getByRole('button',{name:/Add waypoint on map/}).click();await page.locator('.leaflet-container').click({position:{x:220,y:160}});await label('Alt parameter 7').fill('300');await button('Add to draft').click();
  await missionControls();await button('Undo edit').click();await close();
  assert.equal((await calls()).length,0);
 });
 await check('Mission catalog: navigation, condition and action forms',async()=>{
  await missionControls();await page.getByRole('button',{name:/^Add mission item/}).click();await label('Search mission commands').fill('Loiter');await shot('mission-catalog',dialog());
  for(const command of MISSION_COMMANDS){
   await label('Search mission commands').fill(String(command.id));await button('Add '+command.label).click();
   assert.match(await page.locator('.mission-command-heading').innerText(),new RegExp('MAV_CMD '+command.id+'\\b'));
   await button('Back to mission actions').click();await page.getByRole('button',{name:/^Add mission item/}).click();
  }
  assert.equal(MISSION_COMMANDS.length,55);await close();
 });
 await check('Map controls, traffic range and own-aircraft breadcrumbs',async()=>{
  if(await page.getByRole('main').getAttribute('data-layout')!=='map')await button('Expand map').click();await button('Fit traffic range').click();await button('Zoom map out').click();
  await button('Aircraft breadcrumb settings').click();await label('Aircraft trail window').selectOption('distance');await label('Aircraft trail distance units').selectOption('mi');await label('Aircraft trail distance').fill('2');await label('Aircraft trail distance').dispatchEvent('change');await shot('breadcrumbs',dialog());await close();
  await page.locator('.cockpit-map-pane footer button').nth(1).click();await shot('traffic',dialog());await close();
 });
 await check('Data setup, camera-unavailable fallback and offline states',async()=>{
  await button('Display & data').click();await page.getByRole('group',{name:'Connection & offline data',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await shot('data-connection',dialog());
  await page.getByRole('combobox',{name:/^Background/}).selectOption('camera');await close();await button('Use synthetic terrain').click();
  await button('Display & data').click();await label('Public data connection').selectOption('offline');await close();
  await button('Return to full PFD').click();await button('Open flight planning profile').click();await shot('profile-unavailable');
  await button('Waypoints').click();await button('Return to full PFD').click();
  await button('Aircraft and command status').click();await shot('aircraft-status',dialog());await close();
 });
 await check('The camera fills the flight display, and the Camera control opens/closes its window (R-FLT-29, K-68)',async()=>{
  await page.evaluate(camera=>window.cockpitFixture.set(camera),fixtureCamera());
  await button('Display menu').click();await page.getByRole('button',{name:/^Map, terrain & data/}).click();
  await page.getByRole('combobox',{name:/^Background/}).selectOption('camera');await close();
  await shot('camera-full');
  // The Camera control's own height against a genuinely comparable
  // neighbour: both are two-line utility-extra buttons, unlike the
  // single-glyph full-screen control beside them.
  const heights=await page.evaluate(()=>[document.querySelector('.cockpit-camera-toggle')?.getBoundingClientRect().height,document.querySelector('[aria-label="Aircraft and command status"]')?.getBoundingClientRect().height]);
  assert.ok(heights[0]>0);assert.equal(heights[0],heights[1]);
  await button('Display menu').click();await label('Cockpit palette').selectOption('day');await close();
  await shot('camera-full-day');
  await button('Display menu').click();await label('Cockpit palette').selectOption('night');await close();
  await button('Camera view').click();await shot('camera-window');
  await page.setViewportSize({width:768,height:1024});await shot('camera-window-tablet');
  await page.setViewportSize({width:1280,height:900});
  await button('Camera view').click();
  await button('Display menu').click();await page.getByRole('button',{name:/^Map, terrain & data/}).click();
  await page.getByRole('combobox',{name:/^Background/}).selectOption('terrain');await close();
  assert.equal((await calls()).length,0);
 });
 await check('Disconnected aircraft blocks review and sends nothing',async()=>{
  await page.evaluate(()=>{const s=window.cockpitFixture.snapshot();window.cockpitFixture.set({...s,connected:false,ready:false,telemetry:{...s.telemetry,ready:false,ageMs:20000}})});
  await button('Heading').click();assert.equal(await button('Review heading').isDisabled(),true);await shot('unavailable-command',dialog());await close();
  assert.equal((await calls()).length,0);
 });
 assert.deepEqual(failures,[]);
 await writeFile(dir+'results.json',JSON.stringify({source:'production Vue widget with synthetic fixture; vehicle HTTP blocked',checks,images,errors:failures},null,2)+'\n');
 console.log(`Guide passed: ${checks.length} workflow groups, ${images.length} captures`);
}catch(error){await page.screenshot({path:dir+'failure.png'});console.error(await page.locator('body').innerText());throw error}finally{await browser.close()}
