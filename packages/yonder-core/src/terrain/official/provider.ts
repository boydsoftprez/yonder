// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/R-STO-01/03/05/06: bounded official terrain acquisition staging.
import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {open,realpath,stat,unlink,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {createInflateRaw} from 'node:zlib';

const SOURCE_ORIGIN='https://terrain.ardupilot.org';
const HGT_TILE_BYTES=25_934_402;
const MAX_ARCHIVE_BYTES=64*1024*1024;
const MAX_ZIP_METADATA_BYTES=1024*1024;
const MAX_REDIRECTS=3;
const MAX_RETRIES=2;
const REQUEST_TIMEOUT_MS=30_000;
const MAX_RETRY_DELAY_MS=30_000;

export interface OfficialTileAcquisition {
 readonly path:string;
 readonly tile:string;
 readonly sha256:string;
 readonly archiveSha256:string;
 readonly bytes:number;
 readonly sourceUrl:string;
 readonly retrievedAt:string;
}

export interface AcquireOfficialTileOptions {
 readonly stagingDirectory:string;
 readonly signal?:AbortSignal;
 readonly fetch?:typeof globalThis.fetch;
 /**
  * Called with each incremental byte count immediately before that ZIP or HGT
  * chunk is written. The caller rechecks quota/free space for that increment;
  * values are deltas, never a cumulative total.
  */
 readonly admit?:(additionalBytes:number)=>Promise<void>;
 /** Injected only to make bounded Retry-After/backoff tests deterministic. */
 readonly delay?:(milliseconds:number,signal:AbortSignal)=>Promise<void>;
}

interface ZipMember {
 readonly dataOffset:number;
 readonly compressedBytes:number;
 readonly crc32:number;
 readonly compression:0|8;
}

class ArchiveError extends Error {}
class FetchFailure extends Error {constructor(message:string,readonly cause?:unknown){super(message);}}
class HttpFailure extends Error {
 constructor(readonly status:number,readonly retryAfter:string|null){super(`Official terrain source returned HTTP ${status}`);}
 get transient():boolean{return [408,425,429,500,502,503,504].includes(this.status);}
}

/** Downloads and verifies one fixed-origin official SRTM1 tile into caller-owned staging. */
export async function acquireOfficialTile(tile:string,options:AcquireOfficialTileOptions):Promise<OfficialTileAcquisition>{
 validateCanonicalTile(tile);
 if(typeof options!=='object'||options===null||typeof options.stagingDirectory!=='string'||options.stagingDirectory.length===0)throw new TypeError('Official terrain staging directory is required');
 const directory=await realpath(options.stagingDirectory),directoryStat=await stat(directory);
 if(!directoryStat.isDirectory())throw new Error('Official terrain staging path is not a directory');
 const fetcher=options.fetch??globalThis.fetch;
 if(typeof fetcher!=='function')throw new TypeError('Official terrain fetch implementation is required');
 const admit=options.admit??(async()=>{}),delay=options.delay??abortableDelay;
 const sourceUrl=`${SOURCE_ORIGIN}/SRTM1/${tile}.hgt.zip`;

 for(let attempt=0;attempt<=MAX_RETRIES;attempt++){
  throwIfAborted(options.signal);
  const zipPath=join(directory,`.${tile}.${randomUUID()}.hgt.zip`);
  let zip:FileHandle|undefined,rawPath:string|undefined;
  try{
   const fetched=await fetchWithRedirects(sourceUrl,fetcher,options.signal);
   if(!fetched.response.ok){await cancelBody(fetched.response);throw new HttpFailure(fetched.response.status,fetched.response.headers.get('retry-after'));}
   zip=await open(zipPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
   const archiveSha256=await downloadArchive(fetched.response,zip,admit,options.signal);
   await zip.close();zip=undefined;
   const member=await inspectArchive(zipPath,tile);
   rawPath=join(directory,`.${tile}.${randomUUID()}.hgt`);
   const sha256=await extractMember(zipPath,rawPath,member,admit,options.signal);
   await unlink(zipPath);
   return {path:rawPath,tile,sha256,archiveSha256,bytes:HGT_TILE_BYTES,sourceUrl,retrievedAt:new Date().toISOString()};
  }catch(error){
   await zip?.close().catch(()=>{});
   await unlink(zipPath).catch(ignoreMissing);
   if(rawPath!==undefined)await unlink(rawPath).catch(ignoreMissing);
   if(options.signal?.aborted)throw abortReason(options.signal);
   const retryable=(error instanceof FetchFailure)||(error instanceof HttpFailure&&error.transient);
   if(!retryable||attempt===MAX_RETRIES)throw error;
   const wait=error instanceof HttpFailure?retryDelay(error.retryAfter,attempt):backoff(attempt);
   const signal=options.signal??new AbortController().signal;
   await delay(wait,signal);throwIfAborted(options.signal);
  }
 }
 throw new Error('Official terrain acquisition retry state is invalid');
}

async function fetchWithRedirects(initialUrl:string,fetcher:typeof globalThis.fetch,signal?:AbortSignal):Promise<{response:Response;url:string}>{
 let current=initialUrl;
 for(let redirects=0;;redirects++){
  const response=await timedFetch(fetcher,current,signal);
  if(![301,302,303,307,308].includes(response.status))return {response,url:current};
  const location=response.headers.get('location');await cancelBody(response);
  if(location===null)throw new ArchiveError('Official terrain redirect has no location');
  let next:URL;
  try{next=new URL(location,current);}catch{throw new ArchiveError('Official terrain redirect URL is invalid');}
  if(next.origin!==SOURCE_ORIGIN)throw new ArchiveError('Official terrain redirects must stay on the fixed same origin');
  if(next.username||next.password)throw new ArchiveError('Official terrain redirect credentials are forbidden');
  if(redirects>=MAX_REDIRECTS)throw new ArchiveError('Official terrain redirect limit exceeded');
  current=next.href;
 }
}

async function timedFetch(fetcher:typeof globalThis.fetch,url:string,outer?:AbortSignal):Promise<Response>{
 throwIfAborted(outer);
 const controller=new AbortController();
 const forward=()=>controller.abort(abortReason(outer!));
 outer?.addEventListener('abort',forward,{once:true});
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;controller.abort(new DOMException('Official terrain request timed out','TimeoutError'));},REQUEST_TIMEOUT_MS);
 try{
  return await fetcher(url,{method:'GET',redirect:'manual',signal:controller.signal,headers:{accept:'application/zip'}});
 }catch(error){
  if(outer?.aborted)throw abortReason(outer);
  if(timedOut)throw new FetchFailure('Official terrain request timed out',error);
  throw new FetchFailure('Official terrain request failed',error);
 }finally{clearTimeout(timer);outer?.removeEventListener('abort',forward);}
}

async function downloadArchive(response:Response,file:FileHandle,admit:(bytes:number)=>Promise<void>,signal?:AbortSignal):Promise<string>{
 const declared=parseContentLength(response.headers.get('content-length'));
 if(declared!==null&&declared>MAX_ARCHIVE_BYTES){await cancelBody(response);throw new ArchiveError('Official terrain ZIP exceeds the 64 MiB compressed limit');}
 if(response.body===null)throw new FetchFailure('Official terrain response has no body');
 const reader=response.body.getReader(),hash=createHash('sha256');let total=0,complete=false;
 try{
  while(true){
   throwIfAborted(signal);
   const item=await readDownloadChunk(reader,signal);
   if(item.done){complete=true;break;}
   const chunk=item.value;
   if(!(chunk instanceof Uint8Array)||chunk.byteLength===0)continue;
   if(total+chunk.byteLength>MAX_ARCHIVE_BYTES)throw new ArchiveError('Official terrain ZIP exceeds the 64 MiB compressed limit');
   await admit(chunk.byteLength);throwIfAborted(signal);
   await writeFully(file,chunk,total);total+=chunk.byteLength;hash.update(chunk);
  }
 }finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(total===0)throw new ArchiveError('Official terrain ZIP is empty');
 if(declared!==null&&declared!==total)throw new FetchFailure('Official terrain response was truncated');
 return hash.digest('hex');
}

async function readDownloadChunk(reader:ReadableStreamDefaultReader<Uint8Array>,signal?:AbortSignal):Promise<ReadableStreamReadResult<Uint8Array>>{
 throwIfAborted(signal);
 let timer:ReturnType<typeof setTimeout>|undefined,abort: (()=>void)|undefined;
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new FetchFailure('Official terrain download stream timed out')),REQUEST_TIMEOUT_MS);});
 const cancelled=new Promise<never>((_resolve,reject)=>{if(signal!==undefined){abort=()=>reject(abortReason(signal));signal.addEventListener('abort',abort,{once:true});}});
 try{return await Promise.race([reader.read().catch(error=>{throw new FetchFailure('Official terrain download stream failed',error);}),timeout,cancelled]);}
 finally{if(timer!==undefined)clearTimeout(timer);if(abort!==undefined)signal?.removeEventListener('abort',abort);}
}

async function inspectArchive(path:string,tile:string):Promise<ZipMember>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const size=(await file.stat()).size;
  if(size<22||size>MAX_ARCHIVE_BYTES)throw new ArchiveError('Invalid official terrain ZIP size');
  const tailBytes=Math.min(size,65_557),tail=await readExact(file,tailBytes,size-tailBytes);
  let eocd=-1;
  for(let offset=tail.length-22;offset>=0;offset--)if(tail.readUInt32LE(offset)===0x06054b50&&offset+22+tail.readUInt16LE(offset+20)===tail.length){eocd=offset;break;}
  if(eocd<0)throw new ArchiveError('Official terrain ZIP end record is missing or truncated');
  const endOffset=size-tailBytes+eocd;
  if(tail.readUInt16LE(eocd+4)!==0||tail.readUInt16LE(eocd+6)!==0||tail.readUInt16LE(eocd+8)!==1||tail.readUInt16LE(eocd+10)!==1)throw new ArchiveError('Official terrain ZIP must contain exactly one member on one disk');
  const centralSize=tail.readUInt32LE(eocd+12),centralOffset=tail.readUInt32LE(eocd+16);
  if(centralSize===0xffffffff||centralOffset===0xffffffff)throw new ArchiveError('ZIP64 official terrain archives are unsupported');
  if(centralSize<46||centralSize>MAX_ZIP_METADATA_BYTES||centralOffset+centralSize!==endOffset)throw new ArchiveError('Official terrain ZIP central directory is invalid');
  const central=await readExact(file,centralSize,centralOffset);
  if(central.readUInt32LE(0)!==0x02014b50)throw new ArchiveError('Official terrain ZIP central member header is invalid');
  const host=central.readUInt16LE(4)>>>8,attributes=central.readUInt32LE(38),unixType=(attributes>>>16)&0xf000;
  if((attributes&0x10)!==0||(host===3&&unixType!==0&&unixType!==0x8000)) throw new ArchiveError('Official terrain ZIP member must be a regular file');
  const nameLength=central.readUInt16LE(28),extraLength=central.readUInt16LE(30),commentLength=central.readUInt16LE(32);
  if(46+nameLength+extraLength+commentLength!==central.length)throw new ArchiveError('Official terrain ZIP has extra or truncated central metadata');
  const flags=central.readUInt16LE(8),method=central.readUInt16LE(10),checksum=central.readUInt32LE(16),compressed=central.readUInt32LE(20),raw=central.readUInt32LE(24),localOffset=central.readUInt32LE(42);
  rejectZip64(central.subarray(46+nameLength,46+nameLength+extraLength),compressed,raw,localOffset);
  validateMember(tile,central.subarray(46,46+nameLength),flags,method,compressed,raw);
  if(central.readUInt16LE(34)!==0||localOffset!==0)throw new ArchiveError('Official terrain ZIP member offset/disk is unsupported');
  const local=await readExact(file,30,localOffset);
  if(local.readUInt32LE(0)!==0x04034b50)throw new ArchiveError('Official terrain ZIP local member header is invalid');
  const localNameLength=local.readUInt16LE(26),localExtraLength=local.readUInt16LE(28),localHeader=await readExact(file,30+localNameLength+localExtraLength,localOffset);
  const localName=localHeader.subarray(30,30+localNameLength),localExtra=localHeader.subarray(30+localNameLength);
  rejectZip64(localExtra,local.readUInt32LE(18),local.readUInt32LE(22),0);
  if(!localName.equals(central.subarray(46,46+nameLength))||local.readUInt16LE(6)!==flags||local.readUInt16LE(8)!==method||local.readUInt16LE(10)!==central.readUInt16LE(12)||local.readUInt16LE(12)!==central.readUInt16LE(14))throw new ArchiveError('Official terrain ZIP local and central metadata disagree');
  const dataOffset=localOffset+localHeader.length,dataEnd=dataOffset+compressed;
  if(flags&0x0008){
   const descriptorBytes=centralOffset-dataEnd;
   if(descriptorBytes!==12&&descriptorBytes!==16)throw new ArchiveError('Official terrain ZIP data descriptor is invalid');
   const descriptor=await readExact(file,descriptorBytes,dataEnd),base=descriptorBytes===16?4:0;
   if(descriptorBytes===16&&descriptor.readUInt32LE(0)!==0x08074b50)throw new ArchiveError('Official terrain ZIP data descriptor signature is invalid');
   if(local.readUInt32LE(14)!==0||local.readUInt32LE(18)!==0||local.readUInt32LE(22)!==0||descriptor.readUInt32LE(base)!==checksum||descriptor.readUInt32LE(base+4)!==compressed||descriptor.readUInt32LE(base+8)!==raw)throw new ArchiveError('Official terrain ZIP descriptor and central metadata disagree');
  }else{
   if(dataEnd!==centralOffset||local.readUInt32LE(14)!==checksum||local.readUInt32LE(18)!==compressed||local.readUInt32LE(22)!==raw)throw new ArchiveError('Official terrain ZIP local and central sizes/CRC disagree');
  }
  return {dataOffset,compressedBytes:compressed,crc32:checksum,compression:method as 0|8};
 }finally{await file.close();}
}

function validateMember(tile:string,name:Buffer,flags:number,method:number,compressed:number,raw:number):void{
 if(name.toString('utf8')!==`${tile}.hgt`)throw new ArchiveError('Official terrain ZIP member must have the canonical tile name');
 if((flags&0x0001)||(flags&0x0040)||(flags&0x2000))throw new ArchiveError('Encrypted official terrain ZIP members are forbidden');
 if(method!==0&&method!==8)throw new ArchiveError('Official terrain ZIP compression method is unsupported');
 if(raw!==HGT_TILE_BYTES)throw new ArchiveError(`Official terrain HGT member must be exactly ${HGT_TILE_BYTES} bytes`);
 if(compressed>MAX_ARCHIVE_BYTES||compressed===0)throw new ArchiveError('Official terrain ZIP member compressed size is invalid');
}

function rejectZip64(extra:Buffer,compressed:number,raw:number,offset:number):void{
 if(compressed===0xffffffff||raw===0xffffffff||offset===0xffffffff)throw new ArchiveError('ZIP64 official terrain archives are unsupported');
 for(let cursor=0;cursor<extra.length;){
  if(cursor+4>extra.length)throw new ArchiveError('Official terrain ZIP extra field is truncated');
  const id=extra.readUInt16LE(cursor),length=extra.readUInt16LE(cursor+2);cursor+=4;
  if(cursor+length>extra.length)throw new ArchiveError('Official terrain ZIP extra field is truncated');
  if(id===0x0001)throw new ArchiveError('ZIP64 official terrain archives are unsupported');
  if(id===0x9901)throw new ArchiveError('Encrypted official terrain ZIP members are forbidden');
  cursor+=length;
 }
}

async function extractMember(zipPath:string,rawPath:string,member:ZipMember,admit:(bytes:number)=>Promise<void>,signal?:AbortSignal):Promise<string>{
 let output:FileHandle|undefined;
 try{
  output=await open(rawPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
  const source=createReadStream(zipPath,{start:member.dataOffset,end:member.dataOffset+member.compressedBytes-1});
  const decoded=member.compression===8?source.pipe(createInflateRaw()):source;
  const hash=createHash('sha256');let bytes=0,checksum=0xffffffff;
  try{
   for await(const value of decoded){
    throwIfAborted(signal);const chunk=Buffer.isBuffer(value)?value:Buffer.from(value as Uint8Array);
    if(bytes+chunk.byteLength>HGT_TILE_BYTES)throw new ArchiveError('Official terrain HGT decompression exceeds the exact raw size');
    await admit(chunk.byteLength);throwIfAborted(signal);
    await writeFully(output,chunk,bytes);bytes+=chunk.byteLength;hash.update(chunk);checksum=updateCrc32(checksum,chunk);
   }
  }finally{source.destroy();if(decoded!==source)decoded.destroy();}
  if(bytes!==HGT_TILE_BYTES)throw new ArchiveError(`Official terrain HGT decompressed length must be exactly ${HGT_TILE_BYTES}`);
  if(((checksum^0xffffffff)>>>0)!==member.crc32)throw new ArchiveError('Official terrain HGT ZIP CRC check failed');
  await output.sync();await output.close();output=undefined;
  return hash.digest('hex');
 }catch(error){await output?.close().catch(()=>{});await unlink(rawPath).catch(ignoreMissing);if(signal?.aborted)throw abortReason(signal);throw error;}
}

const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);table[n]=c>>>0;}return table;})();
function updateCrc32(crc:number,bytes:Uint8Array):number{for(const byte of bytes)crc=(crc>>>8)^CRC_TABLE[(crc^byte)&0xff];return crc>>>0;}

async function readExact(file:FileHandle,length:number,position:number):Promise<Buffer>{
 const out=Buffer.alloc(length);let read=0;
 while(read<length){const item=await file.read(out,read,length-read,position+read);if(item.bytesRead===0)throw new ArchiveError('Official terrain ZIP is truncated');read+=item.bytesRead;}
 return out;
}

async function writeFully(file:FileHandle,bytes:Uint8Array,position:number):Promise<void>{
 let written=0;while(written<bytes.byteLength){const item=await file.write(bytes,written,bytes.byteLength-written,position+written);if(item.bytesWritten===0)throw new Error('Official terrain staging write made no progress');written+=item.bytesWritten;}
}

function validateCanonicalTile(tile:unknown):asserts tile is string{
 if(typeof tile!=='string')throw new TypeError('Official terrain tile key must be a string');
 const match=/^([NS])(\d{2})([EW])(\d{3})$/.exec(tile);
 if(match===null)throw new RangeError('Official terrain tile key must use canonical N35W084 form');
 const lat=Number(match[2]),lon=Number(match[4]);
 if((lat===0&&match[1]!=='N')||(lon===0&&match[3]!=='E'))throw new RangeError('Official terrain tile key must use canonical N00/E000 zero directions');
 const south=match[1]==='N'?lat:-lat,west=match[3]==='E'?lon:-lon;
 if(south < -90||south>89||west < -180||west>179)throw new RangeError('Official terrain tile key is outside geographic bounds');
}

function parseContentLength(value:string|null):number|null{
 if(value===null)return null;if(!/^\d+$/.test(value))throw new ArchiveError('Official terrain Content-Length is invalid');
 const parsed=Number(value);if(!Number.isSafeInteger(parsed))throw new ArchiveError('Official terrain Content-Length is invalid');return parsed;
}

function retryDelay(value:string|null,attempt:number):number{
 if(value!==null){
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.min(MAX_RETRY_DELAY_MS,Math.ceil(seconds*1000));
  const date=Date.parse(value);if(Number.isFinite(date))return Math.min(MAX_RETRY_DELAY_MS,Math.max(0,date-Date.now()));
 }
 return backoff(attempt);
}
function backoff(attempt:number):number{return Math.min(MAX_RETRY_DELAY_MS,250*(2**attempt));}
function abortableDelay(milliseconds:number,signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.reject(abortReason(signal));
 return new Promise((resolve,reject)=>{const timer=setTimeout(done,milliseconds);function done(){signal.removeEventListener('abort',aborted);resolve();}function aborted(){clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(abortReason(signal));}signal.addEventListener('abort',aborted,{once:true});});
}
function throwIfAborted(signal?:AbortSignal):void{if(signal?.aborted)throw abortReason(signal);}
function abortReason(signal:AbortSignal):Error{return signal.reason instanceof Error?signal.reason:new DOMException('The operation was aborted','AbortError');}
async function cancelBody(response:Response):Promise<void>{await response.body?.cancel().catch(()=>{});}
function ignoreMissing(error:unknown):void{if(!(error&&typeof error==='object'&&'code' in error&&(error as {code?:unknown}).code==='ENOENT'))throw error;}
