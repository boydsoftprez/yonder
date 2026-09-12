// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-28: flight-facing values accept only the authenticated official sample contract.
const PROVIDER='ardupilot-srtm1',DATUM='MSL',SPACING=30,MAX_BATCH=128;

export function verifiedOfficialSample(sample) {
  if(!sample?.available)return {available:false,reason:sample?.reason||'official-terrain-sample-unavailable'};
  if(sample.provider!==PROVIDER)return {available:false,reason:'official-terrain-source-unverified'};
  if(sample.datum!==DATUM||typeof sample.datumEvidence!=='string'||!sample.datumEvidence.trim())return {available:false,reason:'official-terrain-datum-unverified'};
  if(sample.spacingM!==SPACING||typeof sample.generation!=='string'||!sample.generation||!Number.isFinite(sample.heightM))return {available:false,reason:'official-terrain-sample-evidence-incomplete'};
  return {...sample,available:true};
}

export function officialTerrainAgl(sample,telemetry={}) {
  const terrain=verifiedOfficialSample(sample);
  if(!terrain.available)return {...terrain,groundElevationM:null,estimatedAglM:null};
  // GLOBAL_POSITION_INT.alt is explicitly MSL. GPS/ellipsoid and barometric
  // fallbacks are excluded because the official service supplies no transform.
  if(telemetry.ready!==true||!Number.isFinite(telemetry.globalAltitudeM))return {available:false,reason:'fresh-global-msl-altitude-required',groundElevationM:null,estimatedAglM:null};
  return {available:true,groundElevationM:terrain.heightM,estimatedAglM:telemetry.globalAltitudeM-terrain.heightM,
    provider:terrain.provider,generation:terrain.generation,spacingM:terrain.spacingM,datum:terrain.datum,datumEvidence:terrain.datumEvidence};
}

export async function readOfficialSamples(client,points,signal) {
  if(!client?.samples)return points.map(()=>({available:false,reason:'official-terrain-client-unavailable'}));
  const output=[];
  for(let index=0;index<points.length;index+=MAX_BATCH){
    if(signal?.aborted)throw new DOMException('Terrain sampling cancelled','AbortError');
    const batch=points.slice(index,index+MAX_BATCH),response=await client.samples(batch,signal);
    if(!Array.isArray(response?.samples)||response.samples.length!==batch.length){output.push(...batch.map(()=>({available:false,reason:'official-terrain-response-mismatch'})));continue}
    output.push(...response.samples.map(verifiedOfficialSample));
  }
  if(signal?.aborted)throw new DOMException('Terrain sampling cancelled','AbortError');
  return output;
}

export const officialTerrainContract=Object.freeze({provider:PROVIDER,datum:DATUM,spacingM:SPACING,maxBatch:MAX_BATCH});
