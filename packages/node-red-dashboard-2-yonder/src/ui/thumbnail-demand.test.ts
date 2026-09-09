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
