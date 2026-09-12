// SPDX-License-Identifier: GPL-3.0-or-later
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {afterEach,describe,expect,it} from 'vitest';
import {acquireOfficialTile} from './provider.js';

const RAW_BYTES=25_934_402;
const roots:string[]=[];

afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

async function staging():Promise<string>{
 const path=await mkdtemp(join(tmpdir(),'yonder-provider-'));roots.push(path);return path;
}

function crc32(bytes:Uint8Array):number{
 let crc=0xffffffff;
 for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}

interface Entry {name:string;raw:Buffer;method?:number;flags?:number;crc?:number;declaredRawBytes?:number;}
function archive(entries:Entry[]):Buffer{
 const locals:Buffer[]=[];const centrals:Buffer[]=[];let offset=0;
 for(const entry of entries){
  const method=entry.method??8,flags=entry.flags??0,name=Buffer.from(entry.name);
  const packed=method===8?deflateRawSync(entry.raw):Buffer.from(entry.raw);
  const checksum=entry.crc??crc32(entry.raw),rawBytes=entry.declaredRawBytes??entry.raw.length;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(rawBytes,22);local.writeUInt16LE(name.length,26);
  locals.push(local,name,packed);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(0x031e,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(rawBytes,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  centrals.push(central,name);offset+=local.length+name.length+packed.length;
 }
 const centralBytes=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,centralBytes,end]);
}

function rawTile(fill=0x2d):Buffer{return Buffer.alloc(RAW_BYTES,fill);}
function response(bytes:Uint8Array,status=200,headers?:HeadersInit):Response{return new Response(bytes,{status,headers});}

describe('acquireOfficialTile',()=>{
 it('streams, verifies and fsyncs the one canonical HGT member while removing ZIP staging',async()=>{
  const directory=await staging(),raw=rawTile(),zip=archive([{name:'N35W084.hgt',raw}]);
  const admissions:number[]=[];let requested='';
  const result=await acquireOfficialTile('N35W084',{stagingDirectory:directory,admit:async bytes=>{admissions.push(bytes);},fetch:async(input,init)=>{
   requested=String(input);expect(init?.redirect).toBe('manual');return response(zip);
  }});

  expect(requested).toBe('https://terrain.ardupilot.org/SRTM1/N35W084.hgt.zip');
  expect(result.tile).toBe('N35W084');
  expect(result.sourceUrl).toBe(requested);
  expect(result.bytes).toBe(RAW_BYTES);
  expect(result.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  expect(result.archiveSha256).toBe(createHash('sha256').update(zip).digest('hex'));
  expect(Number.isFinite(Date.parse(result.retrievedAt))).toBe(true);
  expect(createHash('sha256').update(await readFile(result.path)).digest('hex')).toBe(result.sha256);
  expect((await readdir(directory)).filter(name=>name.endsWith('.zip'))).toEqual([]);
  expect(admissions.length).toBeGreaterThan(1);
  expect(admissions.every(bytes=>Number.isSafeInteger(bytes)&&bytes>0)).toBe(true);
  expect(admissions.reduce((sum,bytes)=>sum+bytes,0)).toBe(zip.length+raw.length);
 });

 it('accepts an uncompressed canonical member',async()=>{
  const directory=await staging(),raw=rawTile(0);
  const result=await acquireOfficialTile('S01E002',{stagingDirectory:directory,fetch:async()=>response(archive([{name:'S01E002.hgt',raw,method:0}]))});
  expect((await readFile(result.path)).length).toBe(RAW_BYTES);
 });

 it.each(['N35W84','S00W084','N35W000','N90E000','N35W084.hgt','https://evil.invalid/file.zip','../N35W084'])('rejects noncanonical tile key %s before fetching',async tile=>{
  let fetched=false;
  await expect(acquireOfficialTile(tile,{stagingDirectory:await staging(),fetch:async()=>{fetched=true;throw new Error('must not fetch');}})).rejects.toThrow(/canonical|bounds/i);
  expect(fetched).toBe(false);
 });

 it.each([
  ['an extra member',()=>archive([{name:'N35W084.hgt',raw:rawTile()},{name:'extra',raw:Buffer.from('x')}])],
  ['a traversal member',()=>archive([{name:'../N35W084.hgt',raw:rawTile()}])],
  ['an encrypted member',()=>archive([{name:'N35W084.hgt',raw:rawTile(),flags:1}])],
  ['unsupported compression',()=>archive([{name:'N35W084.hgt',raw:rawTile(),method:12}])],
  ['a declared decompression bomb',()=>archive([{name:'N35W084.hgt',raw:Buffer.alloc(1),declaredRawBytes:RAW_BYTES}])],
  ['a CRC mismatch',()=>archive([{name:'N35W084.hgt',raw:rawTile(),crc:0}])],
 ])('rejects %s and leaves no staging files',async(_reason,make)=>{
  const directory=await staging();
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:directory,fetch:async()=>response(make())})).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
 });

 it('rejects truncated archives and inconsistent local/central metadata',async()=>{
  const valid=archive([{name:'N35W084.hgt',raw:rawTile()}]);
  for(const bytes of [valid.subarray(0,valid.length-10),(()=>{const copy=Buffer.from(valid);copy.writeUInt16LE(0,8);return copy;})()]){
   const directory=await staging();
   await expect(acquireOfficialTile('N35W084',{stagingDirectory:directory,fetch:async()=>response(bytes)})).rejects.toThrow(/ZIP|archive|metadata|compression/i);
   expect(await readdir(directory)).toEqual([]);
  }
 });

 it('cleans all owned staging after cancellation during a write',async()=>{
  const directory=await staging(),controller=new AbortController(),zip=archive([{name:'N35W084.hgt',raw:rawTile()}]);let calls=0;
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:directory,signal:controller.signal,fetch:async()=>response(zip),admit:async()=>{if(++calls===2)controller.abort();}})).rejects.toMatchObject({name:'AbortError'});
  expect(await readdir(directory)).toEqual([]);
 });

 it('retries only transient responses twice, honors bounded Retry-After through the injected delay, and then succeeds',async()=>{
  const directory=await staging(),zip=archive([{name:'N35W084.hgt',raw:rawTile()}]);let attempts=0;const delays:number[]=[];
  const result=await acquireOfficialTile('N35W084',{stagingDirectory:directory,delay:async(ms)=>{delays.push(ms);},fetch:async()=>{
   attempts++;return attempts<3?new Response(null,{status:503,headers:{'Retry-After':'1'}}):response(zip);
  }});
  expect(result.bytes).toBe(RAW_BYTES);expect(attempts).toBe(3);expect(delays).toEqual([1000,1000]);
 });

 it('does not retry format rejection or a fourth transient response',async()=>{
  const bad=archive([{name:'N35W084.hgt',raw:Buffer.from('bad')}]);let malformedAttempts=0;
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:await staging(),delay:async()=>{},fetch:async()=>{malformedAttempts++;return response(bad);}})).rejects.toThrow();
  expect(malformedAttempts).toBe(1);
  let transientAttempts=0;
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:await staging(),delay:async()=>{},fetch:async()=>{transientAttempts++;return new Response(null,{status:503});}})).rejects.toThrow(/503/);
  expect(transientAttempts).toBe(3);
 });

 it('rejects a declared archive over 64 MiB without retrying or creating staging',async()=>{
  const directory=await staging();let attempts=0;
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:directory,fetch:async()=>{attempts++;return new Response(null,{status:200,headers:{'Content-Length':String(64*1024*1024+1)}});}})).rejects.toThrow(/64 MiB/);
  expect(attempts).toBe(1);expect(await readdir(directory)).toEqual([]);
 });

 it('follows only a bounded same-origin redirect chain',async()=>{
  const directory=await staging(),zip=archive([{name:'N35W084.hgt',raw:rawTile()}]);const urls:string[]=[];
  await acquireOfficialTile('N35W084',{stagingDirectory:directory,fetch:async input=>{
   const url=String(input);urls.push(url);return urls.length===1?new Response(null,{status:302,headers:{location:'/SRTM1/mirror/N35W084.hgt.zip'}}):response(zip);
  }});
  expect(urls).toEqual(['https://terrain.ardupilot.org/SRTM1/N35W084.hgt.zip','https://terrain.ardupilot.org/SRTM1/mirror/N35W084.hgt.zip']);
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:await staging(),fetch:async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid/tile.zip'}})})).rejects.toThrow(/same origin/i);
 });
});

it('rejects ZIP symlink and directory attributes even with a valid terrain payload',async()=>{
 const raw=rawTile(),valid=archive([{name:'N35W084.hgt',raw}]);
 const central=valid.readUInt32LE(valid.length-22+16);
 for(const attributes of [(0o120777<<16)>>>0,(0o040755<<16)>>>0,0x10]) {
  const mutated=Buffer.from(valid);mutated.writeUInt32LE(attributes,central+38);
  const directory=await staging();
  await expect(acquireOfficialTile('N35W084',{stagingDirectory:directory,fetch:async()=>response(mutated)})).rejects.toThrow('regular file');
  expect(await readdir(directory)).toEqual([]);
 }
});
