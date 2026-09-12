// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it, vi} from 'vitest';
import {officialTerrainRoute} from './routes.js';
import type {TerrainRuntime} from './runtime.js';
describe('strict official terrain routes', () => {
  it('refuses browser-supplied mission contents and arbitrary source paths', async () => {
    const preview = vi.fn(); const runtime = {preview} as unknown as TerrainRuntime;
    for (const body of [
      {sessionId:'s',kind:'mission',name:'Route',bufferM:100,mission:{items:[]}},
      {sessionId:'s',kind:'manual',name:'Area',bufferM:100,bounds:{south:35,north:36,west:-84,east:-83},sourceUrl:'https://foreign.example'},
      {kind:'mission',name:'Route',bufferM:100},
    ]) expect((await officialTerrainRoute(runtime,'POST','/cockpit/terrain-service/preview',body))?.status).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });
  it('bounds sample batches and enforces route methods', async () => {
    const runtime = {samples:vi.fn()} as unknown as TerrainRuntime;
    expect((await officialTerrainRoute(runtime,'POST','/cockpit/terrain-service/samples',
      {sessionId:'s',points:Array(129).fill({lat:35,lon:-83})}))?.status).toBe(400);
    expect((await officialTerrainRoute(runtime,'GET','/cockpit/terrain-service/prepare',{}))?.status).toBe(405);
    expect((await officialTerrainRoute(undefined,'GET','/cockpit/terrain-service',undefined))?.status).toBe(503);
  });
});
