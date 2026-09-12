// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerrainRuntime} from './runtime.js';
import {DEFAULT_CONFIG} from '../../schema/config.js';
import {VehicleService} from '../../mav/vehicle.js';
import {systemClock} from '../../apply/types.js';
import {minimal, MavLinkProtocolV2} from 'node-mavlink';
const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true}))); });
async function setup(persistent = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'terrain-runtime-'))); roots.push(root);
  const sent: Uint8Array[] = [], vehicle = new VehicleService({clock:systemClock,send:async bytes=>{sent.push(bytes);}});
  const runtime = new TerrainRuntime({root,vehicle,clock:systemClock,send:async bytes=>{sent.push(bytes);},routerGeneration:()=> 'router-one',serialBaud:()=>57600,
    probe:async()=>({persistent,writable:persistent,freeBytes:8*1024**3,filesystem:'test',reason:persistent?null:'persistent-storage-unverified'})});
  cleanups.push(async()=>{await runtime.close();vehicle.close();});
  const heartbeat=new MavLinkProtocolV2(1,1).serialize(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1,baseMode:1}),0);
  vehicle.receive(heartbeat);runtime.receive(heartbeat);
  return {root,runtime,sent,vehicle};
}
describe('terrain daemon runtime lifecycle',()=>{
  it('defaults disabled, emits nothing on reads, and rolls policy back without losing telemetry',async()=>{
    const {runtime,sent,vehicle}=await setup();
    await runtime.render(DEFAULT_CONFIG);
    expect((await runtime.status()).policy.enabled).toBe(false);
    expect(sent).toHaveLength(0);
    await runtime.render({...DEFAULT_CONFIG,terrain:{...DEFAULT_CONFIG.terrain,enabled:true}});await runtime.ready();
    expect((await runtime.status()).preparationAllowed).toBe(true);
    await runtime.render(DEFAULT_CONFIG);
    expect((await runtime.status()).preparationAllowed).toBe(false);
    expect(vehicle.snapshot().connected).toBe(true);expect(sent).toHaveLength(0);
  });
  it('reports unavailable storage without throwing through configuration apply',async()=>{
    const {runtime,sent}=await setup(false);
    await expect(runtime.render({...DEFAULT_CONFIG,terrain:{...DEFAULT_CONFIG.terrain,enabled:true}})).resolves.toBeUndefined();
    await runtime.ready();expect((await runtime.status()).failure).toContain('persistent-storage-unverified');expect(sent).toHaveLength(0);
  });
  it('refuses corrupt metadata while preserving daemon responsiveness',async()=>{
    const {runtime,root,vehicle}=await setup();await writeFile(join(root,'index.json'),'invalid json');
    await runtime.render({...DEFAULT_CONFIG,terrain:{...DEFAULT_CONFIG.terrain,enabled:true}});await runtime.ready();
    expect((await runtime.status()).failure).toBeTruthy();expect(vehicle.snapshot().connected).toBe(true);
  });
});
