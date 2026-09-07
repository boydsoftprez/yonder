// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {validateTrafficOptions,visibleTracks,trailSegments,projectTrafficPoint,trafficOwnship,trafficHealth,layoutTrafficLabels} from './traffic-state.mjs';
const now=100000,point={id:'abc123',lat:.01,lon:0,altitudeMslM:1000,observedAtMs:now,ground:false,history:[]};
const own={lat:0,lon:0,altitudeMslM:1000,heading:0,pitch:0,roll:0};
test('traffic options preserve explicit false and reject unsupported bounds',()=>{
 const p=validateTrafficOptions({enabled:false,radiusNm:10000,trailSeconds:-1,pfd:false});assert.equal(p.enabled,false);assert.equal(p.pfd,false);assert.equal(p.radiusNm,10);assert.equal(p.trailSeconds,120);
});
// Meridional destinations on the mean-radius sphere: one NM = 1852 m.
const atNm=(nm,extra={})=>({...point,lat:nm*1852/6371008.8*180/Math.PI,...extra});
test('default depiction shows nearby aircraft and excludes distant airline traffic',()=>{
 assert.deepEqual(visibleTracks([atNm(9.9,{id:'near'}),atNm(10.1,{id:'outside'}),atNm(86.9,{id:'distant-airline'})],validateTrafficOptions(),now,own).map(t=>t.id),['near']);
});
test('every supported range applies the geodesic boundary in nautical miles',()=>{
 for(const radiusNm of [1,2,5,10,25,50,100]){
  const options=validateTrafficOptions({radiusNm});
  const tracks=[atNm(radiusNm+.001,{id:'outside'}),atNm(radiusNm-.001,{id:'inside'}),atNm(.2,{id:'nearest'})];
  assert.deepEqual(visibleTracks(tracks,options,now,own).map(t=>t.id),['nearest','inside'],radiusNm+' NM boundary');
 }
 assert.equal(visibleTracks([atNm(25)],validateTrafficOptions({radiusNm:25}),now,own).length,1,'A target exactly on the boundary is included');
});
test('range filtering handles antimeridian, polar longitude, ownship movement and missing position',()=>{
 const options=validateTrafficOptions({radiusNm:1});
 assert.equal(visibleTracks([{...point,lat:0,lon:-179.999}],options,now,{lat:0,lon:179.999}).length,1);
 assert.equal(visibleTracks([{...point,lat:89.999,lon:90}],options,now,{lat:89.999,lon:0}).length,1);
 assert.equal(visibleTracks([point],options,now,own).length,1);
 assert.equal(visibleTracks([point],options,now,{...own,lat:.04}).length,0);
 for(const center of [null,undefined,{lat:null,lon:0},{lat:91,lon:0},{lat:0,lon:NaN}])assert.deepEqual(visibleTracks([point],options,now,center),[],'Without a usable position traffic must stay hidden');
});
test('real observations become stale and expire even without another HTTP update',()=>{
 const options=validateTrafficOptions({});assert.equal(visibleTracks([point],options,now+14999,own).length,1);assert.equal(visibleTracks([point],options,now+16000,own)[0].stale,true);assert.equal(visibleTracks([point],options,now+60001,own).length,0);
 assert.equal(visibleTracks([{...point,lat:null}],options,now,own).length,0);assert.equal(visibleTracks([{...point,ground:true}],options,now,own).length,0);
});
test('breadcrumbs split at gaps or source breaks and respect chosen age window',()=>{
 const p=t=>({...point,observedAtMs:t});const history=[p(1000),p(2000),p(40000),p(41000),{...p(42000),breakBefore:true},p(43000)];
 assert.deepEqual(trailSegments(history,44000,120).map(s=>s.length),[2,2,2]);assert.deepEqual(trailSegments(history,44000,5).map(s=>s.length),[2,2]);
});
test('breadcrumbs stop at the display boundary and cannot reconnect across outside observations',()=>{
 const history=[.3,.4,1.01,.5,.6].map((nm,i)=>atNm(nm,{id:String(i),observedAtMs:now-5000+i*1000}));
 assert.deepEqual(trailSegments(history,now,120,own,1).map(segment=>segment.map(p=>p.id)),[['0','1'],['3','4']]);
 assert.deepEqual(trailSegments(history,now,120,null,1),[],'No breadcrumb depiction without valid ownship');
});
test('perspective matches horizon and clips targets behind or without known MSL',()=>{
 const at=projectTrafficPoint(point,own);assert.ok(Math.abs(at.x-320)<.01);assert.ok(Math.abs(at.y-225)<.1);
 assert.equal(projectTrafficPoint({...point,lat:-.01},own),null);assert.equal(projectTrafficPoint({...point,altitudeMslM:null,altitudeBaroFt:3300},own),null);
 assert.ok(projectTrafficPoint({...point,altitudeMslM:1100},own).y<at.y);
 assert.ok(projectTrafficPoint({...point,lon:.005},own).x>at.x);
 assert.ok(projectTrafficPoint(point,{...own,pitch:10}).y>at.y);
});
test('distant aircraft projection accounts for earth curvature instead of flat-earth altitude',()=>{
 const at=projectTrafficPoint({...point,lat:1},own);assert.ok(at.y>227,'Equal-MSL target beyond100km lies below tangent horizon');
});
test('ownship requires current attitude and GPS and uses MSL not relative height',()=>{
 const f={live:true,attitudeValid:true,heading:0,pitch:0,roll:0,altitude:4000};const t={ready:true,fixType:3,latitude:35,longitude:-83,altitudeDatum:'EGM96',gpsAltitudeM:400,relativeAltitudeM:100};
 assert.equal(trafficOwnship(f,t).altitudeMslM,400);assert.equal(trafficOwnship({...f,live:false},t),null);assert.equal(trafficOwnship(f,{...t,fixType:1}),null);
});
test('feed health does not present old snapshots as live',()=>{
 assert.equal(trafficHealth({status:'live',receivedAtMs:now,sourceAtMs:now},now).state,'live');
 assert.equal(trafficHealth({status:'live',receivedAtMs:now,sourceAtMs:now},now+20000).state,'stale');
 assert.equal(trafficHealth({status:'error',message:'Rate limited'},now).state,'error');
});
test('PFD labels stay clear of tapes, aircraft reference and each other, with selection priority',()=>{
 const items=Array.from({length:20},(_,i)=>({track:{id:String(i),callSign:'TEST'+i},point:{x:290+i*2,y:150+i*2,relativeAltitudeFt:1000}}));
 const result=layoutTrafficLabels(items,true,'19'),boxes=result.filter(i=>i.labelBox).map(i=>i.labelBox);
 assert.ok(result.find(i=>i.track.id==='19').labelBox,'Selected target gets first label placement');
 assert.ok(boxes.length>0&&boxes.length<=6);
 for(const b of boxes){assert.ok(b.left>=128&&b.right<=494&&b.top>=84&&b.bottom<=360);for(const a of boxes)if(a!==b)assert.ok(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);}
 assert.equal(layoutTrafficLabels(items,false,null).filter(i=>i.labelBox).length,0);
});
