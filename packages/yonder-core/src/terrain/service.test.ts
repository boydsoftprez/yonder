// SPDX-License-Identifier: GPL-3.0-or-later
import { it,expect } from 'vitest';
import { mkdtemp,writeFile,rm,symlink } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {TerrainPackService} from './service.js';
it('serves only checksummed, bounded manifest files and detects corrupt/traversing data',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yonder-terrain-'));
 try {
 const raw=Buffer.alloc(32),packed=gzipSync(raw); const sha256=createHash('sha256').update(packed).digest('hex');
 const tile={id:'l0-0-0',file:'l0-0-0.bin.gz',sha256,bytes:packed.length,decodedBytes:32,level:0,columns:2,rows:2,spacingM:1,originEastingM:100,originNorthingM:200,groundCoverage:1,surfaceCoverage:1,minGroundM:0,maxSurfaceM:0};
 const manifest={schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'NAVD88',verticalTransform:{verified:false,description:'Native',grids:[]},surfaceDescription:'Test',sourceResolutionM:1,sources:[],tiles:[tile],limitations:['Test']};
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(dir,tile.file),packed);
 const service=await TerrainPackService.open(dir,{maxCacheBytes:32});
 expect(service.manifest.id).toBe('test');expect(await service.getTile(tile.id)).toEqual(new Uint8Array(raw));expect(service.cacheBytes).toBe(32);
 await expect(service.getTile('../secret')).rejects.toThrow('Unknown');
 service.clearCache(); await writeFile(join(dir,tile.file),Buffer.alloc(packed.length));await expect(service.getTile(tile.id)).rejects.toThrow('checksum');
 await rm(join(dir,tile.file));await writeFile(join(dir,'external.bin'),packed);await symlink(join(dir,'external.bin'),join(dir,tile.file));await expect(service.getTile(tile.id)).rejects.toThrow();
 }finally {await rm(dir,{recursive:true,force:true});}
});
it('samples only the finest measured grid and returns unavailable outside coverage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yonder-terrain-sample-'));
 try {
 const raw=Buffer.from(new Float32Array([10,20,30,40,50,60,70,80]).buffer),packed=gzipSync(raw);
 const tile={id:'t',file:'t.bin.gz',sha256:createHash('sha256').update(packed).digest('hex'),bytes:packed.length,decodedBytes:32,level:0,columns:2,rows:2,spacingM:4,originEastingM:100,originNorthingM:200,groundCoverage:1,surfaceCoverage:1,minGroundM:10,maxSurfaceM:80};
 const manifest={schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Test fixture',grids:[]},surfaceDescription:'Test',sourceResolutionM:1,sources:[],tiles:[tile],limitations:['Test']};
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(dir,tile.file),packed);
 const service=await TerrainPackService.open(dir);
 expect(await service.sampleAt(102,198)).toMatchObject({groundM:25,surfaceM:65,datum:'EGM96',transformVerified:true,spacingM:4});
 expect(await service.sampleAt(99,201)).toMatchObject({groundM:null,surfaceM:null,spacingM:null});
 }finally{await rm(dir,{recursive:true,force:true});}
});
