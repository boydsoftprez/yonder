// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {buildTerrainMesh} from './mesh.js';
import {decodeTerrainTile} from './pack.js';
import type {TerrainTileDescriptor} from './types.js';
it('renders native one-metre samples east/up/south without triangulating missing cells',()=>{
 const d:TerrainTileDescriptor={id:'t',file:'t.bin',sha256:'0'.repeat(64),bytes:32,decodedBytes:32,columns:2,rows:2,spacingM:1,originEastingM:500000,originNorthingM:4000000,level:0,groundCoverage:1,surfaceCoverage:1,minGroundM:100,maxSurfaceM:120};
 const tile=decodeTerrainTile(new Uint8Array(new Float32Array([100,101,102,103,110,111,112,113]).buffer),d);
 const mesh=buildTerrainMesh(tile,{eastingM:500000,northingM:4000000,heightM:100},'surface');
 expect([...mesh.positions]).toEqual([0,10,0,1,11,0,0,12,1,1,13,1]);expect(mesh.indices.length).toBe(6);
 tile.surfaceM[0]=NaN; expect(buildTerrainMesh(tile,{eastingM:500000,northingM:4000000,heightM:100},'surface').indices.length).toBe(0);
});
