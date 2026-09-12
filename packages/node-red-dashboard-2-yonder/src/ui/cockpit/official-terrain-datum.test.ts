// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {officialTerrainAgl,readOfficialSamples,verifiedOfficialSample} from './official-terrain-datum.mjs';
const valid={available:true,heightM:123.5,provider:'ardupilot-srtm1',generation:'g1',spacingM:30,datum:'MSL',datumEvidence:'Official sample evidence'};
it('computes AGL only from verified official MSL and fresh GLOBAL_POSITION_INT altitude',()=>{
 expect(officialTerrainAgl(valid,{ready:true,globalAltitudeM:200})).toMatchObject({available:true,groundElevationM:123.5,estimatedAglM:76.5,datum:'MSL'});
 expect(officialTerrainAgl(valid,{ready:true,gpsAltitudeM:200})).toMatchObject({available:false,reason:'fresh-global-msl-altitude-required'});
});
it('rejects unknown providers, datum claims and incomplete generation evidence',()=>{
 expect(verifiedOfficialSample({...valid,provider:'display-pack'})).toMatchObject({available:false,reason:'official-terrain-source-unverified'});
 expect(verifiedOfficialSample({...valid,datum:'EGM96'})).toMatchObject({available:false,reason:'official-terrain-datum-unverified'});
 expect(verifiedOfficialSample({...valid,generation:''})).toMatchObject({available:false,reason:'official-terrain-sample-evidence-incomplete'});
});
it('keeps every request at 128 points and reports malformed response gaps',async()=>{
 const client={samples:vi.fn(async points=>({samples:points.length===2?[valid]:points.map(()=>valid)}))},points=Array.from({length:130},(_,i)=>({lat:35+i/10000,lon:-84}));const samples=await readOfficialSamples(client,points);
 expect(client.samples.mock.calls.map(call=>call[0].length)).toEqual([128,2]);expect(samples).toHaveLength(130);expect(samples.at(-1)).toMatchObject({available:false,reason:'official-terrain-response-mismatch'});
});
