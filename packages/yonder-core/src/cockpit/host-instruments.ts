// SPDX-License-Identifier: GPL-3.0-or-later
import type { InstrumentReading, InstrumentationSnapshot } from '../mav/instrumentation-types.js';
import type { ModemState } from '../net/modem/state.js';
import { parseCpuTemperature, parseMeminfo, parseUptime } from '../system/facts.js';
import type { FileReader } from '../system/read.js';
import type { CameraRun } from '../video/supervisor.js';
import type { RecordingState } from '../video/recorder.js';

type Fields = Record<string, InstrumentReading>;
interface Sample<T> { at: number; value: T | null }
export interface MediaInstrumentState { id: string; run: CameraRun | null; recorder: RecordingState | null }
export interface HostInstrumentOptions {
  now?: () => number;
  /** No reader defaults to the developer's machine. Production wiring supplies these. */
  readFile?: FileReader;
  freeBytes?: () => Promise<number>;
  /** Passive ModemManager reads only; never arm reporting or bring up a connection. */
  modem?: () => Promise<ModemState>;
  /** Existing supervisor/recorder state; no detection, stream start or browser statistics. */
  media?: () => Promise<MediaInstrumentState[]>;
}

/** One shared in-flight read and one result per interval, including failures. */
function cached<T>(now: () => number, interval: number, read: () => Promise<T>) {
  let sample: Sample<T> | undefined, pending: Promise<Sample<T>> | undefined;
  return (): Promise<Sample<T>> => {
    if (pending) return pending;
    const at = now();
    if (sample && at >= sample.at && at - sample.at < interval) return Promise.resolve(sample);
    pending = (async () => {
      try { sample = { at, value: await read() }; }
      catch { sample = { at, value: null }; }
      return sample;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Optional IO cannot hold a snapshot open. At most one operation per reader is
 * pending; replies reuse the last sample's start stamp, never the response time. */
function background<T>(now: () => number, interval: number, read?: () => Promise<T>) {
  let sample: Sample<T> | undefined, pending: Promise<void> | undefined;
  let lastStarted: number | undefined;
  return {
    refresh(): void {
      if (!read || pending) return;
      const at = now();
      if (lastStarted !== undefined && at >= lastStarted && at - lastStarted < interval) return;
      lastStarted = at;
      pending = (async () => {
        try { sample = { at, value: await read() }; }
        catch { sample = { at, value: null }; }
      })().finally(() => { pending = undefined; });
    },
    state: () => ({ sample, pending: pending !== undefined }),
  };
}

function writer(fields: Fields) {
  return (key: string, value: InstrumentReading['value'], unit: string, source: string,
    quality: InstrumentReading['quality'] = 'reported', reason = 'Reading not available', ageMs = 0, ttlMs = 3000) => {
    const available = value !== null && (typeof value !== 'number' || Number.isFinite(value));
    fields[key] = { value: available ? value : null, unit, source, ageMs: available ? ageMs : null, ttlMs,
      quality: available ? quality : 'unavailable', ...(!available ? { reason } : {}) };
  };
}

function age(fields: Fields, elapsed: number): Fields {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    const ageMs = field.ageMs === null ? null : field.ageMs + Math.max(0, elapsed);
    return [key, ageMs !== null && ageMs >= field.ttlMs
      ? { ...field, ageMs, value: null, quality: 'unavailable', reason: 'Reading expired' }
      : { ...field, ageMs }];
  }));
}

/** The first eight Linux counters exclude guest time already included in user/nice. */
function cpuCounters(text: string | null): number[] | null {
  const line = text?.split('\n').find(line => /^cpu\s/.test(line));
  if (!line) return null;
  const tokens = line.trim().split(/\s+/).slice(1);
  if (tokens.length < 8 || tokens.some(token => !/^\d+$/.test(token))) return null;
  const counters = tokens.slice(0, 8).map(Number);
  return counters.every(Number.isSafeInteger) ? counters : null;
}

/** R-FLT-26/R-SYS-01: observed companion readings, bounded independently of flight wire. */
export class HostInstruments {
  private readonly now: () => number;
  private readonly read: FileReader;
  private previousCpu: number[] | null = null;
  private previousCpuAt: number | null = null;
  private readonly modem: ReturnType<typeof background<ModemState>>;
  private readonly storage: ReturnType<typeof background<number>>;
  private readonly media: ReturnType<typeof background<MediaInstrumentState[]>>;
  private readonly sample: () => Promise<Sample<Fields>>;

  constructor(options: HostInstrumentOptions = {}) {
    this.now = options.now ?? Date.now;
    this.read = path => { try { return options.readFile?.(path) ?? null; } catch { return null; } };
    this.modem = background(this.now, 5000, options.modem);
    this.storage = background(this.now, 1000, options.freeBytes);
    this.media = background(this.now, 1000, options.media);
    this.sample = cached(this.now, 1000, async () => this.collectOs());
  }

  async snapshot(): Promise<Fields> {
    const os = this.sample();
    this.modem.refresh(); this.storage.refresh(); this.media.refresh();
    const sample = await os, at = this.now();
    return { ...age(sample.value ?? {}, at - sample.at), ...age(this.optionalFields(at), 0) };
  }

  private collectOs(): Fields {
    const at = this.now(), fields: Fields = {}, put = writer(fields);
    const counters = cpuCounters(this.read('/proc/stat'));
    let percent: number | null = null;
    if (counters && this.previousCpu && this.previousCpuAt !== null && at > this.previousCpuAt && at - this.previousCpuAt <= 3000) {
      const deltas = counters.map((value, i) => value - this.previousCpu![i]);
      const total = deltas.reduce((a, b) => a + b, 0);
      if (deltas.every(d => d >= 0) && total > 0) percent = 100 * (total - deltas[3] - deltas[4]) / total;
    }
    this.previousCpu = counters;
    this.previousCpuAt = at;
    put('host.cpuPercent', percent === null ? null : Math.round(percent * 10) / 10, '%', 'Companion /proc/stat', 'calculated', 'Waiting for two valid CPU samples');
    const memory = parseMeminfo(this.read('/proc/meminfo'));
    const total = memory && Number.isFinite(memory.totalBytes) && memory.totalBytes > 0 ? memory.totalBytes : null;
    const available = total !== null && memory?.availableBytes !== null && memory?.availableBytes !== undefined
      && Number.isFinite(memory.availableBytes) && memory.availableBytes >= 0 && memory.availableBytes <= total ? memory.availableBytes : null;
    put('host.memoryPercent', available !== null && total !== null ? 100 * (total - available) / total : null, '%', 'Companion /proc/meminfo', 'calculated');
    put('host.memoryTotalBytes', total, 'B', 'Companion /proc/meminfo');
    put('host.memoryAvailableBytes', available, 'B', 'Companion /proc/meminfo');
    put('host.temperatureC', parseCpuTemperature(this.read('/sys/class/thermal/thermal_zone0/temp')), '°C', 'Companion thermal_zone0');
    put('host.uptimeSeconds', parseUptime(this.read('/proc/uptime')), 's', 'Companion /proc/uptime');
    return fields;
  }

  private optionalFields(at: number): Fields {
    const fields: Fields = {}, put = writer(fields);
    const storage = this.storage.state(), modem = this.modem.state(), media = this.media.state();
    const free = storage.sample?.value ?? null;
    put('host.storageFreeBytes', free !== null && free >= 0 ? free : null, 'B', 'Companion recording medium', 'reported',
      storage.pending ? 'Storage reading pending' : 'Storage reading not available', Math.max(0, at - (storage.sample?.at ?? at)));
    const state = modem.sample?.value, source = 'Companion modem (ModemManager)';
    const modemAge = Math.max(0, at - (modem.sample?.at ?? at));
    for (const [name, signal, unit] of [['rssiDbm', 'rssi', 'dBm'], ['rsrpDbm', 'rsrp', 'dBm'], ['rsrqDb', 'rsrq', 'dB'], ['sinrDb', 'snr', 'dB']] as const) {
      put(`modem.${name}`, state?.reportsSignal ? state.signal[signal] : null, unit, source, 'reported', state && !state.reportsSignal ? 'This modem does not expose signal readings' : modem.pending ? 'Modem reading pending' : 'Modem signal not reported', modemAge, 15000);
    }
    for (const key of ['mode', 'operator', 'technology'] as const) put(`modem.${key}`, state?.[key] ?? null, '', source, 'reported', modem.pending ? 'Modem reading pending' : 'Modem state not available', modemAge, 15000);
    const cameras = media.sample?.value, mediaAt = media.sample?.at ?? at, mediaAge = Math.max(0, at - mediaAt);
    put('media.cameraCount', cameras?.length ?? null, '', 'Companion camera services', 'reported', media.pending ? 'Camera service reading pending' : 'Camera service reading not available', mediaAge);
    for (const camera of (cameras ?? []).slice(0, 8)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(camera.id)) continue;
      const key = `media.${camera.id}`, recorder = camera.recorder;
      put(`${key}.pipelineState`, camera.run?.state ?? null, '', 'Companion pipeline supervisor', 'reported', undefined, mediaAge);
      put(`${key}.recording`, recorder?.recording ?? null, '', 'Companion recorder', 'reported', undefined, mediaAge);
      put(`${key}.recordingSeconds`, recorder?.recording && recorder.since !== null && recorder.since <= mediaAt ? (mediaAt - recorder.since) / 1000 : null, 's', 'Companion recorder', 'calculated', 'No active recording with a known start time', mediaAge);
      put(`${key}.recordingRemainingSeconds`, recorder?.remainingSeconds ?? null, 's', 'Companion recorder medium estimate', 'calculated', undefined, mediaAge);
      put(`${key}.recordingBytes`, recorder?.bytes ?? null, 'B', 'Companion recorder', 'reported', undefined, mediaAge);
      put(`${key}.recordingDestination`, recorder?.destination ?? null, '', 'Companion recorder', 'reported', undefined, mediaAge);
    }
    return fields;
  }
}

/** Reused by all browser sessions. A 1Hz read never sends a vehicle request. */
export class CockpitInstruments {
  private readonly now: () => number;
  private readonly sample: () => Promise<Sample<InstrumentationSnapshot>>;
  constructor(private readonly options: { now?: () => number; host: HostInstruments; vehicle?: { instrumentation(): InstrumentationSnapshot } }) {
    this.now = options.now ?? Date.now;
    this.sample = cached(this.now, 1000, async () => {
      let vehicle: InstrumentationSnapshot | undefined;
      try { vehicle = options.vehicle?.instrumentation(); } catch { /* Host readings remain useful if the vehicle service fails. */ }
      return vehicle ?? { at: this.now(), generation: null, connected: false, fields: {} };
    });
  }
  async snapshot(): Promise<InstrumentationSnapshot> {
    // Cache the aircraft and OS separately, so a completed optional read can be
    // exposed immediately without refreshing aircraft or other source stamps.
    const [sample, host] = await Promise.all([this.sample(), this.options.host.snapshot()]), at = this.now();
    return { at, generation: sample.value?.generation ?? null, connected: sample.value?.connected ?? false,
      fields: { ...host, ...age(sample.value?.fields ?? {}, at - (sample.value?.at ?? at)) } };
  }
}
