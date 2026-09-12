// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createOfficialTerrainClient,TerrainServiceError} from './official-terrain-client.mjs';
afterEach(()=>vi.useRealTimers());
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

describe('official terrain cockpit client',()=>{
  it('uses only fixed cockpit terrain routes and server-owned session context',async()=>{
    const fetchFn=vi.fn(async()=>json({ok:true})),client=createOfficialTerrainClient({fetchFn});
    await client.preview({kind:'mission',name:'Route',bufferM:500,refreshSource:true,sessionId:'browser-must-not-own-this',mission:{items:[]}});
    await client.pin('area-1',true);await client.refreshController('vehicle-2');
    expect(fetchFn.mock.calls.map(call=>call[0])).toEqual(['/cockpit/api/terrain-service/preview','/cockpit/api/terrain-service/pin','/cockpit/api/terrain-service/refresh-controller']);
    const bodies=fetchFn.mock.calls.map(call=>JSON.parse(call[1].body));
    expect(bodies[0]).toEqual({kind:'mission',name:'Route',bufferM:500,refreshSource:true});
    expect(bodies.every(body=>!('sessionId' in body))).toBe(true);
    expect(fetchFn.mock.calls[0][1].headers).toMatchObject({'content-type':'application/json','x-yonder-cockpit':'1'});
  });
  it('uses the terrain-only reviewed policy apply, confirm and revert endpoints',async()=>{
    const fetchFn=vi.fn(async()=>json({id:'apply-1',expiresAt:1234})),client=createOfficialTerrainClient({fetchFn});
    const revision='a'.repeat(64);await client.applyPolicy({enabled:true,provider:'anything-ignored',quotaMiB:4096},revision);await client.confirmPolicy('apply-1');await client.revertPolicy('apply-2');
    expect(fetchFn.mock.calls.map(call=>call[0])).toEqual(['/cockpit/api/terrain-service/policy/apply','/cockpit/api/terrain-service/policy/confirm','/cockpit/api/terrain-service/policy/revert']);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:4096},expectedRevision:revision});
  });
  it('polls immediately and slowly, then stops without an aircraft refresh',async()=>{
    vi.useFakeTimers();const fetchFn=vi.fn(async()=>json({policy:{enabled:false}})),next=vi.fn();
    const client=createOfficialTerrainClient({fetchFn,pollMs:2000});client.start(next);await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);expect(fetchFn.mock.calls[0][0]).toBe('/cockpit/api/terrain-service');
    await vi.advanceTimersByTimeAsync(1999);expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(fetchFn).toHaveBeenCalledTimes(2);
    client.stop();await vi.advanceTimersByTimeAsync(4000);expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.some(call=>String(call[0]).includes('refresh-controller'))).toBe(false);
  });
  it('preserves backend capacity and stale-revision errors',async()=>{
    const client=createOfficialTerrainClient({fetchFn:async()=>json({error:'quota capacity is insufficient for this preview'},409)});
    await expect(client.prepare('preview-1')).rejects.toMatchObject<TerrainServiceError>({status:409,message:'quota capacity is insufficient for this preview'});
  });
});
