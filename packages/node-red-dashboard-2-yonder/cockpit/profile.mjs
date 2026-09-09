// SPDX-License-Identifier: GPL-3.0-or-later
// Passive renderer measurement. All non-GET aircraft API requests are refused.
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
const url=process.env.COCKPIT_URL||'http://127.0.0.1:4198/?live=1';
const output=process.env.COCKPIT_PROFILE_OUTPUT||'.cockpit-artifacts/synthetic-profile.json';
const browser=await chromium.launch({args:process.platform==='darwin'?['--use-angle=metal']:[]});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
 const errors=[],writes=[],terrainFiles=new Set();
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/terrain/files/'))terrainFiles.add(r.url().split('/').at(-1))});
 await page.route('**/cockpit/api/**',route=>{
  if(route.request().method()==='GET')return route.continue();
  writes.push(route.request().url());return route.abort();
 });
 await page.addInitScript(()=>{
  const probe=window.renderProbe={frames:[],draws:[],uploads:[],long:[],flight:[],motion:[]};
  let transform=null;
  const tick=time=>{probe.frames.push(time);const next=document.querySelector('.pfd-horizon')?.getAttribute('transform');if(next&&next!==transform){probe.motion.push(time);transform=next}requestAnimationFrame(tick)};
  requestAnimationFrame(tick);
  new PerformanceObserver(list=>{for(const e of list.getEntries())probe.long.push({at:e.startTime,ms:e.duration})}).observe({type:'longtask',buffered:true});
  for(const name of ['clear','bufferData']){
   const original=WebGLRenderingContext.prototype[name];
   WebGLRenderingContext.prototype[name]=function(...args){probe[name==='clear'?'draws':'uploads'].push(performance.now());return original.apply(this,args)};
  }
  const fetchOriginal=window.fetch;
  window.fetch=async(...args)=>{const response=await fetchOriginal(...args);if(String(args[0]).endsWith('/api/flight'))probe.flight.push(performance.now());return response};
 });
 await page.goto(url);
 if(process.env.COCKPIT_TERRAIN_RELAY){
  await page.getByRole('button',{name:'Display & data',exact:true}).click();
  await page.getByRole('textbox',{name:'Ground relay origin',exact:true}).fill(process.env.COCKPIT_TERRAIN_RELAY);
  await page.getByRole('button',{name:'Apply ground relay',exact:true}).click();
  await page.getByRole('button',{name:'Close cockpit panel',exact:true}).click();
  await page.locator('.terrain-vision[data-terrain-status^="Cove terrain"]').waitFor({timeout:60000});
 }
 await page.locator('.terrain-vision[data-terrain-ready="true"]').waitFor({timeout:60000});
 await page.waitForTimeout(5000);
 const start=await page.evaluate(()=>performance.now());await page.waitForTimeout(15000);
 const result=await page.evaluate(start=>{
  const end=performance.now(),p=window.renderProbe;
  const summarize=values=>{const a=values.filter(t=>t>=start&&t<=end),gaps=a.slice(1).map((t,i)=>t-a[i]).sort((a,b)=>a-b);return {count:a.length,hz:+(a.length*1000/(end-start)).toFixed(1),medianMs:gaps[Math.floor(gaps.length*.5)]??null,p95Ms:gaps[Math.floor(gaps.length*.95)]??null,maxMs:gaps.at(-1)??null}};
  const canvas=document.querySelector('.terrain-canvas'),gl=canvas.getContext('webgl'),info=gl.getExtension('WEBGL_debug_renderer_info');
  return {durationMs:end-start,frames:summarize(p.frames),terrain:summarize(p.draws),attitudeMotion:summarize(p.motion),geometryUploads:summarize(p.uploads),flight:summarize(p.flight),longTasks:p.long.filter(e=>e.at>=start&&e.at<=end),renderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):'unavailable',terrainStatus:document.querySelector('.terrain-vision').dataset.terrainStatus,agl:document.querySelector('.pfd-agl-value').textContent};
 },start);
 Object.assign(result,{viewport:{width:1440,height:900},uniqueTerrainFiles:terrainFiles.size,errors,blockedWrites:writes.length});
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
 if(errors.length||writes.length)process.exitCode=1;
} finally { await browser.close(); }
