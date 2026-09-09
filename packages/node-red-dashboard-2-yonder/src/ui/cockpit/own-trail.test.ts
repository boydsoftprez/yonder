// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it} from 'vitest';
import {selectOwnTrail,trailPreferences,createOwnTrailClient} from './own-trail.mjs';
const points=Array.from({length:6},(_,i)=>[i+1,i*60000,35+i*.001,-83,i*1000,1]);
const summary={epoch:'one',revision:0,latest:6,bootMs:300000,startBootMs:0,gaps:0,simplified:false,truncated:false,tail:points.at(-1)};
it('windows distance along the travelled path in either miles or nautical miles',()=>{
  const trail={...summary,points};
  expect(selectOwnTrail(trail,{mode:'distance',distance:1,unit:'mi'}).segments.flat()).toHaveLength(2);
  expect(selectOwnTrail(trail,{mode:'distance',distance:2,unit:'nm'}).segments.flat()).toHaveLength(4);
});
it('windows elapsed time and retains all observed points for since-power-on',()=>{
  const trail={...summary,points};
  expect(selectOwnTrail(trail,{mode:'time',minutes:2}).segments.flat()).toHaveLength(3);
  expect(selectOwnTrail(trail,{mode:'power'}).segments.flat()).toHaveLength(6);
  expect(selectOwnTrail({...trail,bootMs:600000},{mode:'time',minutes:2}).segments).toEqual([]);
});
it('never connects telemetry segments or across the dateline and clears only this browser display',()=>{
  const trail={...summary,points:points.map((p,i)=>[...p.slice(0,5),i<3?1:2])};
  expect(selectOwnTrail(trail,{mode:'power'}).segments.map(s=>s.length)).toEqual([3,3]);
  expect(selectOwnTrail(trail,{mode:'power'},{epoch:'one',after:4}).segments.flat()).toHaveLength(2);
  expect(selectOwnTrail(trail,{mode:'power'},{epoch:'old',after:99}).segments.flat()).toHaveLength(6);
  expect(selectOwnTrail({...summary,points:[[1,0,1,179,0,1],[2,1000,1,-179,1,1]]},{mode:'power'}).segments).toHaveLength(2);
});
it('bounds settings and hides only depiction when disabled',()=>{
  expect(trailPreferences({distance:Infinity,minutes:-1,mode:'oops',unit:'x'})).toMatchObject({mode:'time',distance:5,minutes:10,unit:'nm'});
  expect(selectOwnTrail({...summary,points},{enabled:false}).segments).toEqual([]);
});
it('recovers missing history without blocking telemetry and accepts contiguous live deltas',async()=>{
  let finish:(v:unknown)=>void;const calls:string[]=[];
  const client=createOwnTrailClient(async path=>{calls.push(path);return new Promise(resolve=>{finish=resolve})});
  client.observe(summary);expect(client.view().points).toEqual([]);
  finish!({...summary,points,next:6,more:false});await new Promise(r=>setTimeout(r,0));
  expect(client.view().points).toHaveLength(6);
  client.observe({...summary,latest:7,tail:[7,301000,35.1,-83,5100,1]});
  expect(client.view().points).toHaveLength(7);expect(calls).toHaveLength(1);client.close();
});
it('rejects an old boot history response arriving after a replacement aircraft',async()=>{
  let finish:(v:unknown)=>void;
  const client=createOwnTrailClient(async()=>new Promise(resolve=>{finish=resolve}));
  client.observe(summary);client.observe({...summary,epoch:'two',latest:1,tail:[1,1000,1,2,0,1]});
  finish!({...summary,points,next:6,more:false});await new Promise(r=>setTimeout(r,0));
  expect(client.view().epoch).toBe('two');expect(client.view().points).toEqual([[1,1000,1,2,0,1]]);client.close();
});
it('requests only the selected history window and does not backfill while depiction is off',async()=>{
  const calls:string[]=[];const client=createOwnTrailClient(async path=>{calls.push(path);return {...summary,points:[],next:6,more:false}});
  client.configure({enabled:false});client.observe({...summary,bootMs:1200000});expect(calls).toEqual([]);
  client.configure({mode:'time',minutes:2});client.observe({...summary,bootMs:1200000});
  expect(calls[0]).toBe('/cockpit/api/trail/one/0/1080000/0');await new Promise(r=>setTimeout(r,0));
  client.configure({mode:'power'});client.observe(summary);expect(calls[1]).toBe('/cockpit/api/trail/one/0/0/0');client.close();
});
it('ages a time window through a telemetry outage without extending its last received point',()=>{
  const trail={...summary,clockAt:1000,points};
  expect(selectOwnTrail(trail,{mode:'time',minutes:2},null,181000).segments).toEqual([]);
});
it('invalidates rendered geometry as stationary history recovery progresses',()=>{
  const empty=selectOwnTrail({...summary,points:[],loading:true},{mode:'power'});
  const recovered=selectOwnTrail({...summary,points,loading:false},{mode:'power'});
  expect(recovered.key).not.toBe(empty.key);
});
