// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-10: explicit UI walkthrough against a separately launched disposable SITL.
// Refuses ordinary fixture/aircraft sources, existing missions and an armed start.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
assert(process.argv.includes('--allow-disposable-sitl-commands'),'Explicit disposable simulator command opt-in required');
const base=process.env.COCKPIT_GUIDE_SITL_URL;assert(base,'Set COCKPIT_GUIDE_SITL_URL to your new disposable preview');
const url=new URL(base);assert(['127.0.0.1','localhost'].includes(url.hostname));url.searchParams.set('live','1');
const state=async()=>{const r=await fetch(new URL('/cockpit/api/state',base));assert(r.ok);const s=await r.json();assert.equal(s.telemetry.source,'ArduPlane QuadPlane SITL');return s};
const initial=await state();assert.equal(initial.telemetry.armed,false);assert(initial.mission.items.every(item=>item.seq===0),'Use a fresh disposable simulator without an authored mission');
const identity=initial.identity.generation,dir=fileURLToPath(new URL('../.cockpit-artifacts/guide-sitl/',import.meta.url));await mkdir(dir,{recursive:true});
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(15000);
const records=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const b=(name,root=page)=>root.getByRole('button',{name,exact:true}),label=name=>page.getByLabel(name,{exact:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(name,test,ms=25000){const end=Date.now()+ms;while(Date.now()<end){const s=await state();assert.equal(s.identity.generation,identity);if(test(s)){records.push({name,mode:s.telemetry.mode,armed:s.telemetry.armed,currentSeq:s.mission.currentSeq,relativeAltitudeM:s.telemetry.relativeAltitudeM,airspeedKt:s.telemetry.airspeedKt,verticalSpeedFpm:s.telemetry.verticalSpeedFpm});console.log(name);return s}await pause(500)}throw Error('Timed out: '+name)}
async function operation(kind,click,confirm=true){const before=(await state()).operations.length;await click();if(confirm){await page.getByRole('dialog',{name:'Review aircraft command',exact:true}).waitFor();await b('Confirm & send').click()}const s=await until(kind+' completes',s=>s.operations.length>before&&s.operations.at(-1).action.kind===kind&&['accepted','observed','failed','rejected','unknown'].includes(s.operations.at(-1).state));const op=s.operations.at(-1);records.push({operation:kind,state:op.state,message:op.message,effect:op.effect});assert(['accepted','observed'].includes(op.state),JSON.stringify(op));return op}
async function status(){await b('Aircraft and command status').click()}
async function close(){await page.keyboard.press('Escape')}
try{
 await page.goto(url.href);await b('Aircraft and command status').waitFor();
 await status();await operation('stream-setup',()=>b('Request flight telemetry').click(),false);await operation('mission-download',()=>b('Read aircraft mission').click(),false);await page.getByRole('dialog').screenshot({path:dir+'telemetry-setup.png'});await close();
 await b('Display & data').click();await b('Load VTOL cove example as local draft').click();await close();
 await b('Mission controls').click();assert(await page.getByRole('button',{name:/^Start aircraft mission/}).isDisabled());
 await page.getByRole('dialog').screenshot({path:dir+'start-disabled-draft.png'});
 await operation('mission-upload',()=>page.getByRole('button',{name:/^Upload draft to aircraft/}).click());
 await until('15 wire items verified',s=>s.mission.synchronization==='verified'&&s.mission.items.length===15);
 await b('Mission controls').click();await page.getByRole('button',{name:/^Show aircraft mission/}).click();
 await b('Mission controls').click();await operation('mode',()=>b('QLOITER').click());await until('QLOITER observed',s=>s.telemetry.mode==='QLOITER');
 await b('Mission controls').click();await operation('arm',()=>b('Arm aircraft').click());await until('Armed observed',s=>s.telemetry.armed===true);
 await b('Mission controls').click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Start aircraft mission')&&!b.disabled));await page.getByRole('dialog').screenshot({path:dir+'start-aircraft-mission.png'});
 await operation('mission-start',()=>page.getByRole('button',{name:/^Start aircraft mission/}).click());
 await until('AUTO takeoff and measured positive VSI',s=>s.telemetry.mode==='AUTO'&&s.telemetry.relativeAltitudeM>10&&s.telemetry.verticalSpeedFpm>50,90000);
 await until('180 ft VTOL target advances to waypoint 02',s=>s.mission.currentSeq===2&&s.telemetry.relativeAltitudeM>50,120000);
 await page.screenshot({path:dir+'auto-mission.png'});
 if(await page.getByRole('main').getAttribute('data-layout')!=='mission')await b('Expand mission').click();await until('Mission advances beyond first geographic waypoint',s=>s.mission.currentSeq>=3,120000);await page.screenshot({path:dir+'waypoint-sequence.png'});await b('Return to full PFD').click();
 await b('Heading').click();await label('Requested true heading').fill('90');await operation('heading',()=>b('Review heading').click());await until('GUIDED observed after heading request',s=>s.telemetry.mode==='GUIDED');
 await b('Altitude / Speed').click();await label('Requested altitude FT').fill('450');await label('Requested vertical rate').fill('0');await operation('altitude',()=>b('Review altitude').click());
 await b('Altitude / Speed').click();await b('Airspeed').click();await label('Speed units').selectOption('mps');await label('Requested airspeed m/s').fill('25');await operation('speed',()=>b('Review speed').click());
 await until('450 ft target reached within 5 m using maximum rate',s=>Math.abs(s.telemetry.relativeAltitudeM-137.16)<5,90000);
 await b('Direct-To').click();await b('Choose target on map').click();await page.locator('.leaflet-container').click({position:{x:220,y:180}});await label('Requested altitude FT').fill('450');await operation('goto',()=>b('Review Direct-To').click());
 await b('Loiter').click();await label('Requested altitude FT').fill('450');await label('Requested loiter radius').fill('180');await label('Requested loiter direction').selectOption('ccw');await operation('loiter',()=>b('Review loiter').click());
 await b('Resume Mission').click();await operation('continue-auto',()=>b('Review Resume Mission').click());await until('AUTO resume observed',s=>s.telemetry.mode==='AUTO');
 await b('RTL').click();await operation('mode',()=>b('Review RTL').click());await until('RTL observed',s=>s.telemetry.mode==='RTL');
 await status();await page.getByRole('dialog').screenshot({path:dir+'operation-results.png'});
 assert.deepEqual(errors,[]);await writeFile(dir+'results.json',JSON.stringify({source:'Separate disposable ArduPlane 4.7.1 QuadPlane; all requests made through visible Vue controls',records,errors},null,2)+'\n');console.log('SITL user-guide walkthrough passed');
}catch(error){await page.screenshot({path:dir+'failure.png'});await writeFile(dir+'partial.json',JSON.stringify({records,errors,error:error.message,state:await state()},null,2));console.error(await page.locator('body').innerText());throw error}finally{await browser.close()}
