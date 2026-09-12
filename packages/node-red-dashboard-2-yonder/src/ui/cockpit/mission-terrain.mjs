// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-22/28: official MSL calculations with an optional, separately sourced display surface.
import {validateTerrainManifest,decodeTerrainTile,latLonToUtm,sampleTerrain} from 'yonder-core/terrain';
import {routeSamples,buildMissionProfile} from './mission-profile.mjs';
import {readOfficialSamples} from './official-terrain-datum.mjs';

const displayCaches=new WeakMap(),MAX_DISPLAY_TILES=192,MAX_DISPLAY_BYTES=32*1024*1024;
const key=point=>`${Number(point.lat).toFixed(7)}/${Number(point.lon).toFixed(7)}`;
const contains=(tile,point)=>point.eastingM>=tile.originEastingM&&point.eastingM<=tile.originEastingM+(tile.columns-1)*tile.spacingM
  &&point.northingM<=tile.originNorthingM&&point.northingM>=tile.originNorthingM-(tile.rows-1)*tile.spacingM;
const cancelled=error=>error?.name==='AbortError';

function displayUnavailable(reason) {
  return {sample:()=>null,source:null,reason,errors:0,loadedTiles:0,limited:false};
}

function displayMetadata(manifest) {
  return {id:manifest.id,title:manifest.title,verticalDatum:manifest.verticalDatum,verticalTransform:manifest.verticalTransform,
    sourceResolutionM:manifest.sourceResolutionM,surfaceDescription:manifest.surfaceDescription,sources:manifest.sources,limitations:manifest.limitations};
}

async function loadDisplaySurface(display,positions,signal) {
  if(!display?.enabled)return displayUnavailable('Detailed display surface disabled');
  const provider=display.provider;
  if(!provider||typeof provider!=='object')return displayUnavailable('Select a detailed display terrain source');
  if(provider.options?.mode==='aircraft'&&display.aircraftConsent!==true)return displayUnavailable('Detailed display surface from the aircraft requires an explicit load');
  try {
    const raw=await provider.terrainManifest({signal});
    if(!raw)return displayUnavailable('Enable detailed terrain and select a prepared display source');
    const manifest=validateTerrainManifest(raw);
    if(display.datum!=='EGM96'||manifest.verticalDatum!=='EGM96'||manifest.verticalTransform.verified!==true) {
      return displayUnavailable('Detailed surface requires a verified EGM96 height reference for the MSL profile');
    }
    const project=point=>{try{const value=latLonToUtm(point.lat,point.lon,manifest.horizontalCrs.zone);return value.hemisphere===manifest.horizontalCrs.hemisphere?value:null}catch{return null}};
    const projected=positions.map(project).filter(Boolean),candidates=manifest.tiles.filter(tile=>tile.level===0&&projected.some(point=>contains(tile,point)));
    let selectedBytes=0;const selected=[];
    for(const tile of candidates){if(selected.length>=MAX_DISPLAY_TILES||selectedBytes+tile.decodedBytes>MAX_DISPLAY_BYTES)break;selected.push(tile);selectedBytes+=tile.decodedBytes}
    let cache=displayCaches.get(provider);
    if(!cache||cache.revision!==provider.revision||cache.manifest!==manifest.id){cache={revision:provider.revision,manifest:manifest.id,tiles:new Map(),bytes:0};displayCaches.set(provider,cache)}
    const loaded=[],errors=[];let next=0;
    await Promise.all(Array.from({length:2},async()=>{
      while(next<selected.length&&!signal?.aborted){const tile=selected[next++],cacheKey=tile.id+'/'+tile.sha256;try{
        let decoded=cache.tiles.get(cacheKey);
        if(!decoded){decoded=decodeTerrainTile(await provider.terrainTile(tile,{signal}),tile);if(signal?.aborted)break;cache.tiles.set(cacheKey,decoded);cache.bytes+=tile.decodedBytes;
          while(cache.bytes>MAX_DISPLAY_BYTES){const [old,value]=cache.tiles.entries().next().value;cache.tiles.delete(old);cache.bytes-=value.descriptor.decodedBytes}}
        loaded.push(decoded);
      }catch(error){if(signal?.aborted)break;errors.push(error instanceof Error?error.message:String(error))}}
    }));
    if(signal?.aborted)throw new DOMException('Terrain sampling cancelled','AbortError');
    const sample=point=>{const projectedPoint=project(point);if(!projectedPoint)return null;
      for(const tile of loaded){if(!contains(tile.descriptor,projectedPoint))continue;const value=sampleTerrain(tile,projectedPoint.eastingM,projectedPoint.northingM).surfaceM;if(Number.isFinite(value))return value}
      return null};
    return {sample,source:displayMetadata(manifest),reason:loaded.length?`Detailed display surface · ${loaded.length} loaded ${loaded.length===1?'tile':'tiles'}`:'No detailed display surface coverage for this route',
      errors:errors.length,loadedTiles:loaded.length,limited:selected.length<candidates.length};
  } catch(error) {
    if(cancelled(error))throw error;
    return displayUnavailable(`Detailed display surface unavailable · ${error instanceof Error?error.message:String(error)}`);
  }
}

export async function loadMissionTerrain({route,home,client,signal,officialEnabled=true,display}) {
  const positions=[...route.points,...routeSamples(route)];
  let samples;
  if(!officialEnabled)samples=positions.map(()=>({available:false,reason:'official-terrain-disabled'}));
  else try {samples=await readOfficialSamples(client,positions.map(({lat,lon})=>({lat,lon})),signal)}
  catch(error){if(cancelled(error))throw error;samples=positions.map(()=>({available:false,reason:error instanceof Error?error.message:'official-terrain-sample-failed'}))}
  const surface=await loadDisplaySurface(display,positions,signal),byPosition=new Map();
  for(let index=0;index<positions.length;index++)byPosition.set(key(positions[index]),samples[index]);
  const sample=point=>{const value=byPosition.get(key(point));return {groundM:value?.available?value.heightM:null,surfaceM:surface.sample(point)}};
  const profile=buildMissionProfile(route,home,sample,true),available=samples.filter(value=>value.available),reasons=[...new Set(samples.filter(value=>!value.available).map(value=>value.reason))];
  const first=available[0];
  return {...profile,manifest:null,errors:officialEnabled?samples.length-available.length:0,limited:false,
    source:first?{provider:first.provider,datum:first.datum,spacingM:first.spacingM,generations:[...new Set(available.map(value=>value.generation))],datumEvidence:first.datumEvidence}:null,
    reason:available.length?`Official MSL terrain · ${available.length} of ${samples.length} samples`:`Official terrain unavailable${reasons.length?' · '+reasons.join(' · '):''}`,
    unavailableReasons:reasons,displaySource:surface.source,displayReason:surface.reason,displayErrors:surface.errors,
    displayLoadedTiles:surface.loadedTiles,displayLimited:surface.limited};
}
