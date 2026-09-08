// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-23/25: exercise the native configurable cockpit; fixture mode only.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const base=process.env.COCKPIT_URL||'http://127.0.0.1:4192';
const url=new URL(base);assert(['localhost','127.0.0.1'].includes(url.hostname));assert(!url.searchParams.has('live'));
const dir=fileURLToPath(new URL('../.cockpit-artifacts/layout-guide/',import.meta.url));await mkdir(dir,{recursive:true});
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));page.setDefaultTimeout(15000);
await page.route('**/cockpit/api/**',r=>r.abort());await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,r=>r.abort());
const b=(name,root=page)=>root.getByRole('button',{name,exact:true}),l=name=>page.getByLabel(name,{exact:true});
const mfd=()=>page.getByRole('navigation',{name:'Multifunction display pages',exact:true});
async function shot(name){await page.waitForTimeout(1600);await page.screenshot({path:dir+name+'.png'})}
async function layout(arrangement){await b('Display setup').click();await l('Display arrangement').selectOption(arrangement);await b('Close display setup').click();await page.waitForTimeout(500)}
try{
 await page.goto(url.href);await page.locator('.instrument-bank').waitFor();
 if(url.searchParams.has('ground'))await page.waitForFunction(()=>document.querySelector('.display-foot')?.textContent.includes('Cove terrain'),{},{timeout:60000});
 await page.evaluate(()=>{window.layoutPfd=document.querySelector('.pfd-svg');window.layoutMap=document.querySelector('.leaflet-container')});
 await b('Configure instruments').click();const editor=page.getByRole('dialog',{name:'Configure instruments',exact:true});
 await l('Band 1 maximum').fill('21');await l('Band 2 minimum').fill('21');
 await b('Apply instrument changes',editor).click();checks.push('Explicit local display bands applied');
 await shot('cockpit-main');
 await b('Display setup').click();await shot('cockpit-layout');await b('Close display setup').click();
 await b('Configure navigation fields').click();await page.getByRole('button',{name:/^Edit slot 2:/}).click();await l('Instrument source').selectOption('nav.homeDistance');await shot('cockpit-fields');await b('Cancel instrument changes',page.getByRole('dialog',{name:'Configure navigation fields',exact:true})).click();
 const saved=await page.evaluate(()=>localStorage.getItem('yonder-instrument-layout-v1'));
 await b('Configure instruments').click();await l('Presentation').selectOption('vertical');await shot('cockpit-instruments');await b('Cancel instrument changes',page.getByRole('dialog',{name:'Configure instruments',exact:true})).click();assert.equal(await page.evaluate(()=>localStorage.getItem('yonder-instrument-layout-v1')),saved);checks.push('Source/style preview cancels without saving');
 await layout('stacked');await shot('cockpit-stacked');await layout('split');await shot('cockpit-split');
 assert(await page.evaluate(()=>window.layoutPfd===document.querySelector('.pfd-svg')&&window.layoutMap===document.querySelector('.leaflet-container')));checks.push('Same PFD and map retained across MFD layouts');
 await b('Systems',mfd()).click();await b('Pinned instruments').waitFor();await shot('cockpit-systems');
 await b('Telemetry',mfd()).click();await l('Search telemetry sources').fill('nav.homeDistance');await l('Telemetry source').selectOption('nav.homeDistance');await page.getByRole('region',{name:'Selected reading inspector',exact:true}).waitFor();await shot('cockpit-telemetry');
 await b('Pin to navigation fields').click();assert.equal(await page.locator('.flight-data-field[data-id="nav.homeDistance"]').count(),1);checks.push('Direct inspector search, source selection and pin');
 await page.reload();await page.locator('.flight-data-field[data-id="nav.homeDistance"]').waitFor();assert.equal(await page.getByRole('main').getAttribute('data-arrangement'),'split');checks.push('Saved fields and layout restore on reload');
 await b('Display setup').click();await l('Instrument placement').selectOption('hidden');await b('Close display setup').click();assert.equal(await page.locator('.cockpit-navigation-data .instrument-bank').count(),0);assert(await page.getByRole('group',{name:'Touch flight instruments'}).isVisible());
 await b('Display setup').click();await l('Instrument placement').selectOption('side');await l('Display arrangement').selectOption('single');await b('Close display setup').click();checks.push('Instrument visibility remains independent of PFD');
 const s=await page.evaluate(()=>window.cockpitFixture.snapshot());await page.evaluate(s=>window.cockpitFixture.set({...s,statustext:[{at:s.at,severity:3,text:'Fixture warning for notice walkthrough'}]}),s);await page.locator('.cockpit-alert-summary').click();await page.getByRole('dialog',{name:'Aircraft notices'}).getByText('Fixture warning for notice walkthrough',{exact:true}).waitFor();await b('Close cockpit panel').click();checks.push('Notice opens received message');
 for(const [width,height] of [[1024,768],[768,1024]]){await page.setViewportSize({width,height});await layout('stacked');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:dir+`stacked-${width}.png`});await layout('single');}
 checks.push('Landscape and portrait tablet layouts');assert.equal(await page.evaluate(()=>window.cockpitFixture.calls.length),0);assert.equal(requests.filter(u=>u.includes('/cockpit/api/')).length,0);assert.deepEqual(errors,[]);
 await writeFile(dir+'results.json',JSON.stringify({source:'Native cockpit with explicitly synthetic telemetry; local display bands configured through UI',checks,errors},null,2)+'\n');console.log('Layout guide passed: '+checks.length+' groups');
}catch(e){await page.screenshot({path:dir+'failure.png'});console.error((await page.locator('body').innerText()).slice(-10000));throw e}finally{await browser.close()}
