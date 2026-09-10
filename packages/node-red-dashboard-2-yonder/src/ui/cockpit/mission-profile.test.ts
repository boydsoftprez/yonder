// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {planRoute,buildMissionProfile,plannedAltitude} from './mission-profile.mjs';
const item=(seq,lat,lon,alt=100,frame=3,command=16)=>({seq,lat,lon,alt,frame,command,params:[0,0,0,0]});
const mission={home:{lat:35,lon:-84,alt:200},items:[item(1,35,-84),item(2,35.01,-84)]};
it('resolves planned MSL and AGL without conflating home and terrain',()=>{
 expect(plannedAltitude(mission.items[1],mission.home,{groundM:250,surfaceM:270},true)).toMatchObject({altitudeM:300,aglM:50,clearanceM:30});
 expect(plannedAltitude({...mission.items[1],frame:10},mission.home,{groundM:250,surfaceM:270},true)).toMatchObject({altitudeM:350,aglM:100,clearanceM:80});
 expect(plannedAltitude(mission.items[1],mission.home,{groundM:250,surfaceM:270},false).aglM).toBe(null);
});
it('keeps unavailable surface data and missing datum separate from terrain clearance',()=>{
 expect(plannedAltitude(mission.items[1],mission.home,{groundM:250,surfaceM:null},true)).toMatchObject({aglM:50,clearanceM:null});
 expect(plannedAltitude({...mission.items[1],alt:NaN},mission.home,{groundM:250,surfaceM:270},true).altitudeM).toBe(null);
});
it('breaks profiles at jumps and loiters instead of depicting a fictitious flown line',()=>{
 const route=planRoute({...mission,items:[mission.items[0],item(2,0,0,0,2,177),mission.items[1]]});
 expect(route.legs).toHaveLength(0);expect(route.limitations.join(' ')).toMatch(/jump/i);
 const loop=planRoute({...mission,items:[mission.items[0],item(2,35.01,-84,100,3,17),item(3,35.02,-84)]});
 expect(loop.legs).toHaveLength(0);
});
it('samples a bounded plan, interpolates altitude and exposes known obstruction clearance',()=>{
 const route=planRoute({...mission,items:[item(1,35,-84,100),item(2,35.01,-84,200)]});
 const p=buildMissionProfile(route,mission.home,()=>({groundM:250,surfaceM:320}),true,32);
 expect(p.samples.length).toBeLessThanOrEqual(32);expect(p.waypoints[1]).toMatchObject({altitudeM:400,aglM:150,clearanceM:80});
 expect(p.samples[0].clearanceM).toBe(-20);expect(p.samples.at(-1).altitudeM).toBe(400);
});
