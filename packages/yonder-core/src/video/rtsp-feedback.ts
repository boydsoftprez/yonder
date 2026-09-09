// SPDX-License-Identifier: GPL-3.0-or-later
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { systemClock, type Clock } from '../apply/types.js';
import type { Camera } from '../schema/config.js';
import { MEDIA_OBSERVER_PORT } from '../media/ports.js';
import { MEDIA_OBSERVER_USER } from '../media/config.js';
import type { CameraReport } from './viewers.js';

const MAX_BYTES = 1_048_576;
const PERIOD = 1000;
const MAX_INTERVAL = 12_000;
const COUNTERS = ['outboundBytes', 'outboundRTPPackets', 'outboundRTPPacketsReportedLost',
  'outboundRTPPacketsDiscarded', 'inboundRTCPPackets'] as const;
type Counter = typeof COUNTERS[number];
type Counters = Record<Counter, number>;
export type RtspSession = Counters & {
  id: string; path: string; state: string; remoteAddr: string; transport: 'tcp' | 'udp';
};
export interface TcpDelivery {
  peer: string; acked: number; retrans: number; queue: number; notsent: number | null; rtt: number;
  deliveryKbps?: number;
}
export interface RtspFeedbackState {
  status: 'waiting' | 'active' | 'limited' | 'unavailable';
  message: string;
  readers: number;
  freshReaders: number;
  at: number | null;
  loss: number | null;
  queuedMs: number | null;
  discarded: number;
  deliveredKbps: number | null;
}
type Sample = { session: RtspSession; tcp?: TcpDelivery; at: number };
type Held = { previous: Sample; rr: Sample; rrEstablished: boolean; loss: number; lossAt: number | null; lastReport?: CameraReport };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const counter = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const ratio = (n: number, d: number) => d > 0 ? Math.max(0, Math.min(1, n / d)) : 0;

/** Canonical key for API remoteAddr and ss peer addresses, including mapped IPv4. */
export function peerAddress(value: string): { host: string; key: string } | null {
  if (value.length > 128) return null;
  const match = /^(?:\[([^\]]+)\]|(.+)):([0-9]+)$/.exec(value);
  if (!match) return null;
  const host = (match[1] || match[2]).replace(/^::ffff:/i, '').split('%')[0];
  const port = Number(match[3]);
  return isIP(host) && port > 0 && port <= 65535 ? { host, key: host + ':' + port } : null;
}
export function parseRtspSessions(body: unknown): RtspSession[] {
  if (!record(body) || !Array.isArray(body.items) || body.items.length > 256
    || Number(body.pageCount ?? 1) > 1) throw new Error('Unsupported media feedback response');
  const result: RtspSession[] = [];
  for (const item of body.items) {
    if (!record(item) || item.state !== 'read') continue;
    if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)
      || typeof item.path !== 'string' || typeof item.remoteAddr !== 'string'
      || !peerAddress(item.remoteAddr) || !COUNTERS.every(key => counter(item[key]))) {
      throw new Error('Incomplete media receiver counters');
    }
    const transport = String(item.transport).toLowerCase();
    if (transport !== 'tcp' && transport !== 'udp') throw new Error('Unsupported RTSP transport');
    const counters = Object.fromEntries(COUNTERS.map(key => [key, item[key]])) as Counters;
    result.push({ ...counters, id: item.id, path: item.path, state: 'read', remoteAddr: item.remoteAddr, transport });
  }
  return result;
}
/** A missing counter is unknown, not zero ACKs. No shell or privileged packet capture. */
export function parseTcpDelivery(text: string): Map<string, TcpDelivery> {
  const rows = new Map<string, TcpDelivery>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols[0] !== 'ESTAB' || cols.length < 5) continue;
    const peer = peerAddress(cols[4]);
    if (!peer) continue;
    const values = lines[i + 1];
    const number = (name: string): number | null => {
      const match = new RegExp('(?:^|\\s)' + name + ':([0-9.]+)').exec(values);
      return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
    };
    const acked = number('bytes_acked'), rtt = number('rtt'), queue = Number(cols[2]);
    if (acked === null || rtt === null || !counter(acked) || !counter(queue)) continue;
    const delivery = /(?:^|\s)delivery_rate\s+([0-9]+)bps/.exec(values);
    rows.set(peer.key, { peer: peer.key, acked, rtt, queue, notsent: number('notsent'),
      ...(delivery ? { deliveryKbps: Number(delivery[1]) / 1000 } : {}),
      retrans: number('bytes_retrans') ?? 0 });
  }
  return rows;
}
/** Fixed, authenticated loopback endpoint. Never follow redirects or log its body. */
export function readRtspSessions(password: string | null, signal?: AbortSignal, port = MEDIA_OBSERVER_PORT): Promise<unknown> {
  if (!password) return Promise.reject(new Error('Media feedback is not configured'));
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port,
      path: '/v3/rtspsessions/list?itemsPerPage=256', method: 'GET', signal,
      headers: { authorization: 'Basic ' + Buffer.from(MEDIA_OBSERVER_USER + ':' + password).toString('base64') } },
    response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Media feedback unavailable')); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(new Error('Media feedback response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Media feedback read failed')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid media feedback response')); }
      });
    });
    req.setTimeout(1200, () => req.destroy(new Error('Media feedback timed out')));
    const deadline = setTimeout(() => req.destroy(new Error('Media feedback timed out')), 1500);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', () => reject(new Error('Media feedback unavailable')));
    req.end();
  });
}
export function readTcpDelivery(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ss', ['-tin', 'sport', '=', ':8554'], { timeout: 1000, maxBuffer: MAX_BYTES, signal },
      (error, stdout) => error ? reject(new Error('TCP delivery statistics unavailable')) : resolve(stdout));
  });
}

export interface RtspFeedbackOptions {
  cameras: () => readonly Camera[];
  password: () => string | null;
  report: (report: CameraReport) => void;
  forget: (camera: string, viewer: string) => void;
  blockIncrease?: (camera: string, blocked: boolean) => void;
  clock?: Clock;
  sessions?: (signal?: AbortSignal) => Promise<unknown>;
  tcp?: (signal?: AbortSignal) => Promise<string>;
  localAddresses?: () => readonly string[];
}
/** Observes existing readers only. No media request, speed test, or camera command. */
export class RtspFeedback {
  private readonly clock: Clock;
  private readonly held = new Map<string, Held>();
  private readonly states = new Map<string, RtspFeedbackState>();
  private timer: unknown;
  private abort?: AbortController;
  private stopped = false;
  private busy = false;
  constructor(private readonly opts: RtspFeedbackOptions) { this.clock = opts.clock ?? systemClock; }
  state(camera: string): RtspFeedbackState {
    return this.states.get(camera) ?? this.empty('waiting', 'Waiting for RTSP receiver feedback.');
  }
  private empty(status: RtspFeedbackState['status'], message: string): RtspFeedbackState {
    return { status, message, readers: 0, freshReaders: 0, at: null, loss: null,
      queuedMs: null, discarded: 0, deliveredKbps: null };
  }
  start(): void { if (this.timer !== undefined || this.stopped) return; this.arm(); }
  private arm(): void {
    this.timer = this.clock.setTimer(PERIOD, () => {
      this.timer = undefined;
      void this.poll().catch(() => {}).finally(() => { if (!this.stopped) this.arm(); });
    });
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined; this.abort?.abort();
    for (const held of this.held.values()) this.drop(held);
    this.held.clear();
  }
  private drop(held: Held): void {
    this.opts.forget(held.previous.session.path, 'rtsp/' + held.previous.session.id);
  }
  async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true; this.abort = new AbortController();
    const signal = this.abort.signal;
    let cameras: readonly Camera[] = [];
    try {
      cameras = this.opts.cameras();
      if (!cameras.some(camera => camera.outputs.some(output => output.kind === 'rtsp' && output.enabled))) {
        for (const held of this.held.values()) this.drop(held);
        this.held.clear(); this.states.clear();
        for (const camera of cameras) {
          this.opts.blockIncrease?.(camera.id, false);
          this.states.set(camera.id, this.empty('waiting', 'RTSP feedback requires an enabled RTSP output and a connected player.'));
        }
        return;
      }

      const [body, tcpText] = await Promise.all([
        (this.opts.sessions ?? ((s) => readRtspSessions(this.opts.password(), s)))(signal),
        (this.opts.tcp ?? readTcpDelivery)(signal).catch(() => ''),
      ]);
      if (this.stopped) return;
      const sessions = parseRtspSessions(body), sockets = parseTcpDelivery(tcpText);
      const now = this.clock.now();
      const local = new Set((this.opts.localAddresses?.() ?? Object.values(networkInterfaces())
        .flatMap(items => (items ?? []).map(item => item.address))).map(a => a.replace(/^::ffff:/i, '').split('%')[0]));
      cameras = this.opts.cameras();
      const seen = new Set<string>();
      for (const camera of cameras) {
        const enabled = camera.outputs.some(o => o.kind === 'rtsp' && o.enabled);
        const rows = sessions.filter(s => enabled && s.path === camera.id).filter(s => {
          const host = peerAddress(s.remoteAddr)!.host;
          return host !== '::1' && !host.startsWith('127.') && !local.has(host);
        });
        const state = this.empty('waiting', camera.outputs.some(o => o.kind === 'rtsp' && o.enabled)
          ? 'Waiting for an RTSP player to receive video.'
          : 'RTSP feedback requires an enabled RTSP output and a connected player.');
        state.readers = rows.length;
        for (const row of rows) {
          seen.add(row.id);
          const sample: Sample = { session: row, tcp: sockets.get(peerAddress(row.remoteAddr)!.key), at: now };
          let held = this.held.get(row.id);
          const previous = held?.previous;
          const changed = previous && (row.transport !== previous.session.transport
            || row.path !== previous.session.path || row.remoteAddr !== previous.session.remoteAddr
            || COUNTERS.some(key => row[key] < previous.session[key])
            || (sample.tcp && previous.tcp && sample.tcp.acked < previous.tcp.acked));
          if (!held || !previous || changed || now <= previous.at || now - previous.at > MAX_INTERVAL) {
            if (held) this.drop(held);
            held = { previous: sample, rr: sample, rrEstablished: false,
              loss: 0, lossAt: null }; this.held.set(row.id, held);
            continue;
          }
          const elapsed = now - previous.at;
          const sent = row.outboundRTPPackets - previous.session.outboundRTPPackets;
          const discarded = row.outboundRTPPacketsDiscarded - previous.session.outboundRTPPacketsDiscarded;
          const newRr = row.inboundRTCPPackets > held.rr.session.inboundRTCPPackets;
          const lostSinceReport = row.outboundRTPPacketsReportedLost - held.rr.session.outboundRTPPacketsReportedLost;
          const expectedSinceReport = row.outboundRTPPackets - held.rr.session.outboundRTPPackets
            + row.outboundRTPPacketsDiscarded - held.rr.session.outboundRTPPacketsDiscarded;
          // Misaligned/wrapped cumulative reports cannot describe a loss
          // fraction for this interval. Seed again rather than clamping to 100%.
          const lossWindow = newRr && held.rrEstablished && expectedSinceReport > 0
            && lostSinceReport >= 0 && lostSinceReport <= expectedSinceReport;
          if (lossWindow) {
            held.loss = ratio(lostSinceReport, expectedSinceReport);
            held.lossAt = now;
          } else if (newRr) {
            held.lossAt = null;
          }
          let report: CameraReport | undefined;
          if (row.transport === 'tcp' && sample.tcp && previous.tcp) {
            const delivered = (sample.tcp.acked - previous.tcp.acked) * 8 / elapsed;
            const queued = sample.tcp.notsent ?? Math.max(0, sample.tcp.queue - delivered * sample.tcp.rtt / 8);
            // Average ACK throughput is limited by the offered video rate.
            // Recent kernel delivery rate avoids calling an ordinary keyframe
            // burst sustained congestion on an otherwise underused connection.
            const drain = Math.max(delivered, sample.tcp.deliveryKbps ?? 0);
            const queuedMs = queued > 0 ? delivered > 0 ? queued * 8 / drain : 10_000 : 0;
            // Keepalives without RTP are not video delivery or spare capacity.
            if (sent > 0 || discarded > 0 || sample.tcp.queue > 0) report = {
              camera: camera.id, viewer: 'rtsp/' + row.id, encode: 'stream', at: now,
              rtt: sample.tcp.rtt, loss: lossWindow ? held.loss : 0,
              egress: delivered, capacity: null,
              rtsp: { transport: 'tcp', queuedMs, discarded: ratio(discarded, sent + discarded),
                canIncrease: sent > 0 && delivered > 0, acknowledged: true, lossEvent: lossWindow },
            };
          } else if (lossWindow || discarded > 0) {
            const rr = held.rr;
            const rrSent = row.outboundRTPPackets - rr.session.outboundRTPPackets;
            const rrDiscarded = row.outboundRTPPacketsDiscarded - rr.session.outboundRTPPacketsDiscarded;
            const lost = lossWindow ? row.outboundRTPPacketsReportedLost - rr.session.outboundRTPPacketsReportedLost : 0;
            const loss = ratio(lost, rrSent + rrDiscarded);
            report = { camera: camera.id, viewer: 'rtsp/' + row.id, encode: 'stream', at: now,
              rtt: 0, loss, egress: (row.outboundBytes - rr.session.outboundBytes) * 8 / Math.max(1, now - rr.at) * (1 - loss),
              capacity: null, rtsp: { transport: row.transport, queuedMs: 0,
                discarded: ratio(discarded, sent + discarded), canIncrease: lossWindow && rrSent > 0,
                acknowledged: false, lossEvent: lossWindow } };
          }
          // The first RTCP counter can include pre-observation history. Seed it;
          // never divide that historical total by one new polling interval.
          if (newRr) { held.rr = sample; held.rrEstablished = true; }
          held.previous = sample;
          if (report) { held.lastReport = report; this.opts.report(report); }
          const fresh = held.lastReport && now - held.lastReport.at <= 6000 ? held.lastReport : null;
          if (fresh) {
            state.freshReaders++; state.at = Math.max(state.at ?? 0, fresh.at);
            if (held.lossAt !== null && now - held.lossAt <= 6000) state.loss = Math.max(state.loss ?? 0, held.loss);
            state.queuedMs = Math.max(state.queuedMs ?? 0, fresh.rtsp?.queuedMs ?? 0);
            state.deliveredKbps = Math.min(state.deliveredKbps ?? Infinity, fresh.egress);
          }
          state.discarded += discarded;
        }
        if (state.readers > 0) {
          const complete = state.freshReaders === state.readers;
          state.status = complete ? 'active' : 'limited';
          state.message = complete
            ? 'RTSP feedback is active for ' + state.readers + ' receiver(s).'
            : 'Waiting for fresh delivery feedback from ' + (state.readers - state.freshReaders) + ' RTSP receiver(s); no increase is justified by silence.';
        }
        this.opts.blockIncrease?.(camera.id, state.freshReaders < state.readers);
        this.states.set(camera.id, state);
      }
      for (const [id, held] of this.held) if (!seen.has(id)) { this.drop(held); this.held.delete(id); }
      for (const id of this.states.keys()) if (!cameras.some(c => c.id === id)) this.states.delete(id);
    } catch {
      if (!this.stopped) {
        for (const held of this.held.values()) this.drop(held);
        this.held.clear();
        for (const id of this.states.keys()) this.states.set(id, this.empty('unavailable', 'RTSP feedback is unavailable. Adaptive cannot evaluate this connection.'));
        for (const camera of cameras) {
          this.opts.blockIncrease?.(camera.id, camera.outputs.some(o => o.kind === 'rtsp' && o.enabled));
          this.states.set(camera.id,
            this.empty('unavailable', 'RTSP feedback is unavailable. Adaptive cannot evaluate this connection.'));
        }
      }
    } finally { this.busy = false; this.abort = undefined; }
  }
}
