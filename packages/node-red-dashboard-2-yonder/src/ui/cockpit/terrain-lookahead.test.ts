// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {latLonToUtm} from 'yonder-core/terrain';
import {terrainLookaheadTiles} from './terrain-lookahead.mjs';
const pose={lat:35.96,lon:-83.36},p=latLonToUtm(pose.lat,pose.lon,17);
const tiles=Array.from({length:100},(_,i)=>({id:String(i),level:0,spacingM:1,columns:129,rows:129,originEastingM:p.eastingM+(i%10-2)*128,originNorthingM:p.northingM+(Math.floor(i/10)-4)*128}));
const manifest={horizontalCrs:{zone:17},tiles};
it('warms only bounded native tiles ahead of measured ground motion and skips cached data',()=>{
 const east=terrainLookaheadTiles(manifest,pose,{groundspeedMps:20,trackDeg:90});
 expect(east.length).toBeGreaterThan(0);expect(east.length).toBeLessThanOrEqual(16);
 expect(east.every(t=>t.originEastingM>p.eastingM-128)).toBe(true);
 const held=new Set(east.map(t=>t.id));expect(terrainLookaheadTiles(manifest,pose,{groundspeedMps:20,trackDeg:90},t=>held.has(t.id)).every(t=>!held.has(t.id))).toBe(true);
 expect(terrainLookaheadTiles(manifest,pose,{groundspeedMps:1000,trackDeg:0}).length).toBeLessThanOrEqual(16);
});
it('does not prefetch for missing/stationary telemetry or manufacture coverage',()=>{
 for(const motion of [{},{groundspeedMps:0,trackDeg:90},{groundspeedMps:20,trackDeg:NaN}])expect(terrainLookaheadTiles(manifest,pose,motion)).toEqual([]);
 expect(terrainLookaheadTiles({...manifest,tiles:[]},pose,{groundspeedMps:20,trackDeg:90})).toEqual([]);
});
