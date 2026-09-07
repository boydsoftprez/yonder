// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {terrariumHeight,tilePosition,tileCoordinate,localPosition,cameraBasis,viewMatrix,projectionMatrix,transformPoint,terrainPose,buildTerrainMesh,terrainTileSampler} from './terrain-state.mjs';
const close=(a,b,t=.0001)=>assert.ok(Math.abs(a-b)<t,`${a} should be close to ${b}`);
test('Terrarium meters decode integer, fractional and below-sea-level values',()=>{
 close(terrariumHeight(137,219,68),2523.265625);close(terrariumHeight(128,0,0),0);close(terrariumHeight(127,246,0),-10);
});
test('Mercator tile coordinate round trip and local geographic scales',()=>{
 const ll={lat:35.9607874,lon:-83.3668696};const tile=tilePosition(ll.lat,ll.lon,12),point=tileCoordinate(tile.x,tile.y,12);
 close(point.lat,ll.lat);close(point.lon,ll.lon);const east=localPosition(ll.lat,ll.lon+.001,ll),north=localPosition(ll.lat+.001,ll.lon,ll);
 close(east[0],90.1,.2);close(east[2],0);close(north[2],-111.195,.01);
});
test('Camera heading, pitch and positive right bank preserve aircraft orientation',()=>{
 const level=cameraBasis(0,0,0),east=cameraBasis(90,0,0),bank=cameraBasis(0,0,30),up=cameraBasis(0,10,0);
 assert.deepEqual(level.forward,[0,0,-1]);close(east.forward[0],1);close(east.forward[2],0);
 assert.ok(bank.right[1]<0&&bank.up[0]>0);assert.ok(up.forward[1]>0);
});
test('Perspective horizon aligns with PFD y225 and positive pitch lowers horizon',()=>{
 const projection=projectionMatrix(),project=(point,heading=0,pitch=0,roll=0)=>{
 const view=viewMatrix([0,0,0],cameraBasis(heading,pitch,roll));const p=transformPoint(projection,transformPoint(view,[...point,1]));return [(p[0]/p[3]+1)*320,(1-p[1]/p[3])*325];};
 close(project([0,0,-1000])[0],320);close(project([0,0,-1000])[1],225);
 close(project([0,0,-1000],0,1)[1],230,.01);assert.ok(project([100,0,-1000],0,0,20)[1]<225);
 close(project([1000,0,0],90)[0],320);
});
test('Terrain pose needs fresh GPS and attitude; MSL altitude is never relative altitude',()=>{
 const f={live:true,attitudeValid:true,altitude:1000,roll:0,pitch:0,heading:90};const t={ready:true,fixType:3,latitude:35.96,longitude:-83.36,gpsAltitudeM:410,relativeAltitudeM:91};
 assert.equal(terrainPose(f,t).altitude,410);assert.equal(terrainPose(f,{...t,gpsAltitudeM:undefined}).altitude,304.8);
 for(const invalid of [{...t,ready:false},{...t,fixType:2},{...t,latitude:null},{...t,latitude:90}])assert.equal(terrainPose(f,invalid),null);
 assert.equal(terrainPose({...f,heading:null},t),null);assert.equal(terrainPose({...f,live:false},t),null);
});
test('Mesh samples actual RGBA heights with upward normals and bounded indices',()=>{
 const rgba=new Uint8ClampedArray(4*4*4);for(let i=0;i<16;i++)rgba.set([128,100,0,255],i*4);
 const mesh=buildTerrainMesh({rgba,width:4,height:4,x:1099,y:1608,z:12,segments:4,origin:{lat:35.96,lon:-83.36}});
 assert.equal(mesh.positions.length,25*3);assert.equal(mesh.indices.length,4*4*6);
 for(let i=1;i<mesh.positions.length;i+=3)close(mesh.positions[i],100);
 for(let i=1;i<mesh.normals.length;i+=3)assert.ok(mesh.normals[i]>.999);
 assert.ok(Math.max(...mesh.indices)<25);assert.equal(mesh.minimum,100);assert.equal(mesh.maximum,100);
});

test('Adjacent terrain meshes share exact edge elevations without cracks',()=>{
 const tile=(x,h)=>{const rgba=new Uint8ClampedArray(4*4*4);for(let i=0;i<16;i++)rgba.set([128,h,0,255],i*4);return {rgba,width:4,height:4,x,y:1608,z:12};};
 const left=tile(1099,100),right=tile(1100,120),sample=terrainTileSampler([left,right]);
 for(const v of [0,.25,.5,.75,1]){close(sample(1099,1608,1,v),110);close(sample(1100,1608,0,v),110);}
});

test('Imagery UVs register north-west and south-east tile corners without changing elevation scale',()=>{
 const rgba=new Uint8ClampedArray(4*4*4);for(let row=0;row<4;row++)for(let col=0;col<4;col++)rgba.set([128,100+row*30+col*10,0,255],(row*4+col)*4);
 const mesh=buildTerrainMesh({rgba,width:4,height:4,x:1099,y:1608,z:12,segments:4,origin:{lat:35.96,lon:-83.36}});
 assert.ok(mesh.uv instanceof Float32Array,'Mesh must supply geographic imagery coordinates');
 assert.deepEqual([...mesh.uv.slice(0,2)],[0,0]);assert.deepEqual([...mesh.uv.slice(-2)],[1,1]);
 assert.equal(mesh.minimum,100);assert.equal(mesh.maximum,220,'Real elevation is not exaggerated to increase visible relief');
 assert.equal(mesh.uv.length,25*2);assert.equal(mesh.x,1099);assert.equal(mesh.y,1608);
});

test('Near imagery covers aircraft across coarse tile edges at metre scale with bounded area',async()=>{
 const {terrainImageryPatch}=await import('./terrain-state.mjs');
 assert.equal(typeof terrainImageryPatch,'function','Aircraft-centered imagery coverage is available');
 const home={lat:35.9607874,lon:-83.3668696},patch=terrainImageryPatch(home);
 assert.equal(patch.z,17);assert.equal(patch.side,8);assert.equal(patch.tiles.length,64);
 assert.ok(patch.metresPerPixel>.9&&patch.metresPerPixel<1.1);
 const point=tilePosition(home.lat,home.lon,patch.z);
 assert.ok(point.x-patch.x>=3&&point.x-patch.x<5);assert.ok(point.y-patch.y>=3&&point.y-patch.y<5);
 assert.ok(patch.y+patch.side>Math.ceil(tilePosition(home.lat,home.lon).y)*32,'Near detail crosses the current coarse elevation tile boundary');
 assert.equal(terrainImageryPatch({...home,lon:home.lon+.00001}).key,patch.key,'Small aircraft motion retains atlas');
 const shifted=terrainImageryPatch(tileCoordinate(point.x+2,point.y,patch.z));
 assert.equal(shifted.tiles.filter(t=>patch.tiles.some(p=>p.x===t.x&&p.y===t.y)).length,48,'Recenter reuses 48 of 64 tiles');
 const dateline=terrainImageryPatch({lat:0,lon:179.9999});assert.ok(dateline.tiles.every(t=>t.x>=0&&t.x<2**17));
});

test('DEM clearance preserves MSL and actual negative clearance without using REL HOME',async()=>{
 const {terrainClearance}=await import('./terrain-state.mjs');
 assert.equal(typeof terrainClearance,'function','DEM clearance is exposed independently of camera pose');
 const pose={lat:35.96,lon:-83.36,altitude:407.17,relativeAltitudeM:91.44};
 const sample=()=>314.79,clearance=terrainClearance(pose,sample);
 close(clearance.groundElevationM,314.79);close(clearance.estimatedAglM,92.38);
 close(terrainClearance({...pose,altitude:300},sample).estimatedAglM,-14.79);
 assert.equal(terrainClearance(pose,null),null);
 assert.equal(terrainClearance(pose,()=>NaN),null);
});

test('Near atlas UV registration agrees with geographic coordinates and wraps the dateline',async()=>{
 const {terrainImageryPatch,terrainImageryTransform}=await import('./terrain-state.mjs');
 assert.equal(typeof terrainImageryTransform,'function','Atlas registration uses geographic bounds');
 for(const coordinate of [{lat:35.9607874,lon:-83.3668696},{lat:0,lon:179.9999}]){
  const patch=terrainImageryPatch(coordinate),scale=2**(patch.z-12),x=Math.floor(patch.x/scale),y=Math.floor(patch.y/scale),transform=terrainImageryTransform({x:(x+4096)%4096,y},patch);
  const u=patch.x/scale-x,v=patch.y/scale-y;
  close(u*transform[2]+transform[0],0);close(v*transform[3]+transform[1],0);
  close((u+patch.side/scale)*transform[2]+transform[0],1);close((v+patch.side/scale)*transform[3]+transform[1],1);
 }
});

test('Terrain chunks reject geometry outside the camera without clipping visible relief',async()=>{
 const {terrainFrustum,terrainChunkVisible}=await import('./terrain-state.mjs');
 assert.equal(typeof terrainFrustum,'function','A terrain frustum is available for bounded chunk culling');
 const frustum=terrainFrustum(viewMatrix([0,400,0],cameraBasis(0,0,0)),projectionMatrix());
 assert.equal(terrainChunkVisible({minimum:[-100,0,-1000],maximum:[100,350,-800]},frustum),true);
 assert.equal(terrainChunkVisible({minimum:[-100,0,800],maximum:[100,350,1000]},frustum),false,'Geometry behind the aircraft is not submitted');
 assert.equal(terrainChunkVisible({minimum:[10000,0,-1000],maximum:[11000,350,-800]},frustum),false);
 assert.equal(terrainChunkVisible({minimum:[-100,0,-19000],maximum:[100,350,-18500]},frustum),false);
 assert.equal(terrainChunkVisible({minimum:[-100,0,-1000],maximum:[100,1500,1000]},frustum),true,'A mountain crossing the near plane stays visible');
});

test('Terrain chunks partition every real triangle exactly once with tight elevation bounds',()=>{
 const rgba=new Uint8ClampedArray(4*4*4);for(let row=0;row<4;row++)for(let col=0;col<4;col++)rgba.set([128,100+row*30+col*10,0,255],(row*4+col)*4);
 const mesh=buildTerrainMesh({rgba,width:4,height:4,x:1099,y:1608,z:12,segments:32,origin:{lat:35.96,lon:-83.36}});
 assert.ok(mesh.chunks?.length>1,'Terrain exposes independently visible draw chunks');
 assert.equal(mesh.chunks.reduce((sum,c)=>sum+c.count,0),mesh.indices.length);
 const triangles=new Set();for(const chunk of mesh.chunks){
  for(let i=chunk.offset;i<chunk.offset+chunk.count;i+=3){const key=[...mesh.indices.slice(i,i+3)].sort((a,b)=>a-b).join('/');assert.ok(!triangles.has(key));triangles.add(key);}
  for(let i=chunk.offset;i<chunk.offset+chunk.count;i++)for(let axis=0;axis<3;axis++){const p=mesh.positions[mesh.indices[i]*3+axis];assert.ok(p>=chunk.minimum[axis]&&p<=chunk.maximum[axis]);}
 }
});

test('Nearby mesh retains native DEM ridges that every-other-pixel tessellation loses',()=>{
 const rgba=new Uint8ClampedArray(256*256*4);for(let row=0;row<256;row++)for(let col=0;col<256;col++)rgba.set([128,col===64?200:100,0,255],(row*256+col)*4);
 const tile={rgba,width:256,height:256,x:1099,y:1608,z:12},sampleHeight=terrainTileSampler([tile]),args={...tile,origin:{lat:35.96,lon:-83.36},sampleHeight};
 const old=buildTerrainMesh({...args,segments:128}),detail=buildTerrainMesh(args);
 assert.equal(old.maximum,150);assert.ok(detail.maximum>190&&detail.maximum<=200,'Native source relief is retained without exaggerating it');
 assert.ok(detail.chunks.every(chunk=>chunk.coarseCount>0&&chunk.coarseCount<chunk.count),'Distant terrain has a cheaper draw range');
});

test('Near and distant terrain draw ranges share identical edges without cracks',()=>{
 const rgba=new Uint8ClampedArray(256*256*4);for(let i=0;i<256*256;i++)rgba.set([128,100,0,255],i*4);
 const mesh=buildTerrainMesh({rgba,width:256,height:256,x:1099,y:1608,z:12,origin:{lat:35.96,lon:-83.36}});
 const exterior=(offset,count)=>{const edges=new Map();for(let at=offset;at<offset+count;at+=3){const triangle=mesh.indices.slice(at,at+3);assert.equal(new Set(triangle).size,3);for(let k=0;k<3;k++){const a=triangle[k],b=triangle[(k+1)%3],key=a<b?`${a}/${b}`:`${b}/${a}`;edges.set(key,(edges.get(key)||0)+1);}}return [...edges].filter(([,count])=>count===1).map(([key])=>key).sort();};
 assert.ok(mesh.chunks[0].coarseCount>0,'Native terrain has coarse alternate ranges');
 for(const chunk of mesh.chunks)assert.deepEqual(exterior(chunk.offset,chunk.count),exterior(chunk.coarseOffset,chunk.coarseCount));
});
