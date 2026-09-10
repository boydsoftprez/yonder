// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ThumbnailDemand } from './thumbnail-demand.js';
const settle = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
describe('visible thumbnail demand', () => {
  it('requests active and other thumbnails without changing selected video delivery, then releases all on close', async () => {
    const calls:any[]=[]; const fetcher=vi.fn(async (url, options:any)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true};});
    const demand=new ThumbnailDemand(fetcher as any);
    demand.set([{id:'one',want:'video'},{id:'two',want:'off'}]); await settle();
    expect(calls).toEqual([{url:'/video/one/report',body:{want:'video',stills:true}},{url:'/video/two/report',body:{want:'off',stills:true}}]);
    demand.close();await settle(); expect(calls.slice(2).map(c=>c.body)).toEqual([{want:'off',stills:false},{want:'off',stills:false}]);
  });
  it('has one request in flight per camera and releases a late demand after teardown', async () => {
    let resolve!:()=>void; const calls:any[]=[];
    const fetcher=vi.fn((_url, options:any)=>{const body=JSON.parse(options.body);calls.push(body);return body.stills?new Promise(done=>{resolve=()=>done({ok:true});}):Promise.resolve({ok:true});});
    const demand=new ThumbnailDemand(fetcher as any);demand.set([{id:'one',want:'video'}]);demand.refresh();demand.refresh();demand.close();
    expect(calls).toHaveLength(1);resolve();await settle();expect(calls).toEqual([{want:'video',stills:true},{want:'off',stills:false}]);
  });
});


it('delivers selected display state without requiring a WebRTC stats session', async () => {
  const state={camera:'one',viewer:'viewer-1',at:100,overlay:{head:'Stills'}};
  const got=vi.fn();
  const demand=new ThumbnailDemand(vi.fn(async()=>({ok:true,json:async()=>state})) as any,got);
  demand.set([{id:'one',want:'stills'}]);await settle();
  expect(got).toHaveBeenCalledWith(state);
  demand.close();await settle();expect(got).toHaveBeenCalledTimes(1);
});

it('rejects late responses after selection changes or closes, and mismatched camera replies', async () => {
  for (const retire of ['switch','close','mismatch']) {
    let finish!:(value:unknown)=>void;const got=vi.fn();
    const fetcher=vi.fn(async()=>({ok:true,json:()=>new Promise(resolve=>{finish=resolve})}));
    const demand=new ThumbnailDemand(fetcher as any,got);
    demand.set([{id:'one',want:'stills'}]);await settle();
    if(retire==='switch')demand.set([{id:'one',want:'off'}]);
    if(retire==='close')demand.close();
    finish({camera:retire==='mismatch'?'another':'one',viewer:'v1',at:100,overlay:{head:'Stills'}});
    await settle();expect(got).not.toHaveBeenCalled();demand.close();
  }
});
