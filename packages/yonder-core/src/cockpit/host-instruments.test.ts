// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HostInstruments, CockpitInstruments, type HostInstrumentOptions } from './host-instruments.js';
import type { ModemState } from '../net/modem/state.js';

describe('companion instruments', () => {
  it('computes CPU busy delta excluding guest double-counting and idle/iowait', async () => {
    let now = 1000, stat = 'cpu 100 0 50 850 0 0 0 0 40 0\n';
    const host = new HostInstruments({ now: () => now, readFile: path => path === '/proc/stat' ? stat : null });
    expect((await host.snapshot())['host.cpuPercent']).toMatchObject({ value: null, quality: 'unavailable' });
    now += 1000; stat = 'cpu 130 0 60 900 10 0 0 0 50 0\n';
    expect((await host.snapshot())['host.cpuPercent']).toMatchObject({ value: 40, unit: '%', quality: 'calculated', ageMs: 0 });
    now += 1000; stat = 'cpu 1 0 2 3 0 0 0 0\n';
    expect((await host.snapshot())['host.cpuPercent'].value).toBeNull();
    now += 1000; stat = 'cpu 1 0 2 3 0 0 0 0\n';
    expect((await host.snapshot())['host.cpuPercent'].value).toBeNull();
  });

  it('keeps missing and malformed OS readings unavailable, including a gap between CPU samples', async () => {
    let now = 0, stat: string | null = 'cpu 100 0 50 850 0 0 0 0\n';
    const host = new HostInstruments({ now: () => now, readFile: p => p === '/proc/stat' ? stat : '', freeBytes: async () => { throw Error('unreadable'); } });
    const first = await host.snapshot();
    for (const key of ['host.temperatureC', 'host.memoryPercent', 'host.uptimeSeconds', 'host.storageFreeBytes', 'modem.rsrpDbm']) {
      expect(first[key]).toMatchObject({ value: null, ageMs: null, quality: 'unavailable' });
      expect(first[key].reason).toBeTruthy();
    }
    now += 1000; stat = null; await host.snapshot();
    now += 1000; stat = 'cpu 130 0 60 900 0 0 0 0\n';
    expect((await host.snapshot())['host.cpuPercent'].value).toBeNull();
  });

  it('reports memory availability, thermal-zone temperature, uptime and recording medium space with their own sources', async () => {
    const files: Record<string, string> = { '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 10 kB\n', '/proc/uptime': '120.5 222', '/sys/class/thermal/thermal_zone0/temp': '58200' };
    const host = new HostInstruments({ now: () => 1000, readFile: p => files[p] ?? null, freeBytes: async () => 123456 });
    const fields = await host.snapshot();
    expect(fields['host.memoryPercent'].value).toBe(75);
    expect(fields['host.memoryAvailableBytes'].value).toBe(256000);
    expect(fields['host.temperatureC']).toMatchObject({ value: 58.2, source: 'Companion thermal_zone0' });
    expect(fields['host.uptimeSeconds'].value).toBe(120.5);
    expect(fields['host.storageFreeBytes']).toMatchObject({ value: 123456, source: 'Companion recording medium' });
  });

  it('coalesces concurrent browsers, limits OS reads to 1Hz and preserves the slower modem age', async () => {
    let now = 1000, reads = 0, modemReads = 0;
    let release!: (m: ModemState) => void;
    const modem: ModemState = { mode: 'connected', summary: 'Connected', operator: 'Test', technology: 'lte', registration: 'home', apn: null, address: null, mtu: null, signal: { rssi: -60, rsrp: -85, rsrq: -9, snr: 12 }, ports: [], reportsSignal: true };
    const host = new HostInstruments({ now: () => now, readFile: () => { reads++; return null; }, modem: () => { modemReads++; return new Promise(r => { release = r; }); } });
    const one = host.snapshot(), two = host.snapshot();
    await Promise.resolve(); release(modem);
    await Promise.all([one, two]);
    expect(reads).toBe(4); expect(modemReads).toBe(1);
    now = 1900;
    expect((await host.snapshot())['modem.rsrpDbm']).toMatchObject({ value: -85, ageMs: 900 });
    expect(reads).toBe(4);
    now = 2000;
    expect((await host.snapshot())['modem.sinrDb']).toMatchObject({ value: 12, ageMs: 1000, source: 'Companion modem (ModemManager)' });
    expect(reads).toBe(8); expect(modemReads).toBe(1);
  });

  it('uses observed camera and recorder state, distinguishes companion cameras and calculates elapsed recording time', async () => {
    const host = new HostInstruments({ now: () => 9000, media: async () => [{ id: '0', run: { id: '0', state: 'running', since: 1000, restarts: 0 }, recorder: { recording: true, since: 5000, destination: 'board', remainingSeconds: 600, remainingPhotos: null, bytes: 123, ended: null } }] });
    const fields = await host.snapshot();
    expect(fields['media.0.pipelineState'].value).toBe('running');
    expect(fields['media.0.recording'].value).toBe(true);
    expect(fields['media.0.recordingSeconds']).toMatchObject({ value: 4, quality: 'calculated' });
    expect(fields['media.0.recordingRemainingSeconds']).toMatchObject({ value: 600, quality: 'calculated' });
    expect(fields['camera.0.recording']).toBeUndefined();
  });

  it('shares complete merged vehicle snapshots across instrument reads and preserves individual sample ages', async () => {
    let now = 1000, calls = 0;
    const reader = new CockpitInstruments({ now: () => now, host: new HostInstruments({ now: () => now }), vehicle: { instrumentation: () => { calls++; return { at: now, generation: 'aircraft-one', connected: true, fields: { 'battery.0.voltageV': { value: 22.1, unit: 'V', source: 'FC 1:1 BATTERY_STATUS', ageMs: 500, ttlMs: 3000, quality: 'reported' } } }; } } });
    expect((await reader.snapshot()).fields['battery.0.voltageV'].ageMs).toBe(500);
    now = 1900;
    expect(await reader.snapshot()).toMatchObject({ at: 1900, generation: 'aircraft-one', connected: true, fields: { 'battery.0.voltageV': { ageMs: 1400 } } });
    expect(calls).toBe(1);
    now = 2000; await reader.snapshot(); expect(calls).toBe(2);
  });
  it('does not count async host latency twice in merged sample ages', async () => {
    let now = 1000;
    const host = new HostInstruments({ now: () => now, readFile: p => p === '/proc/uptime' ? '10 20' : null, freeBytes: async () => { now += 400; return 123; } });
    const merged = new CockpitInstruments({ now: () => now, host });
    expect((await merged.snapshot()).fields['host.uptimeSeconds'].ageMs).toBe(400);
  });
  it('refuses CPU averages across long collection gaps or a clock reset', async () => {
    let now = 1000, stat = 'cpu 100 0 50 850 0 0 0 0';
    const host = new HostInstruments({ now: () => now, readFile: path => path === '/proc/stat' ? stat : null });
    await host.snapshot(); now = 20000; stat = 'cpu 120 0 50 930 0 0 0 0';
    expect((await host.snapshot())['host.cpuPercent'].value).toBeNull();
    now = 21000; stat = 'cpu 140 0 50 1010 0 0 0 0';
    expect((await host.snapshot())['host.cpuPercent'].value).toBe(20);
    now = 1000; stat = 'cpu 160 0 50 1090 0 0 0 0';
    expect((await host.snapshot())['host.cpuPercent'].value).toBeNull();
  });
  it('does not fabricate negative memory usage when the OS reports inconsistent availability', async () => {
    const host = new HostInstruments({ readFile: path => path === '/proc/meminfo' ? 'MemTotal: 100 kB\nMemAvailable: 200 kB' : null });
    expect((await host.snapshot())['host.memoryPercent']).toMatchObject({ value: null, quality: 'unavailable' });
  });
  it('returns healthy host readings when the vehicle collector fails', async () => {
    const host = new HostInstruments({ now: () => 1000, readFile: path => path === '/proc/uptime' ? '20 40' : null });
    const service = new CockpitInstruments({ now: () => 1000, host, vehicle: { instrumentation: () => { throw Error('Vehicle unavailable'); } } });
    expect(await service.snapshot()).toMatchObject({ connected: false, generation: null, fields: { 'host.uptimeSeconds': { value: 20 } } });
  });
  it.each(['modem', 'freeBytes', 'media'] as const)('returns fresh vehicle and OS data while a %s read remains pending', async slow => {
    let now = 1000, reads = 0;
    const options: HostInstrumentOptions = { now: () => now,
      readFile: path => path === '/proc/uptime' ? `${now / 1000} 10` : path === '/proc/stat' ? now < 2000 ? 'cpu 100 0 0 900 0 0 0 0' : 'cpu 140 0 0 960 0 0 0 0' : null,
      freeBytes: async () => 321, media: async () => [],
      modem: async () => ({ mode: 'connected', summary: 'Connected', operator: null, technology: 'lte', registration: 'home', apn: null, address: null, mtu: null, signal: { rssi: -60, rsrp: -85, rsrq: -9, snr: 12 }, ports: [], reportsSignal: true }),
    };
    options[slow] = () => { reads++; return new Promise<never>(() => {}); };
    const host = new HostInstruments(options);
    const service = new CockpitInstruments({ now: () => now, host, vehicle: { instrumentation: () => ({ at: now, generation: 'healthy', connected: true, fields: { 'battery.0.voltageV': { value: 22, unit: 'V', source: 'FC', ageMs: 0, ttlMs: 3000, quality: 'reported' } } }) } });
    const withinTurn = async () => Promise.race([service.snapshot(), new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
    const one = await withinTurn();
    expect(one).toMatchObject({ connected: true, fields: { 'host.uptimeSeconds': { value: 1, ageMs: 0 }, 'battery.0.voltageV': { value: 22, ageMs: 0 } } });
    const pendingKey = { modem: 'modem.rsrpDbm', freeBytes: 'host.storageFreeBytes', media: 'media.cameraCount' }[slow];
    expect(one!.fields[pendingKey]).toMatchObject({ value: null, ageMs: null, quality: 'unavailable' });
    expect(one!.fields[pendingKey].reason).toMatch(/pending/i);
    if (slow !== 'modem') expect(one!.fields['modem.rsrpDbm'].value).toBe(-85);
    if (slow !== 'freeBytes') expect(one!.fields['host.storageFreeBytes'].value).toBe(321);
    if (slow !== 'media') expect(one!.fields['media.cameraCount'].value).toBe(0);
    now = 2000;
    expect(await withinTurn()).toMatchObject({ fields: { 'host.cpuPercent': { value: 40, ageMs: 0 }, 'battery.0.voltageV': { value: 22, ageMs: 0 } } });
    now = 7000;
    const two = await withinTurn();
    expect(two).toMatchObject({ fields: { 'host.uptimeSeconds': { value: 7, ageMs: 0 }, 'battery.0.voltageV': { value: 22, ageMs: 0 } } });
    expect(reads).toBe(1);
  });
  it('retains independently aged readings during a pending refresh, expires them, and does not refresh an old completion stamp', async () => {
    let now = 1000, reads = 0;
    let release!: (value: number) => void;
    const host = new HostInstruments({ now: () => now, freeBytes: () => { reads++; return reads === 1 ? Promise.resolve(123) : new Promise(resolve => { release = resolve; }); } });
    await host.snapshot(); await new Promise<void>(resolve => setImmediate(resolve));
    expect((await host.snapshot())['host.storageFreeBytes']).toMatchObject({ value: 123, ageMs: 0 });
    now = 2000;
    expect((await host.snapshot())['host.storageFreeBytes']).toMatchObject({ value: 123, ageMs: 1000 });
    now = 4000;
    expect((await host.snapshot())['host.storageFreeBytes']).toMatchObject({ value: null, ageMs: 3000, quality: 'unavailable' });
    expect(reads).toBe(2);
    now = 6000; release(456); await new Promise<void>(resolve => setImmediate(resolve));
    expect((await host.snapshot())['host.storageFreeBytes']).toMatchObject({ value: null, ageMs: 4000, quality: 'unavailable' });
    expect(reads).toBe(3);
  });
  it('does not advance cached recording elapsed time while the media reader is pending', async () => {
    let now = 1000, reads = 0;
    const host = new HostInstruments({ now: () => now, media: () => ++reads === 1 ? Promise.resolve([{ id: 'cam0', run: null, recorder: { recording: true, since: 500, destination: 'board', remainingSeconds: 30, remainingPhotos: null, bytes: 123, ended: null } }]) : new Promise(() => {}) });
    expect((await host.snapshot())['media.cam0.recordingSeconds']).toMatchObject({ value: .5, ageMs: 0 });
    now = 2000;
    expect((await host.snapshot())['media.cam0.recordingSeconds']).toMatchObject({ value: .5, ageMs: 1000 });
    now = 4000;
    expect((await host.snapshot())['media.cam0.recordingSeconds']).toMatchObject({ value: null, ageMs: 3000, quality: 'unavailable' });
    expect(reads).toBe(2);
  });
});
