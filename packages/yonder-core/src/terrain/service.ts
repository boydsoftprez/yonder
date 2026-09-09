// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {validateTerrainManifest,decodeTerrainTile} from './pack.js';
import {sampleTerrain} from './sample.js';
import type {TerrainManifest,TerrainTileDescriptor} from './types.js';
const unzip=promisify(gunzip);
async function readBounded(path:string,limit:number):Promise<Uint8Array>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const stat=await file.stat();if(!stat.isFile() || stat.size>limit)throw new Error('Terrain file exceeds limit');
  const out=Buffer.alloc(stat.size);let offset=0;
  while(offset<out.length){const result=await file.read(out,offset,out.length-offset,offset);if(!result.bytesRead)throw new Error('Terrain file truncated');offset+=result.bytesRead;}
  if((await file.stat()).size!==stat.size)throw new Error('Terrain file changed while reading');return out;
 }finally{await file.close();}
}
/** Authenticated HTTP adapters serve these bytes; this class never fetches remote URLs. */
export class TerrainPackService {
 readonly manifest:TerrainManifest;
 private cache=new Map<string,Uint8Array>();private pending=new Map<string,Promise<Uint8Array>>();
 private active=0;private waiters:Array<()=>void>=[];private used=0;
 get cacheBytes():number{return this.used;}
 private constructor(private directory:string,manifest:TerrainManifest,private maxCacheBytes:number){this.manifest=manifest;}
 static async open(directory:string,options:{maxCacheBytes?:number}={}):Promise<TerrainPackService>{
  const root=await realpath(directory),raw=await readBounded(join(root,'manifest.json'),4*1024*1024);
  const manifest=validateTerrainManifest(JSON.parse(new TextDecoder().decode(raw)));
  const cache=options.maxCacheBytes??16*1024*1024;
  if(!Number.isSafeInteger(cache) || cache<0 || cache>128*1024*1024)throw new Error('Invalid terrain cache limit');
  return new TerrainPackService(root,manifest,cache);
 }
 async sampleAt(eastingM:number,northingM:number):Promise<{groundM:number|null;surfaceM:number|null;datum:TerrainManifest['verticalDatum'];transformVerified:boolean;spacingM:number|null}> {
  const result={groundM:null as number|null,surfaceM:null as number|null,datum:this.manifest.verticalDatum,transformVerified:this.manifest.verticalTransform.verified,spacingM:null as number|null};
  if(![eastingM,northingM].every(Number.isFinite))return result;
  // Clearance queries never substitute a coarse visual maximum for a native sample.
  const candidates=this.manifest.tiles.filter(t=>t.level===0 && eastingM>=t.originEastingM && eastingM<=t.originEastingM+(t.columns-1)*t.spacingM && northingM<=t.originNorthingM && northingM>=t.originNorthingM-(t.rows-1)*t.spacingM).slice(0,4);
  for(const descriptor of candidates){const sampled=sampleTerrain(decodeTerrainTile(await this.getTile(descriptor.id),descriptor),eastingM,northingM);if(result.groundM===null)result.groundM=sampled.groundM;if(result.surfaceM===null)result.surfaceM=sampled.surfaceM;if(sampled.groundM!==null||sampled.surfaceM!==null)result.spacingM=Math.max(result.spacingM??0,descriptor.spacingM);}
  return result;
 }
 clearCache():void{this.cache.clear();this.used=0;}
 async getTile(id:string):Promise<Uint8Array>{
  const descriptor=this.manifest.tiles.find(t=>t.id===id);if(!descriptor)throw new Error('Unknown terrain tile');
  const cached=this.cache.get(id);if(cached){this.cache.delete(id);this.cache.set(id,cached);return cached.slice();}
  const existing=this.pending.get(id);if(existing)return (await existing).slice();
  if(this.pending.size>=64)throw new Error('Terrain request queue full');
  const request=this.readTile(descriptor);this.pending.set(id,request);
  try {return (await request).slice();}finally{this.pending.delete(id);}
 }
 private async readTile(t:TerrainTileDescriptor):Promise<Uint8Array>{
  if(this.active>=4)await new Promise<void>(resolve=>this.waiters.push(resolve));
  this.active++;
  try {
   const packed=await readBounded(join(this.directory,t.file),t.bytes);
   if(packed.byteLength!==t.bytes || createHash('sha256').update(packed).digest('hex')!==t.sha256)throw new Error('Terrain tile checksum mismatch');
   const raw=t.file.endsWith('.gz')?new Uint8Array(await unzip(packed,{maxOutputLength:t.decodedBytes})):packed;
   decodeTerrainTile(raw,t);
   if(raw.byteLength<=this.maxCacheBytes){while(this.used+raw.byteLength>this.maxCacheBytes){const key=this.cache.keys().next().value;if(key===undefined)break;this.used-=this.cache.get(key)!.byteLength;this.cache.delete(key);}this.cache.set(t.id,raw);this.used+=raw.byteLength;}
   return raw;
  }finally{this.active--;this.waiters.shift()?.();}
 }
}
