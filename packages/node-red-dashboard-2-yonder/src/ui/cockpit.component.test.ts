// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
const componentPath = './YonderCockpit.vue';
const component = await import(/* @vite-ignore */ componentPath).catch(() => null);
const report = { vehicleGeneration: 1, telemetry: { ready: true, rollDeg: 0, pitchDeg: 0, headingDeg: 90, airspeedKt: 42, altitudeFt: 1336, verticalSpeedFpm: 500, groundspeedKt: 44, mode: 'GUIDED', latitude: 35, longitude: -84 }, mission: { revision: 'a', items: [], complete: true }, capabilities: {} };
function cockpit () {
  expect(component).not.toBeNull();
  return mount(component!.default, { props: { id: 'cockpit-test', report, api: { state: vi.fn(async () => report), command: vi.fn() } }, global: { stubs: { YonderCockpitMap: true, YonderPicture: true }, provide: { $socket: { emit: vi.fn() }, $dataTracker: {} } } });
}
describe('native single-screen cockpit', () => {
  it('defaults to full PFD with mission and map insets', () => {
    const wrapper = cockpit();
    expect(wrapper.attributes('data-layout')).toBe('full');
    expect(wrapper.find('[aria-label="Primary flight display"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Expand mission"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Expand map"]').exists()).toBe(true);
    wrapper.unmount();
  });
  it('expands either inset while keeping the same PFD mounted', async () => {
    const wrapper = cockpit();
    const original = wrapper.find('[aria-label="Primary flight display"]').element;
    await wrapper.get('[aria-label="Expand mission"]').trigger('click');
    expect(wrapper.attributes('data-layout')).toBe('mission');
    expect(wrapper.find('[aria-label="Primary flight display"]').element).toBe(original);
    await wrapper.get('[aria-label="Return to full PFD"]').trigger('click');
    expect(wrapper.attributes('data-layout')).toBe('full');
    wrapper.unmount();
  });
  it('opens instrument settings without issuing a vehicle command', async () => {
    const wrapper = cockpit();
    await wrapper.get('[aria-label="Airspeed controls"]').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect((wrapper.props('api') as any).command).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('aircraft command review boundary',()=>{
 it('only sends the reviewed action once after confirmation',async()=>{const wrapper=cockpit();await wrapper.setProps({report:{...report,connected:true,identity:{generation:'vehicle-a'}}});const api=wrapper.props('api') as any;api.command.mockResolvedValue({accepted:true,operationId:'op-1'});(wrapper.vm as any).review({kind:'mode',customMode:10},'Select AUTO');await wrapper.vm.$nextTick();expect(api.command).not.toHaveBeenCalled();await (wrapper.vm as any).confirmCommand();expect(api.command).toHaveBeenCalledTimes(1);expect(api.command.mock.calls[0][0]).toMatchObject({confirmed:true,vehicleGeneration:'vehicle-a',expectedMissionRevision:'a',action:{kind:'mode',customMode:10}});expect(wrapper.text()).toContain('Awaiting aircraft result');expect(wrapper.text()).not.toContain('Command accepted');wrapper.unmount()});
 it('invalidates a review after identity or mission revision changes',async()=>{const wrapper=cockpit();await wrapper.setProps({report:{...report,connected:true,identity:{generation:'vehicle-a'}}});(wrapper.vm as any).review({kind:'mission-clear'},'Clear mission');await wrapper.setProps({report:{...report,connected:true,identity:{generation:'vehicle-b'}}});await (wrapper.vm as any).confirmCommand();expect((wrapper.props('api') as any).command).not.toHaveBeenCalled();expect(wrapper.text()).toContain('aircraft or mission changed');wrapper.unmount()});
 it('reports a known admission rejection separately from an unknown outcome',async()=>{const wrapper=cockpit();await wrapper.setProps({report:{...report,connected:true,identity:{generation:'vehicle-a'}}});(wrapper.props('api') as any).command.mockResolvedValue({accepted:false,message:'Vehicle busy'});(wrapper.vm as any).review({kind:'arm',armed:true},'Arm');await (wrapper.vm as any).confirmCommand();expect((wrapper.vm as any).error).toBe('Request rejected: Vehicle busy');expect((wrapper.vm as any).reviewing).toBeNull();wrapper.unmount()});
});
it('does not silently adopt a changed aircraft mission as a local draft base',async()=>{const wrapper=cockpit();await wrapper.setProps({report:{...report,connected:true,identity:{generation:'vehicle-a'}}});(wrapper.vm as any).newMission();await wrapper.setProps({report:{...report,mission:{...report.mission,revision:'b'},connected:true,identity:{generation:'vehicle-a'}}});(wrapper.vm as any).reviewUpload();await wrapper.vm.$nextTick();expect((wrapper.vm as any).draftContextChanged).toBe(true);expect((wrapper.vm as any).reviewing).toBeNull();expect((wrapper.vm as any).panel).toBe('draft-conflict');expect((wrapper.props('api') as any).command).not.toHaveBeenCalled();wrapper.unmount()});

it('renders exactly one instrument strip in either supported placement and none when hidden',async()=>{
 const wrapper=cockpit();
 for(const placement of ['mfd','pfd','hidden']){
  (wrapper.vm as any).setOption('stripPlacement',placement);await wrapper.vm.$nextTick();
  expect(wrapper.findAll('[aria-label="Aircraft instrument data"]')).toHaveLength(placement==='hidden'?0:1);
  if(placement==='mfd'){expect(wrapper.find('.cockpit-navigation-data [aria-label="Aircraft instrument data"]').exists()).toBe(true);expect(wrapper.findAll('.pfd-telemetry-strip button')).toHaveLength(5);}
  if(placement==='pfd')expect(wrapper.find('[aria-label="Primary flight display"] [aria-label="Aircraft instrument data"]').exists()).toBe(true);
 }
 wrapper.unmount();
});
