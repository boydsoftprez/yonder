// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import FlightControlPanel from './FlightControlPanel.vue';
import MissionTouch from './MissionTouch.vue';
import MissionWaypointList from './MissionWaypointList.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
import {aircraftMission} from './cockpit-state.mjs';
import {missionSequence} from './mission-sequence.mjs';
it('reviews feet and ft/min as exact SI requests and preserves values when changing units',async()=>{
 const w=mount(FlightControlPanel,{props:{snapshot:fixture(),available:true,options:{altitudeUnit:'ft',verticalSpeedUnit:'fpm'}}});
 await w.get('[aria-label="Altitude / Speed"]').trigger('click');
 await w.get('[aria-label="Requested altitude FT"]').setValue('500');await w.get('[aria-label="Requested vertical rate"]').setValue('300');
 expect(w.emitted('request')).toBeUndefined();
 await w.setProps({options:{altitudeUnit:'m',verticalSpeedUnit:'mps'}});
 expect(Number(w.get('[aria-label="Requested altitude M"]').element.value)).toBeCloseTo(152.4);
 expect(Number(w.get('[aria-label="Requested vertical rate"]').element.value)).toBeCloseTo(1.524);
 await w.get('form').trigger('submit');expect(w.emitted('request')?.[0]?.[0].action).toMatchObject({kind:'altitude',altitudeM:152.4});expect(w.emitted('request')?.[0]?.[0].action.verticalRateMps).toBeCloseTo(1.524);w.unmount();
});
it('converts mph to airspeed m/s before review and keeps the firmware limitation visible',async()=>{
 const w=mount(FlightControlPanel,{props:{snapshot:fixture(),available:true,options:{speedUnit:'mph'}}});
 await w.vm.open('airspeed');await w.get('[aria-label="Requested airspeed MPH"]').setValue('60');
 expect(w.text()).toContain('does not select an IAS climb');await w.get('form').trigger('submit');
 expect(w.emitted('request')?.[0]?.[0].action.airspeedMps).toBeCloseTo(26.8224);w.unmount();
});
it('opens a waypoint altitude cell into a local draft edit and draws the active bracket',async()=>{
 const s=fixture(),m=aircraftMission(s),progress=missionSequence(s);
 const list=mount(MissionWaypointList,{props:{mission:m,progress,options:{},follow:true}});
 expect(list.get('.mission-leg-connector').attributes('data-to')).toBe('2');
 await list.get('[aria-label="Edit altitude at waypoint 2"]').trigger('click');
 const selection=list.emitted('select')?.[0]?.[0];expect(selection).toEqual({seq:2,editAltitude:true});
 const edit=mount(MissionTouch,{props:{mission:m,selection,options:{altitudeUnit:'ft'}}});
 await edit.get('[aria-label="Alt parameter 7"]').setValue('600');await edit.get('form').trigger('submit');
 const changed=edit.emitted('edit')?.[0]?.[0];expect(changed.kind).toBe('replace');expect(changed.seq).toBe(2);expect(changed.item.alt).toBeCloseTo(182.88);expect(edit.emitted('command')).toBeUndefined();expect(m.items.find(i=>i.seq===2).alt).not.toBeCloseTo(182.88);edit.unmount();list.unmount();
});
