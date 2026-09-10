// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-22: explicit selected provider, native cells, bounded request/memory budgets.
import {validateTerrainManifest,decodeTerrainTile,latLonToUtm,sampleTerrain} from 'yonder-core/terrain';
import {routeSamples,buildMissionProfile} from './mission-profile.mjs';
const caches=new WeakMap(),MAX_TILES=192,MAX_BYTES=32*1024*1024;
const contains=(t,p)=>p.eastingM>=t.originEastingM&&p.eastingM<=t.originEastingM+(t.columns-1)*t.spacingM&&p.northingM<=t.originNorthingM&&p.northingM>=t.originNorthingM-(t.rows-1)*t.spacingM;
export async function loadMissionTerrain({route,home,datum,provider,signal}){
 const unavailable=reason=>({...buildMissionProfile(route,home),reason,manifest:null,errors:0});
 if(!provider)return unavailable('Select a terrain data source');
 const raw=await provider.terrainManifest({signal});
 if(!raw)return unavailable('Enable terrain and select a prepared terrain source');
 const manifest=validateTerrainManifest(raw),compatible=datum===manifest.verticalDatum&&manifest.verticalTransform.verified;
 if(!compatible)return {...unavailable('Plan and terrain height references must match'),manifest};
 const project=p=>{try{const u=latLonToUtm(p.lat,p.lon,manifest.horizontalCrs.zone);return u.hemisphere===manifest.horizontalCrs.hemisphere?u:null}catch{return null}};
 const positions=[...route.points,...routeSamples(route)].map(project).filter(Boolean);
 const candidates=manifest.tiles.filter(t=>t.level===0&&positions.some(p=>contains(t,p)));
 let bytes=0;const selected=[];
 for(const t of candidates){if(selected.length>=MAX_TILES||bytes+t.decodedBytes>MAX_BYTES)break;selected.push(t);bytes+=t.decodedBytes;}
 let cache=caches.get(provider);
 if(!cache||cache.revision!==provider.revision||cache.manifest!==manifest.id){cache={revision:provider.revision,manifest:manifest.id,tiles:new Map(),bytes:0};caches.set(provider,cache)}
 const loaded=[],errors=[];let next=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<selected.length&&!signal?.aborted){const t=selected[next++],key=t.id+'/'+t.sha256;try{
   let tile=cache.tiles.get(key);
   if(!tile){tile=decodeTerrainTile(await provider.terrainTile(t,{signal}),t);if(signal?.aborted)break;cache.tiles.set(key,tile);cache.bytes+=t.decodedBytes;
    while(cache.bytes>MAX_BYTES){const [old,value]=cache.tiles.entries().next().value;cache.tiles.delete(old);cache.bytes-=value.descriptor.decodedBytes;}}
   loaded.push(tile);
  }catch(e){if(signal?.aborted)break;errors.push(e.message)}}
 }));
 if(signal?.aborted)throw new DOMException('Profile cancelled','AbortError');
 const sample=p=>{const u=project(p),result={groundM:null,surfaceM:null};if(!u)return result;
  for(const tile of loaded){if(!contains(tile.descriptor,u))continue;const s=sampleTerrain(tile,u.eastingM,u.northingM);if(result.groundM===null)result.groundM=s.groundM;if(result.surfaceM===null)result.surfaceM=s.surfaceM;if(result.groundM!==null&&result.surfaceM!==null)break;}return result;};
 return {...buildMissionProfile(route,home,sample,true),manifest,errors:errors.length,loadedTiles:loaded.length,limited:selected.length<candidates.length,
  reason:loaded.length?'Native terrain and mapped surface samples':'No native terrain coverage for this route'};
}
