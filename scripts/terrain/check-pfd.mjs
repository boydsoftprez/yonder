// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28 and R-UI-12: authenticated PFD terrain-panel browser scenarios.
//
// These are explicitly API-fixture scenarios. They exercise the production
// cockpit and its real controls in Chromium, but replace only the authenticated
// terrain-service API with deterministic replies. The daemon integration suite
// is the separate evidence for the actual terrain backend.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const TERRAIN_API=/\/cockpit\/api\/terrain-service(?:\/[^?#]*)?(?:\?[^#]*)?$/;
const FLIGHT_COMMAND_API=/\/cockpit\/api\/command(?:\?|$)/;
const UUIDS={job:'20000000-0000-4000-8000-000000000001',area:'30000000-0000-4000-8000-000000000001'};

function statusFixture(overrides={}) {
  const base={
    schemaVersion:1,at:Date.now(),policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:512},
    loading:false,failure:null,preparationAllowed:true,
    limits:{maxTiles:32,maxAreas:32,bufferMinM:50,bufferMaxM:10000},
    source:{provider:'ardupilot-srtm1',dataset:'Official ArduPilot ALOS-derived SRTM1',spacingM:30,datum:'MSL',ownership:'Operator-managed single responder; exclusivity is not enforced'},
    storage:{usedBytes:90_000_000,quotaBytes:512*1024*1024,objects:1,areas:[],storage:{freeBytes:2*1024*1024*1024,persistent:true}},
    coverage:{areas:[],job:null},
    service:{enabled:true,compatible:true,compatibility:null,sent:12,missing:0,controller:{fresh:true,report:{pending:2,loaded:6,spacing:30}},providerOwnership:{policy:'operator-managed',exclusivityEnforced:false,directRouteVisibility:'unverified',competition:[]}},
    controllerRefresh:{state:'idle',reason:null,generation:'browser-fixture-generation',rally:null},
  };
  return {...base,...overrides};
}

function previewFixture(sequence) {
  return {id:`10000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,createdAt:Date.now(),expiresAt:Date.now()+600_000,
    coverage:{kind:'manual',name:'Browser fixture area',bufferM:1000,bounds:{south:35,north:35.1,west:-84.1,east:-84},tiles:['N35W085'],estimatedBytes:90_000_000,complete:true,reasons:[],revision:`fixture-source-${sequence}`,geometry:{rectangles:[{south:35,north:36,west:-85,east:-84}],polylines:[]}},
    sourceSelection:{N35W085:null},refreshSource:false,contextKey:'browser-fixture-context',policyKey:'browser-fixture-policy'};
}

function areaFixture() {
  return {id:UUIDS.area,name:'Browser fixture area',pinned:false,revision:'fixture-source-complete',createdAt:new Date().toISOString(),kind:'manual',objects:[{tile:'N35W085',sha256:'a'.repeat(64)}],coverage:{bufferM:1000,bounds:{south:35,north:35.1,west:-84.1,east:-84},geometry:{rectangles:[{south:35,north:36,west:-85,east:-84}],polylines:[]}},contextKey:null,complete:true,reasons:[],stale:false};
}

function fixtureController() {
  let status=statusFixture();
  let policy={policy:{...status.policy},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null};
  let previewSequence=0;
  const calls=[];
  const behavior={preview:'success',prepare:'complete',stalePolicy:false,statusFailureOnce:false};
  const reply=(route,statusCode,body)=>route.fulfill({status:statusCode,contentType:'application/json',body:JSON.stringify(body)});
  return {
    calls,behavior,
    resetStatus(next=statusFixture()){status=next;policy={...policy,policy:{...status.policy},pendingId:null,apply:{state:'idle'}};},
    rebootStatus(){status=statusFixture({service:{...status.service,controller:{fresh:false,report:null}},controllerRefresh:{state:'failed',reason:'controller reboot invalidated the previous report',generation:null,rally:null}});},
    async route(route) {
      const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/cockpit/api/terrain-service','')||'/',method=request.method();
      let body=null;if(method==='POST'){try{body=request.postDataJSON()}catch{}}
      calls.push({method,path,body,cockpitHeader:request.headers()['x-yonder-cockpit']||null});
      if(path==='/'&&method==='GET'){
        if(behavior.statusFailureOnce){behavior.statusFailureOnce=false;return reply(route,503,{error:'fixture terrain status unavailable after controller reboot'});}
        return reply(route,200,{...status,at:Date.now()});
      }
      if(path==='/policy'&&method==='GET')return reply(route,200,policy);
      if(path==='/policy/apply'&&method==='POST'){
        if(behavior.stalePolicy){behavior.stalePolicy=false;policy={policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:2048},revision:'b'.repeat(64),apply:{state:'idle'},pendingId:null};status={...status,policy:{...policy.policy}};return reply(route,409,{error:'terrain policy changed; review the current revision'});}
        return reply(route,200,{id:'fixture-policy-apply',expiresAt:Date.now()+90_000});
      }
      if(path==='/policy/confirm'&&method==='POST')return reply(route,200,{state:'confirmed'});
      if(path==='/policy/revert'&&method==='POST')return reply(route,200,{state:'confirmed'});
      if(path==='/preview'&&method==='POST'){
        if(behavior.preview==='quota')return reply(route,409,{error:'quota capacity is insufficient for this terrain area'});
        return reply(route,200,previewFixture(++previewSequence));
      }
      if(path==='/prepare'&&method==='POST'){
        if(behavior.prepare==='stale')return reply(route,409,{error:'Context changed; preview the area again'});
        const job={id:UUIDS.job,previewId:body?.previewId,name:'Browser fixture area',state:behavior.prepare==='active'?'preparing':'complete',total:1,completed:behavior.prepare==='active'?0:1,reason:null,areaId:behavior.prepare==='active'?null:UUIDS.area,updatedAt:Date.now()};
        status={...status,coverage:{areas:behavior.prepare==='active'?[]:[areaFixture()],job},storage:{...status.storage,areas:behavior.prepare==='active'?[]:[areaFixture()]}};
        return reply(route,200,job);
      }
      if(path==='/cancel'&&method==='POST'){
        status={...status,coverage:{...status.coverage,job:{...status.coverage.job,state:'cancelled',reason:'Cancelled by authenticated browser fixture',updatedAt:Date.now()}}};
        return reply(route,200,{ok:true});
      }
      if(path==='/refresh-controller'&&method==='POST')return reply(route,200,{ok:true});
      if(path==='/samples'&&method==='POST')return reply(route,200,{samples:(body?.points||[]).map(()=>({available:false,reason:'API fixture has no official sample'}))});
      return reply(route,404,{error:`Unhandled browser fixture route ${method} ${path}`});
    },
  };
}

function occurrence(calls,path,before=0){return calls.slice(before).filter(call=>call.path===path)}

/** R-UI-16: measure declared control text after real CSS cascade and alpha composition. */
function measureTerrainControlContrast(root) {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const transparent={r:0,g:0,b:0,a:0},white={r:255,g:255,b:255,a:1};
  const color=value=>{
    if(!context||!value||value==='currentcolor'||!CSS.supports('color',value))return null;
    context.clearRect(0,0,1,1);context.fillStyle='#010203';context.fillStyle=value;context.fillRect(0,0,1,1);
    const [r,g,b,a]=context.getImageData(0,0,1,1).data;return{r,g,b,a:a/255};
  };
  const over=(front,back)=>{
    const a=front.a+back.a*(1-front.a);if(a===0)return{...transparent};
    return{r:(front.r*front.a+back.r*back.a*(1-front.a))/a,g:(front.g*front.a+back.g*back.a*(1-front.a))/a,b:(front.b*front.a+back.b*back.a*(1-front.a))/a,a};
  };
  // Build each element as a nested paint group. A node's background is behind
  // its child/text layer, then that whole group receives the node's opacity.
  const painted=(element,ink=transparent)=>{
    let layer={...ink};
    for(let node=element;node;node=node.parentElement){
      const style=getComputedStyle(node),background=color(style.backgroundColor)||transparent;
      layer=over(layer,background);const opacity=Math.max(0,Math.min(1,Number(style.opacity)||0));layer={...layer,a:layer.a*opacity};
    }
    return over(layer,white);
  };
  const luminance=value=>{const part=channel=>{const v=channel/255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};return .2126*part(value.r)+.7152*part(value.g)+.0722*part(value.b)};
  const contrast=(a,b)=>{const [x,y]=[luminance(a),luminance(b)];return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
  const rounded=value=>({r:Math.round(value.r),g:Math.round(value.g),b:Math.round(value.b),a:Number(value.a.toFixed(3))});
  const identify=element=>element.getAttribute('aria-label')||element.getAttribute('name')||(
    element.tagName==='INPUT'||element.tagName==='TEXTAREA'?element.value||element.getAttribute('placeholder'):element.tagName==='SELECT'?element.selectedOptions[0]?.textContent:element.textContent
  )?.trim().replace(/\s+/g,' ').slice(0,100)||element.tagName.toLowerCase();
  const readings=[],excluded=[],failures=[];
  for(const element of root.querySelectorAll('label,label>span,label small,input,textarea,select,button,button small,dt,dd,p')){
    const style=getComputedStyle(element),rect=element.getBoundingClientRect(),entry={element:element.tagName.toLowerCase(),name:identify(element)};
    if(style.display==='none'||style.visibility==='hidden'||rect.width===0||rect.height===0){excluded.push({...entry,reason:'not rendered in this panel state'});continue}
    const disabled=('disabled'in element&&element.disabled)||element.getAttribute('aria-disabled')==='true'||!!element.closest('button:disabled,input:disabled,textarea:disabled,select:disabled,fieldset:disabled');
    if(disabled){excluded.push({...entry,reason:'disabled control; reduced emphasis is intentional and no action is available'});continue}
    if(element.matches('input[type="checkbox"],input[type="radio"]')){excluded.push({...entry,reason:'non-text input; its adjacent visible label is measured separately'});continue}
    const text=element.tagName==='INPUT'||element.tagName==='TEXTAREA'?element.value||element.getAttribute('placeholder')||'':element.tagName==='SELECT'?element.selectedOptions[0]?.textContent||'':element.textContent||'';
    if(!text.trim()){excluded.push({...entry,reason:'control has no rendered text'});continue}
    const fill=style.webkitTextFillColor&&style.webkitTextFillColor!=='currentcolor'?style.webkitTextFillColor:style.color,ink=color(fill);
    if(!ink){const finding={...entry,foregroundCss:fill,reason:'computed text color could not be normalized through canvas'};readings.push(finding);failures.push(finding);continue}
    const background=painted(element),shown=painted(element,ink),ratio=contrast(shown,background);
    const reading={...entry,text:text.trim().replace(/\s+/g,' ').slice(0,100),foregroundCss:fill,foreground:rounded(shown),background:rounded(background),ratio:Number(ratio.toFixed(2)),threshold:4.5};
    readings.push(reading);if(ratio<4.5)failures.push(reading);
  }
  const ratios=readings.map(reading=>reading.ratio).filter(Number.isFinite);
  return{threshold:4.5,minimumRatio:ratios.length?Math.min(...ratios):null,method:'Canvas-normalized computed CSS color with nested ancestor background and opacity composition over browser white',readings,excluded,failures};
}

export async function checkPfdTerrain(options) {
  const baseUrl=String(options?.baseUrl||'').replace(/\/$/,'');
  const password=String(options?.password||'');
  assert(baseUrl,'baseUrl is required');assert(password,'password is required');
  const cockpitPath=options?.cockpitPath||'/dashboard/flight';
  assert(cockpitPath.startsWith('/'),'cockpitPath must be absolute');
  const artifactsGiven=options?.artifacts||'vendor/terrain-pfd-check';
  const artifacts=isAbsolute(artifactsGiven)?artifactsGiven:resolve(REPO,artifactsGiven);
  await mkdir(artifacts,{recursive:true});

  let chromium;
  try{({chromium}=await import('playwright'))}catch{throw new Error('Playwright is required: npm install, then npx playwright install chromium')}
  const browser=await chromium.launch(options?.launchOptions||{});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:'light'});
  const login=await context.request.post(`${baseUrl}/login`,{form:{password}});
  if(!login.ok()){await browser.close();throw new Error(`Console sign-in failed (${login.status()})`)}

  const page=await context.newPage();page.setDefaultTimeout(options?.timeoutMs||20_000);
  const controller=fixtureController(),browserRequests=[],pageErrors=[];
  page.on('request',request=>browserRequests.push({method:request.method(),url:request.url()}));
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route(TERRAIN_API,route=>controller.route(route));
  const button=(name,root=page)=>root.getByRole('button',{name,exact:true});
  const panel=()=>page.getByRole('dialog',{name:'Cockpit display and data sources',exact:true});
  const terrain=()=>panel().getByRole('region',{name:'Official controller terrain',exact:true});
  const checks=[],contrastResults=[];
  const check=async(name,run)=>{await run();checks.push(name)};
  const clickFor=async(name,path,root=terrain())=>{
    const expected=`/cockpit/api/terrain-service${path==='/'?'':path}`;
    const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname===expected);
    await button(name,root).click();const response=await responsePromise,request=response.request();
    let body=null;if(request.method()==='POST'){try{body=request.postDataJSON()}catch{}}
    return {method:request.method(),body,status:response.status()};
  };
  try{
  await page.goto(baseUrl+cockpitPath,{waitUntil:'load'});
  await page.locator('main.y-cockpit').waitFor();
  await page.locator('.pfd-svg').waitFor();
  await button('Official terrain service').waitFor();
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="Official terrain service"]')?.textContent?.includes('Checking'));

    await button('Official terrain service').click();await panel().waitFor();await terrain().getByText('Prepare terrain service coverage',{exact:true}).waitFor();
    await check('prepare success originates in Preview and Prepare buttons',async()=>{
      for(const [side,value] of Object.entries({north:35.1,south:35,west:-84.1,east:-84}))await terrain().getByLabel(`Manual terrain ${side} bound`,{exact:true}).fill(String(value));
      const preview=await clickFor('Preview area','/preview');await terrain().getByRole('img',{name:'Server calculated terrain coverage geometry'}).waitFor();
      assert.equal(preview.method,'POST');assert.equal(preview.body.kind,'manual');assert.deepEqual(preview.body.bounds,{north:35.1,south:35,west:-84.1,east:-84});
      controller.behavior.prepare='complete';const prepare=await clickFor('Prepare 1 tiles','/prepare');await terrain().getByText('1 prepared area',{exact:true}).waitFor();
      assert.equal(prepare.method,'POST');assert.match(prepare.body.previewId,/^[0-9a-f-]{36}$/);
    });
    await check('editing reviewed bounds requires a new preview',async()=>{
      await clickFor('Preview area','/preview');
      await terrain().getByLabel('Manual terrain north bound',{exact:true}).fill('35.2');
      await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.official-terrain button')).some(button=>/^Prepare \d+ tiles$/.test(button.textContent.trim())&&!button.disabled));
      const preview=await clickFor('Preview area','/preview');assert.equal(preview.body.bounds.north,35.2);
    });
    await check('active preparation is cancelled by its visible control',async()=>{
      controller.behavior.preview='success';controller.behavior.prepare='active';await clickFor('Preview area','/preview');
      await clickFor('Prepare 1 tiles','/prepare');await button('Cancel preparation',terrain()).waitFor();
      const cancel=await clickFor('Cancel preparation','/cancel');await terrain().getByText(/Preparation cancelled/).waitFor();assert.equal(cancel.body.jobId,UUIDS.job);
    });
    await check('quota refusal is shown from an explicit preview request',async()=>{
      controller.behavior.preview='quota';const preview=await clickFor('Preview area','/preview');await terrain().getByRole('alert').filter({hasText:'quota capacity is insufficient'}).waitFor();assert.equal(preview.status,409);
    });
    await check('stale preview is refused after a fresh Preview button request',async()=>{
      controller.behavior.preview='success';controller.behavior.prepare='stale';await clickFor('Preview area','/preview');const prepare=await clickFor('Prepare 1 tiles','/prepare');await terrain().getByRole('alert').filter({hasText:'Context changed; preview the area again'}).waitFor();assert.equal(prepare.status,409);
    });
    await check('stale policy apply reloads the current reviewed policy',async()=>{
      controller.behavior.stalePolicy=true;await terrain().getByLabel('Official terrain quota MiB',{exact:true}).fill('1024');await button('Review policy change',terrain()).click();await terrain().locator('[aria-label="Review terrain policy change"]').getByText(/512 MiB → 1024 MiB/).waitFor();
      const apply=await clickFor('Apply reviewed policy','/policy/apply');await terrain().getByRole('alert').filter({hasText:'terrain policy changed; review the current revision'}).waitFor();assert.equal(apply.status,409);assert.equal(apply.body.expectedRevision,'a'.repeat(64));assert.deepEqual(apply.body.policy,{enabled:true,provider:'ardupilot-srtm1',quotaMiB:1024});assert.equal(await terrain().getByLabel('Official terrain quota MiB',{exact:true}).inputValue(),'2048');
    });
    await check('controller reboot and unavailable status remain explicit',async()=>{
      controller.rebootStatus();let before=controller.calls.length;await button('Refresh status',terrain()).click();await terrain().getByText('Waiting for a controller terrain report.',{exact:true}).waitFor();await terrain().getByText(/Refresh failed · controller reboot invalidated/).waitFor();assert(occurrence(controller.calls,'/',before).length>=1);
      controller.behavior.statusFailureOnce=true;before=controller.calls.length;await button('Refresh status',terrain()).click();await terrain().getByRole('alert').filter({hasText:'fixture terrain status unavailable after controller reboot'}).waitFor();assert(occurrence(controller.calls,'/',before).length>=1);
    });
    await check('source ownership copy preserves operator-managed limits',async()=>{
      await terrain().getByText('Operator-managed single responder; exclusivity is not enforced.',{exact:true}).first().waitFor();await terrain().getByText('Direct routing bypass visibility is unverified.',{exact:false}).waitFor();
    });

    controller.resetStatus();await clickFor('Refresh status','/');await terrain().getByText(/Controller · 2 pending · 6 loaded · 30 m/).waitFor();
    async function selectPalette(value){
      await button('Close cockpit panel').click();await button('Display menu').click();const menu=page.getByRole('dialog');await menu.getByLabel('Cockpit palette',{exact:true}).selectOption(value);await button('Close cockpit panel').click();
      const policyReady=page.waitForResponse(response=>new URL(response.url()).pathname==='/cockpit/api/terrain-service/policy');await button('Official terrain service').click();await panel().waitFor();await policyReady;assert.equal(await page.locator('main.y-cockpit').getAttribute('data-palette'),value);
    }
    for(const [width,height,label] of [[1440,900,'laptop-1440x900'],[1024,768,'tablet-1024x768']]){
      await page.setViewportSize({width,height});
      for(const palette of ['day','night']){
        await selectPalette(palette);
        for(const [side,value] of Object.entries({north:35.1,south:35,west:-84.1,east:-84}))await terrain().getByLabel(`Manual terrain ${side} bound`,{exact:true}).fill(String(value));
        await clickFor('Preview area','/preview');
        const panelBody=panel().locator('.cockpit-dialog-body');await panelBody.evaluate(node=>{node.scrollTop=0});
        const geometry=await panel().evaluate(node=>({width:node.getBoundingClientRect().width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}));
        assert(geometry.width>300,`${label} terrain panel must be visible`);assert(geometry.scrollWidth<=geometry.clientWidth+1,`${label} ${palette} terrain panel must not overflow sideways`);
        const contrast=await terrain().evaluate(measureTerrainControlContrast);contrastResults.push({viewport:{width,height,label},palette,...contrast});
        assert.deepEqual(contrast.failures,[],`${label} ${palette} active terrain control text must meet 4.5:1 contrast`);
        await page.screenshot({path:resolve(artifacts,`terrain-panel-${label}-${palette}.png`),animations:'disabled'});
        await terrain().locator('.official-terrain__prepare').evaluate(node=>node.scrollIntoView({block:'start'}));
        await page.screenshot({path:resolve(artifacts,`terrain-panel-${label}-${palette}-source-prepare.png`),animations:'disabled'});
        await terrain().locator('.official-terrain__controller').evaluate(node=>node.scrollIntoView({block:'start'}));
        await page.screenshot({path:resolve(artifacts,`terrain-panel-${label}-${palette}-controller-ownership.png`),animations:'disabled'});
      }
    }
    checks.push('day/night top, source/prepare and controller/ownership captures at laptop 1440x900 and tablet 1024x768');
    checks.push('active panel controls and source/status readouts meet 4.5:1 contrast in every captured palette and viewport');
    assert(controller.calls.filter(call=>call.method==='POST').every(call=>call.cockpitHeader==='1'),'Every terrain mutation must carry the cockpit action header');
    const flightCommandRequests=browserRequests.filter(request=>FLIGHT_COMMAND_API.test(request.url));
    assert.equal(flightCommandRequests.length,0,'Terrain panel scenarios must emit no flight command route');
    assert.deepEqual(pageErrors,[],'PFD terrain scenarios must produce no uncaught page errors');
    const captures=[];for(const label of ['laptop-1440x900','tablet-1024x768'])for(const palette of ['day','night'])captures.push(`terrain-panel-${label}-${palette}.png`,`terrain-panel-${label}-${palette}-source-prepare.png`,`terrain-panel-${label}-${palette}-controller-ownership.png`);
    const result={source:'Authenticated production PFD with explicitly controlled terrain-service API fixture scenarios; actual backend evidence is separate',baseUrl:new URL(baseUrl).origin,cockpitPath,checks,terrainApiCalls:controller.calls,flightCommandRequests,pageErrors,contrastResults,captures};
    await writeFile(resolve(artifacts,'results.json'),JSON.stringify(result,null,2)+'\n');
    return result;
  } catch(error) {
    await page.screenshot({path:resolve(artifacts,'terrain-panel-failure.png'),animations:'disabled'}).catch(()=>{});
    throw error;
  } finally {
    await browser.close();
  }
}

function cliArg(name){const index=process.argv.indexOf(`--${name}`);return index<0?undefined:process.argv[index+1]}
function usage(){return 'Usage: node scripts/terrain/check-pfd.mjs --base-url URL --password PASSWORD [--cockpit-path /dashboard/flight] [--artifacts DIR]\n'}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const baseUrl=cliArg('base-url'),password=cliArg('password');
  if(!baseUrl||!password){process.stderr.write(usage());process.exitCode=2}
  else checkPfdTerrain({baseUrl,password,cockpitPath:cliArg('cockpit-path'),artifacts:cliArg('artifacts')}).then(result=>process.stdout.write(`Terrain PFD API-fixture scenarios passed: ${result.checks.length} checks\n`)).catch(error=>{process.stderr.write(`Terrain PFD API-fixture scenarios failed: ${error?.stack||error}\n`);process.exitCode=1});
}
