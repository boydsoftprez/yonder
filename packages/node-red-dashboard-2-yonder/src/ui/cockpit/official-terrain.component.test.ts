// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import OfficialTerrainPanel from './OfficialTerrainPanel.vue';

const wrappers:any[]=[];afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.useRealTimers()});
const status={policy:{enabled:true,quotaMiB:512},preparationAllowed:true,limits:{bufferMinM:50,bufferMaxM:10000},source:{dataset:'Official ArduPilot ALOS-derived SRTM1',spacingM:30,datum:'MSL',ownership:'Operator-managed single responder; exclusivity is not enforced'},storage:{usedBytes:0,quotaBytes:512*1024*1024,storage:{freeBytes:2*1024*1024*1024,persistent:true},areas:[]},coverage:{areas:[],job:null},service:{enabled:true,compatible:true,sent:4,missing:0,controller:{fresh:true,report:{pending:1,loaded:2,spacing:30}},providerOwnership:{exclusivityEnforced:false,directRouteVisibility:'unverified'}},controllerRefresh:{state:'idle'}};
const preview={id:'preview-1',expiresAt:'2026-09-11T12:00:00Z',coverage:{name:'Flight area',tiles:['N35W084'],estimatedBytes:90000000,complete:true,reasons:[],revision:'abcdef1234567890',geometry:{rectangles:[{south:35,north:36,west:-84,east:-83}],polylines:[{kind:'route-leg',points:[{lat:35.1,lon:-83.9},{lat:35.8,lon:-83.2}]}]}}};
function host(overrides={}){const client={status:vi.fn(async()=>status),policy:vi.fn(async()=>({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:512},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null})),applyPolicy:vi.fn(async()=>({id:'apply-1',expiresAt:Date.now()+90000})),confirmPolicy:vi.fn(async()=>({state:'confirmed'})),revertPolicy:vi.fn(async()=>({state:'confirmed'})),preview:vi.fn(async()=>preview),prepare:vi.fn(async()=>({id:'job-1'})),cancel:vi.fn(),pin:vi.fn(),remove:vi.fn(),refreshController:vi.fn(),...overrides};const w=mount(OfficialTerrainPanel,{props:{status,client,mapBounds:{south:35.2,north:35.8,west:-84.2,east:-83.8},missionAvailable:true,missionRevision:'mission-7',vehicleGeneration:'vehicle-4'}});wrappers.push(w);return{w,client}}

it('previews editable current-map bounds with explicit source refresh and renders server geometry',async()=>{
  const {w,client}=host();await w.get('input[aria-label="Refresh source tiles"]').setValue(true);
  await w.findAll('button').find(b=>b.text()==='Preview area')!.trigger('click');await flushPromises();
  expect(client.preview).toHaveBeenCalledWith({kind:'manual',name:'Flight area',bufferM:1000,refreshSource:true,bounds:{south:35.2,north:35.8,west:-84.2,east:-83.8}});
  expect(w.emitted('preview')?.at(-1)?.[0]).toEqual(preview);
  await w.setProps({preview});expect(w.find('svg[aria-label="Server calculated terrain coverage geometry"]').exists()).toBe(true);
  expect(w.text()).toContain('1 tiles');expect(w.text()).toMatch(/sent.*not proof.*loaded/i);
});

it('derives mission coverage server-side and runs explicit prepare and controller refresh actions',async()=>{
  const {w,client}=host();const buttons=()=>w.findAll('button');
  await buttons().find(b=>b.text()==='Current aircraft mission')!.trigger('click');
  await buttons().find(b=>b.text()==='Preview area')!.trigger('click');await flushPromises();
  expect(client.preview).toHaveBeenCalledWith({kind:'mission',name:'Flight area',bufferM:1000,refreshSource:false});
  await w.setProps({preview});await buttons().find(b=>b.text()==='Prepare 1 tiles')!.trigger('click');await flushPromises();
  await buttons().find(b=>b.text()==='Refresh controller terrain')!.trigger('click');await flushPromises();
  expect(client.prepare).toHaveBeenCalledWith('preview-1');expect(client.refreshController).toHaveBeenCalledWith('vehicle-4');
});

it('invalidates edited preview inputs and ignores a late response for the old inputs',async()=>{
  let resolveOld:any;const oldRequest=new Promise(resolve=>{resolveOld=resolve});
  const previewRequest=vi.fn().mockImplementationOnce(()=>oldRequest).mockResolvedValue(preview);
  const {w}=host({preview:previewRequest});const button=()=>w.findAll('button').find(b=>b.text().startsWith('Prepare'))!;
  await w.findAll('button').find(b=>b.text()==='Preview area')!.trigger('click');await w.get('input[aria-label="Official terrain area name"]').setValue('Edited while loading');
  resolveOld(preview);await flushPromises();
  expect(w.emitted('preview')?.some(([value])=>value===preview)).toBe(false);expect(button().attributes('disabled')).toBeDefined();
  await w.findAll('button').find(b=>b.text()==='Preview area')!.trigger('click');await flushPromises();await w.setProps({preview});
  expect(button().attributes('disabled')).toBeUndefined();
  await w.get('input[aria-label="Official terrain buffer metres"]').setValue('1500');await w.vm.$nextTick();
  expect(button().attributes('disabled')).toBeDefined();expect(w.emitted('preview')?.at(-1)?.[0]).toBeNull();
});

it('cancels an active job and pins or deletes prepared areas by server id',async()=>{
  const {w,client}=host();
  await w.setProps({status:{...status,coverage:{job:{id:'job-9',state:'preparing',completed:1,total:3},areas:[{id:'area-2',name:'Route',revision:'savedrevision1234',complete:false,pinned:false,objects:['N35W084'],reasons:['official source tile contains nodata samples'],coverage:{bufferM:1000,geometry:{rectangles:[{south:35,north:36,west:-84,east:-83}],polylines:[]}}}]}}});
  const click=async text=>{await w.findAll('button').find(b=>b.text()===text)!.trigger('click');await flushPromises()};
  await click('Show coverage');expect(w.text()).toContain('saved on Yonder');expect(w.find('svg').exists()).toBe(true);
  await click('Cancel preparation');await click('Pin');await click('Delete');
  expect(client.cancel).toHaveBeenCalledWith('job-9');expect(client.pin).toHaveBeenCalledWith('area-2',true);expect(client.remove).toHaveBeenCalledWith('area-2');
  expect(w.text()).toMatch(/Partial.*nodata/i);
});

it('shows default-disabled policy and exact capacity errors',async()=>{
  const {w}=host({preview:vi.fn(async()=>{throw new Error('quota capacity is insufficient')})});
  await w.setProps({status:{...status,policy:{enabled:false}}});expect(w.text()).toMatch(/disabled by default/i);expect(w.get('button[aria-pressed="true"]').text()).toBe('Current map area');
  await w.setProps({status});await w.findAll('button').find(b=>b.text()==='Preview area')!.trigger('click');await flushPromises();expect(w.get('[role="alert"]').text()).toContain('quota capacity is insufficient');
});

it('reviews the terrain-only policy before apply and offers confirm or revert',async()=>{
  const document=(pendingId=null)=>({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:512},revision:'a'.repeat(64),apply:{state:pendingId?'pending':'idle'},pendingId});
  const policy=vi.fn().mockResolvedValueOnce(document()).mockResolvedValueOnce(document('apply-1')).mockResolvedValueOnce(document()).mockResolvedValueOnce(document('apply-2')).mockResolvedValueOnce(document());
  const {w,client}=host({policy});await flushPromises();
  await w.get('input[aria-label="Official terrain quota MiB"]').setValue('1024');
  await w.findAll('button').find(b=>b.text()==='Review policy change')!.trigger('click');expect(w.text()).toContain('512 MiB → 1024 MiB');
  await w.findAll('button').find(b=>b.text()==='Apply reviewed policy')!.trigger('click');await flushPromises();
  expect(client.applyPolicy).toHaveBeenCalledWith({enabled:true,provider:'ardupilot-srtm1',quotaMiB:1024},'a'.repeat(64));expect(w.text()).toContain('awaiting confirmation');
  await w.findAll('button').find(b=>b.text()==='Confirm and keep')!.trigger('click');await flushPromises();expect(client.confirmPolicy).toHaveBeenCalledWith('apply-1');
  client.applyPolicy.mockResolvedValueOnce({id:'apply-2',expiresAt:Date.now()+90000});
  await w.findAll('button').find(b=>b.text()==='Review policy change')!.trigger('click');await w.findAll('button').find(b=>b.text()==='Apply reviewed policy')!.trigger('click');await flushPromises();
  await w.findAll('button').find(b=>b.text()==='Revert now')!.trigger('click');await flushPromises();expect(client.revertPolicy).toHaveBeenCalledWith('apply-2');
});

it('shows stale policy revisions and reloads the current policy before another review',async()=>{
  const policy=vi.fn().mockResolvedValueOnce({policy:{enabled:false,provider:'ardupilot-srtm1',quotaMiB:512},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null}).mockResolvedValue({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:2048},revision:'b'.repeat(64),apply:{state:'idle'},pendingId:null});
  const {w}=host({policy,applyPolicy:vi.fn(async()=>{throw new Error('terrain policy changed; review the current revision')})});await flushPromises();
  await w.findAll('button').find(b=>b.text()==='Review policy change')!.trigger('click');await w.findAll('button').find(b=>b.text()==='Apply reviewed policy')!.trigger('click');await flushPromises();
  expect(w.get('[role="alert"]').text()).toContain('changed; review');expect(policy).toHaveBeenCalledTimes(2);expect(w.get('input[aria-label="Official terrain quota MiB"]').element.value).toBe('2048');
});

it('rechecks an expired confirmation window and removes a terminal pending banner',async()=>{
  vi.useFakeTimers();vi.setSystemTime(1000);const document=(pendingId=null)=>({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:512},revision:'a'.repeat(64),apply:{state:pendingId?'pending':'idle'},pendingId});
  const policy=vi.fn().mockResolvedValueOnce(document()).mockResolvedValueOnce(document('apply-expiring')).mockResolvedValueOnce(document());
  const {w}=host({policy,applyPolicy:vi.fn(async()=>({id:'apply-expiring',expiresAt:1100}))});await flushPromises();await w.findAll('button').find(b=>b.text()==='Review policy change')!.trigger('click');await w.findAll('button').find(b=>b.text()==='Apply reviewed policy')!.trigger('click');await flushPromises();expect(w.text()).toContain('awaiting confirmation');
  await vi.advanceTimersByTimeAsync(351);await flushPromises();expect(w.text()).not.toContain('awaiting confirmation');expect(policy).toHaveBeenCalledTimes(3);
});
