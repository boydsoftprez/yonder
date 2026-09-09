// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
const paths = ['InstrumentGauge', 'InstrumentBank', 'FlightDataBar', 'InstrumentationPanel'];
const modules = Object.fromEntries(await Promise.all(paths.map(async name => [name, await import(/* @vite-ignore */ `./${name}.vue`).catch(() => null)])));
const wrappers: VueWrapper[] = [];
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });
const current = { id: 'battery.0.currentA', label: 'Current', category: 'Electrical', value: 8.4, unit: 'A', available: true, source: 'Battery 0 · component 1', ageMs: 240, quality: 'reported', kind: 'arc', min: 0, max: 40 };
const reserve = { ...current, id: 'battery.1.currentA', label: 'Reserve current', value: 2, source: 'Battery 1 · component 1' };
const cpu = { ...current, id: 'host.cpuPercent', label: 'CPU', category: 'Yonder system', value: 50, unit: '%', source: 'Yonder host', min: 0, max: 100, kind: 'horizontal' };
function render(name: string, props: any, teleportStub = true, attachTo:Element=document.body) { expect(modules[name]).not.toBeNull(); const wrapper = mount(modules[name].default, { props, attachTo, global: { stubs: { teleport: teleportStub } } }); wrappers.push(wrapper); return wrapper; }

describe('instrument faces', () => {
  it.each([
    ['°T', ['N', 'E', 'S', 'W']],
    ['° REL', ['FWD', 'R', 'AFT', 'L']],
    ['°', ['0', '90', '180', '270']],
    ['', ['0', '90', '180', '270']],
  ])('labels the %s bearing frame without changing its pointer', async (unit, labels) => {
    const item = { ...current, kind: 'bearing', value: 42, unit };
    const wrapper = render('InstrumentGauge', { item });
    expect(wrapper.findAll('.scale-label').map(label => label.text())).toEqual(labels);
    expect(wrapper.get('[data-instrument-pointer]').attributes('transform')).toBe('rotate(42 95 48)');
    if (unit !== '°T') expect(wrapper.findAll('.scale-label').some(label => label.text() === 'N')).toBe(false);
    await wrapper.setProps({ item: { ...item, available: false } });
    expect(wrapper.find('[data-instrument-pointer]').exists()).toBe(false);
    expect(wrapper.findAll('.scale-label').map(label => label.text())).toEqual(labels);
  });
  it.each(['arc', 'horizontal', 'vertical', 'bearing'])('removes the %s pointer on expiry and exposes the reason', async kind => {
    const wrapper = render('InstrumentGauge', { item: { ...current, kind } });
    expect(wrapper.find('[data-instrument-pointer]').exists()).toBe(true);
    await wrapper.setProps({ item: { ...current, kind, available: false, reason: 'Battery report expired' } });
    expect(wrapper.find('[data-instrument-pointer]').exists()).toBe(false);
    expect(wrapper.text()).toContain('—');
    expect(wrapper.text()).toContain('Battery report expired');
  });
  it('shows the exact unit and configured band without assuming aircraft redlines', () => {
    const wrapper = render('InstrumentGauge', { item: current, settings: { id: current.id, kind: 'arc', min: 0, max: 40, bands: [{ from: 20, to: 40, color: 'caution' }] } });
    expect(wrapper.find('[data-band="caution"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('A');
    const neutral = render('InstrumentGauge', { item: current });
    expect(neutral.findAll('[data-band]')).toHaveLength(0);
  });
  it.each([[15, '#ff3333'], [30, '#ffff00'], [0, '#ff3333'], [100, '#00cf52']])('uses the highest matching band severity at %s regardless of band order', async (value, color) => {
    const bands = [{ from: 30, to: 100, color: 'normal' }, { from: 15, to: 30, color: 'caution' }, { from: 0, to: 15, color: 'warning' }];
    const settings = { id: current.id, kind: 'arc', min: 0, max: 100, bands };
    const wrapper = render('InstrumentGauge', { item: { ...current, value }, settings });
    expect(wrapper.get('.instrument-number').attributes('fill')).toBe(color);
    await wrapper.setProps({ settings: { ...settings, bands: [...bands].reverse() } });
    expect(wrapper.get('.instrument-number').attributes('fill')).toBe(color);
  });
  it('uses a compact heading while preserving the full identity and does not invent an unknown scale', () => {
    const wrapper = render('InstrumentGauge', { item: { ...current, label: 'Battery 1 discharge current', shortLabel: 'CURRENT', min: undefined, max: undefined } });
    expect(wrapper.get('.instrument-label').text()).toBe('CURRENT');
    expect(wrapper.get('svg').attributes('aria-label')).toContain('Battery 1 discharge current');
    expect(wrapper.find('[data-instrument-pointer]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Set a display scale');
  });
  it('shows a reported boolean status as a lit or unlit mark without inferring warning severity', async () => {
    const item = { ...current, kind: 'status', value: true, label: 'Armed', unit: '' };
    const wrapper = render('InstrumentGauge', { item });
    expect((wrapper.get('.status-mark').element as HTMLElement).style.background).not.toBe('transparent');
    await wrapper.setProps({ item: { ...item, value: false } });
    expect((wrapper.get('.status-mark').element as HTMLElement).style.background).toBe('transparent');
    expect(wrapper.text()).toContain('No');
  });
});

describe('touch configuration', () => {
  it('keeps the editor inside the fullscreen element and returns it to the body after fullscreen exit',async()=>{
    const old=Object.getOwnPropertyDescriptor(document,'fullscreenElement');
    const frame=document.createElement('main');document.body.append(frame);
    const wrapper=render('InstrumentBank',{items:[current],config:[{id:current.id,kind:'arc',min:0,max:40}]},false,frame);
    let fullscreen:Element|null=frame;Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>fullscreen});
    try{
      await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
      expect(document.querySelector('.instrument-editor-scrim')?.parentElement).toBe(frame);
      fullscreen=null;document.dispatchEvent(new Event('fullscreenchange'));await wrapper.vm.$nextTick();
      expect(document.querySelector('.instrument-editor-scrim')?.parentElement).toBe(document.body);
      await new DOMWrapper(document.body).get('[aria-label="Cancel instrument changes"]').trigger('click');
      expect(document.querySelector('.instrument-editor-scrim')).toBeNull();expect(wrapper.emitted('update:config')).toBeUndefined();
    }finally{wrapper.unmount();wrappers.splice(wrappers.indexOf(wrapper),1);frame.remove();if(old)Object.defineProperty(document,'fullscreenElement',old);else delete (document as any).fullscreenElement;}
  });
  it.each(['FlightDataBar', 'InstrumentBank', 'InstrumentationPanel'])('portals the %s editor outside host stacking contexts and retains cancel/focus behavior', async name => {
    const config = [{ id: current.id }, { id: cpu.id }];
    const wrapper = render(name, { items: [current, reserve, cpu], ...(name === 'InstrumentationPanel' ? { bankConfig: config } : { config }) }, false);
    const launch = wrapper.get(name === 'FlightDataBar' ? '[aria-label="Configure navigation fields"]' : '[aria-label="Configure instruments"]');
    (launch.element as HTMLElement).focus();
    await launch.trigger('click');
    const scrim = document.querySelector('.instrument-editor-scrim')!;
    expect(scrim.parentElement).toBe(document.body);
    expect(wrapper.element.contains(scrim)).toBe(false);
    const editor = new DOMWrapper(scrim);
    await editor.get('[aria-label^="Edit slot 2:"]').trigger('click');
    await editor.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await editor.get('[aria-label="Cancel instrument changes"]').trigger('click');
    expect(document.querySelector('.instrument-editor-scrim')).toBeNull();
    expect(wrapper.emitted('update:config')).toBeUndefined();
    expect(wrapper.emitted('update:bankConfig')).toBeUndefined();
    expect(config).toEqual([{ id: current.id }, { id: cpu.id }]);
    expect(document.activeElement).toBe(launch.element);
  });
  it('keeps focus inside after removing the final slot so Escape cancels without publishing', async () => {
    const config = [{ id: current.id }];
    const wrapper = render('InstrumentBank', { items: [current], config });
    const launch = wrapper.get('[aria-label="Configure instruments"]');
    (launch.element as HTMLElement).focus();
    await launch.trigger('click');
    const remove = wrapper.get('[aria-label="Remove instrument"]');
    (remove.element as HTMLElement).focus();
    await remove.trigger('click');
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.get('[aria-label="Add instrument"]').element);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.emitted('update:config')).toBeUndefined();
    expect(config).toEqual([{ id: current.id }]);
    expect(document.activeElement).toBe(launch.element);
  });
  it('keeps focus inside after removing a focused band so Escape cancels its local deletion', async () => {
    const config = [{ id: current.id, min: 0, max: 40, bands: [{ from: 20, to: 40, color: 'caution' }] }];
    const wrapper = render('InstrumentBank', { items: [current], config });
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    const remove = wrapper.get('[aria-label="Remove band 1"]');
    (remove.element as HTMLElement).focus();
    await remove.trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe('Add display band');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.emitted('update:config')).toBeUndefined();
    expect(config[0].bands).toEqual([{ from: 20, to: 40, color: 'caution' }]);
  });
  it('repairs focus when an ordering change disables the focused move control', async () => {
    const wrapper = render('InstrumentBank', { items: [current, cpu], config: [{ id: current.id }, { id: cpu.id }] });
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    const later = wrapper.get('[aria-label="Move later"]');
    (later.element as HTMLElement).focus();
    await later.trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.matches(':disabled')).toBe(false);
  });
  it('does not publish edits on cancel; applies source, style and order together', async () => {
    const config = [{ id: current.id }, { id: cpu.id }];
    const wrapper = render('InstrumentBank', { items: [current, reserve, cpu], config });
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await wrapper.get('[aria-label="Presentation"]').setValue('vertical');
    await wrapper.get('[aria-label="Move later"]').trigger('click');
    expect(wrapper.emitted('update:config')).toBeUndefined();
    await wrapper.get('[aria-label="Cancel instrument changes"]').trigger('click');
    expect(wrapper.emitted('update:config')).toBeUndefined();
    expect(config).toEqual([{ id: current.id }, { id: cpu.id }]);
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await wrapper.get('[aria-label="Presentation"]').setValue('vertical');
    await wrapper.get('[aria-label="Move later"]').trigger('click');
    await wrapper.get('[aria-label="Apply instrument changes"]').trigger('click');
    expect(wrapper.emitted('update:config')?.[0][0]).toEqual([{ id: cpu.id }, { id: reserve.id, kind: 'vertical' }]);
  });
  it('rejects inverted scale endpoints and only publishes defaults on apply', async () => {
    const wrapper = render('InstrumentBank', { items: [current, cpu], config: [{ id: current.id, min: 0, max: 40 }] });
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Display minimum"]').setValue('50');
    expect(wrapper.get('[aria-label="Apply instrument changes"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('minimum');
    await wrapper.get('[aria-label="Restore default instruments"]').trigger('click');
    expect(wrapper.emitted('update:config')).toBeUndefined();
    await wrapper.get('[aria-label="Apply instrument changes"]').trigger('click');
    const saved = wrapper.emitted('update:config')?.[0][0] as any[];
    expect(saved).toHaveLength(6);
    expect(saved.map(s => s.id)).toContain('link.telemetryAgeSeconds');
  });
  it('keeps navigation timer formatting, offers touch settings and preserves focus on cancel', async () => {
    const item = { ...current, id: 'flight.airborneSeconds', label: 'Airborne', unit: 's', kind: 'timer', value: 3661 };
    const wrapper = render('FlightDataBar', { items: [item], config: [{ id: item.id, kind: 'timer' }] });
    expect(wrapper.text()).toContain('1:01:01');
    const trigger = wrapper.get('[aria-label="Configure navigation fields"]');
    (trigger.element as HTMLElement).focus();
    await trigger.trigger('click');
    await wrapper.get('[aria-label="Cancel instrument changes"]').trigger('click');
    expect(document.activeElement).toBe(trigger.element);
  });
  it('removes and adds slots, edits display bands and traps keyboard focus', async () => {
    const wrapper = render('InstrumentBank', { items: [current, reserve, cpu], config: [{ id: current.id }] });
    await wrapper.get('[aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Remove instrument"]').trigger('click');
    expect(wrapper.text()).toContain('No fields selected');
    await wrapper.get('[aria-label="Add instrument"]').trigger('click');
    await wrapper.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await wrapper.findAll('button').find(button => button.text() === 'Add display band')!.trigger('click');
    await wrapper.get('[aria-label="Band 1 minimum"]').setValue('20');
    await wrapper.get('[aria-label="Band 1 color"]').setValue('warning');
    const apply = wrapper.get('[aria-label="Apply instrument changes"]');
    (apply.element as HTMLElement).focus();
    await apply.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(wrapper.get('[aria-label="Close instrument editor"]').element);
    await apply.trigger('click');
    expect(wrapper.emitted('update:config')?.[0][0]).toEqual([{ id: reserve.id, min: 0, max: 40, bands: [{ from: 20, to: 40, color: 'warning' }] }]);
  });
});

describe('systems and inspector', () => {
  it('shows the configured graphical instruments in Systems and opens detail on a gauge tap', async () => {
    const wrapper = render('InstrumentationPanel', { items: [current, reserve, cpu], bankConfig: [{ id: reserve.id, kind: 'vertical' }, { id: cpu.id, kind: 'horizontal' }] });
    const overview = wrapper.get('[aria-label="Pinned instruments overview"]');
    expect(overview.findAll('[data-instrument-id]').map(face => face.attributes('data-instrument-id'))).toEqual([reserve.id, cpu.id]);
    expect(overview.get(`[data-instrument-id="${reserve.id}"]`).classes()).toContain('instrument-gauge-vertical');
    expect(overview.get('[aria-label="Aircraft instrument bank"]').attributes('data-placement')).toBe('mfd');
    await overview.get('[aria-label="Inspect Reserve current"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([[reserve.id]]);
    expect(wrapper.get('[aria-label="Selected reading inspector"]').text()).toContain('Reserve current');
    expect(wrapper.emitted('update:bankConfig')).toBeUndefined();
  });
  it('collapses the graphical overview and hides it during search while keeping catalog rows reachable', async () => {
    const wrapper = render('InstrumentationPanel', { items: [current, cpu], bankConfig: [{ id: current.id }] });
    const toggle = wrapper.get('[aria-label="Pinned instruments"]');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[aria-label="Pinned instruments overview"] [aria-label="Aircraft instrument bank"]').isVisible()).toBe(false);
    expect(wrapper.get(`[data-reading-id="${cpu.id}"]`).isVisible()).toBe(true);
    await toggle.trigger('click');
    expect(wrapper.get('[aria-label="Pinned instruments overview"] [aria-label="Aircraft instrument bank"]').isVisible()).toBe(true);
    await wrapper.get('[aria-label="Search readings"]').setValue('cpu');
    expect(wrapper.find('[aria-label="Pinned instruments overview"]').exists()).toBe(false);
    expect(wrapper.find(`[data-reading-id="${current.id}"]`).exists()).toBe(false);
    expect(wrapper.get(`[data-reading-id="${cpu.id}"]`).isVisible()).toBe(true);
    await wrapper.get('[aria-label="Search readings"]').setValue('');
    expect(wrapper.get('[aria-label="Pinned instruments overview"]').isVisible()).toBe(true);
  });
  it('edits the overview through the shared bank configuration and emits one update only on Apply', async () => {
    const bankConfig = [{ id: current.id, kind: 'horizontal' }, { id: cpu.id, kind: 'horizontal' }];
    const wrapper = render('InstrumentationPanel', { items: [current, reserve, cpu], bankConfig });
    await wrapper.get('[aria-label="Pinned instruments overview"] [aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await wrapper.get('[aria-label="Cancel instrument changes"]').trigger('click');
    expect(wrapper.emitted('update:bankConfig')).toBeUndefined();
    await wrapper.get('[aria-label="Pinned instruments overview"] [aria-label="Configure instruments"]').trigger('click');
    await wrapper.get('[aria-label="Instrument source"]').setValue(reserve.id);
    await wrapper.get('[aria-label="Presentation"]').setValue('vertical');
    await wrapper.get('[aria-label="Apply instrument changes"]').trigger('click');
    expect(wrapper.emitted('update:bankConfig')).toEqual([[ [{ id: reserve.id, kind: 'vertical' }, { id: cpu.id, kind: 'horizontal' }] ]]);
    expect(bankConfig[0].id).toBe(current.id);
    await wrapper.setProps({ bankConfig: [{ id: reserve.id, kind: 'vertical' }, { id: cpu.id, kind: 'horizontal' }] });
    expect(wrapper.get('[aria-label="Pinned instruments overview"]').findAll('[data-instrument-id]').map(face => face.attributes('data-instrument-id'))).toEqual([reserve.id, cpu.id]);
  });
  it('opens an empty inspector with searchable source selection and only pins on request', async () => {
    const bankConfig = [{ id: current.id }];
    const wrapper = render('InstrumentationPanel', { items: [current, reserve, cpu], view: 'inspector', selectedId: null, bankConfig, topConfig: [] });
    expect(wrapper.find('[aria-label="Selected reading inspector"]').exists()).toBe(false);
    await wrapper.get('[aria-label="Search telemetry sources"]').setValue('battery 1');
    const picker = wrapper.get('[aria-label="Telemetry source"]');
    expect(picker.find(`option[value="${reserve.id}"]`).exists()).toBe(true);
    expect(picker.find(`option[value="${current.id}"]`).exists()).toBe(false);
    expect(picker.find(`option[value="${cpu.id}"]`).exists()).toBe(false);
    await picker.setValue(reserve.id);
    expect(wrapper.emitted('select')?.[0]).toEqual([reserve.id]);
    expect(wrapper.get('[aria-label="Selected reading inspector"]').text()).toContain('Reserve current');
    expect(wrapper.find('[aria-label="Received telemetry catalog"]').exists()).toBe(false);
    expect(wrapper.emitted('update:bankConfig')).toBeUndefined();
    expect(wrapper.emitted('update:topConfig')).toBeUndefined();
    await wrapper.get('[aria-label="Pin to instruments"]').trigger('click');
    expect(wrapper.emitted('update:bankConfig')?.[0][0]).toEqual([{ id: current.id }, { id: reserve.id }]);
    expect(bankConfig).toEqual([{ id: current.id }]);
  });
  it('shows an empty search result without clearing the inspected source or changing settings', async () => {
    const wrapper = render('InstrumentationPanel', { items: [current, reserve], view: 'inspector', selectedId: current.id });
    await wrapper.get('[aria-label="Search telemetry sources"]').setValue('unmatched reading');
    expect(wrapper.text()).toContain('No readings match this search.');
    expect(wrapper.get('[aria-label="Selected reading inspector"]').text()).toContain('Current');
    expect(wrapper.get('[aria-label="Telemetry source"]').element.value).toBe(current.id);
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('update:bankConfig')).toBeUndefined();
  });
  it('opens the inspector when the parent selects a field and preserves grouped Systems navigation', async () => {
    const wrapper = render('InstrumentationPanel', { items: [current, reserve, cpu], view: 'systems', selectedId: null });
    await wrapper.setProps({ selectedId: cpu.id });
    expect(wrapper.find('[aria-label="Received telemetry catalog"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="Telemetry source"]').element.value).toBe(cpu.id);
    expect(wrapper.get('[aria-label="Selected reading inspector"]').text()).toContain('Yonder host');
    await wrapper.findAll('button').find(button => button.text() === 'Systems')!.trigger('click');
    expect(wrapper.get('[aria-label="Received telemetry catalog"]').text()).toContain('Electrical');
    expect(wrapper.get('[aria-label="Received telemetry catalog"]').text()).toContain('Yonder system');
  });
  it('searches source instances, selects the result and pins it without losing existing gauges', async () => {
    const wrapper = render('InstrumentationPanel', { items: [current, reserve, cpu], bankConfig: [{ id: current.id }], topConfig: [], history: {} });
    await wrapper.get('[aria-label="Search readings"]').setValue('battery 1');
    expect(wrapper.find(`[data-reading-id="${current.id}"]`).exists()).toBe(false);
    await wrapper.get(`[data-reading-id="${reserve.id}"]`).trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([reserve.id]);
    expect(wrapper.text()).toContain('Battery 1 · component 1');
    expect(wrapper.get('[aria-label="Selected reading inspector"]').isVisible()).toBe(true);
    expect(wrapper.find('[aria-label="Received telemetry catalog"]').exists()).toBe(false);
    await wrapper.get('[aria-label="Pin to instruments"]').trigger('click');
    expect(wrapper.emitted('update:bankConfig')?.[0][0]).toEqual([{ id: current.id }, { id: reserve.id }]);
    await wrapper.get('[aria-label="Pin to navigation fields"]').trigger('click');
    expect(wrapper.emitted('update:topConfig')?.[0][0]).toEqual([{ id: reserve.id }]);
  });
  it('draws disjoint trends for a missing sample and explains unavailable readings', () => {
    const wrapper = render('InstrumentationPanel', { items: [{ ...current, available: false, reason: 'Not reported by aircraft' }], selectedId: current.id, history: { [current.id]: [{ t: 0, v: 1 }, { t: 1000, v: 2 }, { t: 2000, v: null }, { t: 3000, v: 4 }, { t: 4000, v: 5 }] } });
    expect(wrapper.findAll('[data-trend-segment]')).toHaveLength(2);
    expect(wrapper.text()).toContain('Not reported by aircraft');
    expect(wrapper.text()).toContain('0.2 s');
    expect(wrapper.text()).toContain('reported');
  });
  it('retains the time occupied by trailing unavailable samples instead of stretching old data to now', () => {
    const wrapper = render('InstrumentationPanel', { items: [current], selectedId: current.id, history: { [current.id]: [{ t: 0, v: 1 }, { t: 1000, v: 2 }, { t: 2000, v: null }, { t: 3000, v: null }] } });
    expect(wrapper.get('[data-trend-segment]').attributes('d')).toContain('L126.00');
    expect(wrapper.get('[aria-label="Recent reading history"]').text()).toContain('−3 s');
  });
});
