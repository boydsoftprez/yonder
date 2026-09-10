// SPDX-License-Identifier: GPL-3.0-or-later
import{test}from'node:test';import assert from'node:assert/strict';import{createGroundServer}from'./ground-data-server.mjs';
test('ground traffic identifies the project as required by the provider',async()=>{
 const app=await createGroundServer({allowOrigin:'http://127.0.0.1:4196',fetchImpl:async(_url,options)=>{
  const identity=new Headers(options.headers).get('user-agent')||'';
  return /Yonder.*https:\/\/github.com\/boydsoftprez\/yonder/.test(identity)
   ?new Response(JSON.stringify({now:Date.now(),ac:[{hex:'abc123',lat:35.96,lon:-83.36,seen_pos:0}]}))
   :new Response('User-Agent too generic; include valid contact info.',{status:403});
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/traffic/35.96/-83.36/10`);assert.equal(r.status,200);assert.equal((await r.json()).ac[0].hex,'abc123');}finally{await app.close();}
});
test('ground relay shares a provider cooldown across traffic ranges and browser tabs',async()=>{
 let now=1788790000000,calls=0;
 const app=await createGroundServer({allowOrigin:'http://127.0.0.1:4196',now:()=>now,fetchImpl:async()=>{
  calls++;return calls===1?new Response('',{status:429}):new Response(JSON.stringify({now,ac:[]}));
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const first=await fetch(base+'/traffic/35.96/-83.36/10');assert.equal(first.status,429);assert.equal(first.headers.get('Retry-After'),'60');
  now+=10000;const second=await fetch(base+'/traffic/35.96/-83.36/25');assert.equal(second.status,429);assert.equal(second.headers.get('Retry-After'),'50');assert.equal(calls,1);
  now+=50000;assert.equal((await fetch(base+'/traffic/35.96/-83.36/25')).status,200);assert.equal(calls,2);
 }finally{await app.close();}
});
test('ground relay restricts origin/method/routes and never contacts an aircraft',async()=>{const calls=[];const app=await createGroundServer({allowOrigin:'http://127.0.0.1:4207',fetchImpl:async url=>{calls.push(url);return new Response(JSON.stringify({now:Date.now(),ac:[]}));}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;try{assert.equal((await fetch(base+'/traffic/35.96079/-83.36687/1',{headers:{Origin:'https://elsewhere.invalid'}})).status,403);assert.equal((await fetch(base+'/cockpit/api/command',{method:'POST'})).status,405);assert.equal((await fetch(base+'/proxy?url=http://aircraft/')).status,404);assert.equal(calls.length,0);const r=await fetch(base+'/traffic/35.96079/-83.36687/1',{headers:{Origin:'http://127.0.0.1:4207'}});assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'http://127.0.0.1:4207');assert.equal(calls[0],'https://api.adsb.lol/v2/point/35.96079/-83.36687/1');}finally{await app.close();}});
