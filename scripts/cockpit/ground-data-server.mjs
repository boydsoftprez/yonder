// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: optional operator-owned ground relay; contains no aircraft transport.
import {createServer} from 'node:http';
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateTerrainManifest} from '../../packages/yonder-core/dist/terrain/index.js';
import {ByteCache,readBytes,imageType,validTile} from '../../packages/node-red-dashboard-2-yonder/src/ui/cockpit/ground/ground-utils.mjs';
const services={imagery:'World_Imagery',places:'Reference/World_Boundaries_and_Places',roads:'Reference/World_Transportation'};
async function fileBytes(path,limit){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new Error('Ground file exceeds limit');const bytes=await file.readFile();if(bytes.length!==stat.size)throw new Error('Ground file changed');return bytes;}finally{await file.close();}}
export async function createGroundServer({allowOrigin,terrainDirectory=null,fetchImpl=fetch,now=Date.now}={}){
 const origin=new URL(allowOrigin);if(!['http:','https:'].includes(origin.protocol)||origin.origin!==allowOrigin)throw new Error('An exact console origin is required');
 let manifest=null,directory=null,active=0,closed=false;const cache=new ByteCache(32*1024*1024,128),controllers=new Set();
 if(terrainDirectory){directory=await realpath(terrainDirectory);manifest=validateTerrainManifest(JSON.parse((await fileBytes(join(directory,'manifest.json'),4*1024*1024)).toString('utf8')));}
 const server=createServer(async(req,res)=>{
  if(!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host||'')){res.writeHead(403);res.end();return;}
  if(req.headers.origin&&req.headers.origin!==allowOrigin){res.writeHead(403);res.end();return;}
  res.setHeader('Access-Control-Allow-Origin',allowOrigin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','Retry-After');res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);res.end();return;}
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const path=req.url||'',tile=/^\/tiles\/(elevation|imagery|places|roads)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/.exec(path),traffic=/^\/traffic\/(-?\d{1,2}(?:\.\d{1,6})?)\/(-?\d{1,3}(?:\.\d{1,6})?)\/(\d{1,3})$/.exec(path),pack=/^\/terrain\/files\/([-a-zA-Z0-9_.]{1,128})$/.exec(path);
  let url=null,limit=524288,ttl=60000;
  try{
   if(path==='/terrain/manifest'&&manifest){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));return;}
   if(pack&&manifest){const descriptor=manifest.tiles.find(t=>t.file===pack[1]);if(!descriptor){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','application/octet-stream');res.end(await fileBytes(join(directory,descriptor.file),descriptor.bytes));return;}
   if(tile){const [_,layer,zs,xs,ys]=tile,z=Number(zs),x=Number(xs),y=Number(ys);validTile(layer,z,x,y);url=layer==='elevation'?`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`:`https://server.arcgisonline.com/ArcGIS/rest/services/${services[layer]}/MapServer/tile/${z}/${y}/${x}`;}
   else if(traffic){const lat=Number(traffic[1]),lon=Number(traffic[2]),radius=Number(traffic[3]);if(Math.abs(lat)>90||Math.abs(lon)>180||radius<1||radius>100)throw new Error('Invalid region');url=`https://api.adsb.lol/v2/point/${lat.toFixed(5)}/${lon.toFixed(5)}/${radius}`;limit=4*1024*1024;ttl=2000;}
   else{res.writeHead(404);res.end();return;}
   const cached=cache.get(url,now());if(cached){res.setHeader('Content-Type',cached.type);res.end(cached.bytes);return;}
   if(closed||active>=6){res.setHeader('Retry-After','2');res.writeHead(429);res.end();return;}
   active++;const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),12000),cancel=()=>controller.abort();res.once('close',cancel);
   try{const response=await fetchImpl(url,{signal:controller.signal,redirect:'error',credentials:'omit'});if(!response.ok){await response.body?.cancel();const retry=response.headers.get('retry-after');if(retry&&/^\d{1,5}$/.test(retry))res.setHeader('Retry-After',retry);res.writeHead(response.status);res.end();return;}
    const bytes=await readBytes(response,limit),type=tile?imageType(bytes,response.headers.get('content-type')?.split(';')[0]):'application/json';if(traffic)JSON.parse(new TextDecoder().decode(bytes));if(!closed)cache.put(url,{bytes,type},bytes.length,now()+ttl);res.setHeader('Content-Type',type);res.end(bytes);
   }finally{clearTimeout(timer);res.removeListener('close',cancel);controllers.delete(controller);active--;}
  }catch{if(!res.headersSent)res.writeHead(502);res.end('Ground source unavailable');}
 });
 return{server,close:async()=>{closed=true;for(const c of controllers)c.abort();cache.clear();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};for(let i=0;i<args.length;i+=2)if(!['--allow-origin','--terrain-dir','--port'].includes(args[i])||!args[i+1])throw new Error('Usage: ground-data-server.mjs --allow-origin CONSOLE_ORIGIN [--terrain-dir DIR] [--port 4197]');
 const port=Number(get('--port')||4197);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid ground port');
 const app=await createGroundServer({allowOrigin:get('--allow-origin'),terrainDirectory:get('--terrain-dir')});await new Promise((ok,no)=>{app.server.once('error',no);app.server.listen(port,'127.0.0.1',ok);});console.log(`Ground-only geographic data http://127.0.0.1:${port}; allowed console ${get('--allow-origin')}; no aircraft connection`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().finally(()=>process.exit(0)));
}
