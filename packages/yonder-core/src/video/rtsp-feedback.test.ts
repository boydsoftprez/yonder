// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { RtspFeedback, parseRtspSessions, parseTcpDelivery, peerAddress, readRtspSessions } from './rtsp-feedback.js';
import { ConfigSchema } from '../schema/config.js';
import type { CameraReport } from './viewers.js';
const camera = ConfigSchema.parse({ version: 1, network: { ap: { psk: { secret: 'ap_psk' } } },
  ui: { editor: {} }, cameras: [{ id: 'cam0', name: 'Camera', source: 'usb', device: 'usb-1',
    outputs: [{ kind: 'rtsp', enabled: true, password: { secret: 'rtsp_password' } }] }] }).cameras[0];
const id = '11111111-1111-1111-1111-111111111111';
function session(over: Record<string, unknown> = {}) {
  return { id, path: 'cam0', state: 'read', remoteAddr: '10.0.0.2:45000', transport: 'TCP',
    outboundBytes: 0, outboundRTPPackets: 0, outboundRTPPacketsReportedLost: 0,
    outboundRTPPacketsDiscarded: 0, inboundRTCPPackets: 0, ...over };
}
function tcp(acked: number, queue = 0, notsent = 0) {
  return 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n'
    + 'ESTAB 0 ' + queue + ' [::ffff:10.0.0.1]:8554 [::ffff:10.0.0.2]:45000\n'
    + ' cubic rtt:70.25/10.2 bytes_acked:' + acked + ' bytes_retrans:10 mss:2748 notsent:' + notsent;
}
function bench(transport = 'TCP') {
  let now = 0, rows: unknown[] = [session({ transport })], text = tcp(0);
  let fail = false;
  const reports: CameraReport[] = [], forget = vi.fn(), block = vi.fn();
  const source = new RtspFeedback({ cameras: () => [camera], password: () => 'private',
    report: r => reports.push(r), forget, blockIncrease: block,
    clock: { now: () => now, setTimer: () => 1, clearTimer: () => {} },
    sessions: async () => { if (fail) throw new Error('credential must not escape'); return { items: rows }; },
    tcp: async () => text, localAddresses: () => ['127.0.0.1', '10.0.0.1'] });
  return { source, reports, forget, block,
    set: (time: number, items: unknown[], socket = text) => { now = time; rows = items; text = socket; },
    fail: () => { fail = true; } };
}
describe('RTSP receiver evidence', () => {
  it('uses acknowledged TCP delivery and queued bytes rather than the requested bitrate', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session({ outboundBytes: 200000, outboundRTPPackets: 200 })], tcp(100000, 60000, 40000));
    await b.source.poll();
    expect(b.reports).toHaveLength(1);
    expect(b.reports[0]).toMatchObject({ camera: 'cam0', encode: 'stream', capacity: null, egress: 800,
      rtsp: { transport: 'tcp', queuedMs: 400, acknowledged: true } });
    expect(b.source.state('cam0')).toMatchObject({ status: 'active', readers: 1, freshReaders: 1 });
  });
  it('reports a stalled TCP writer as congestion even when no bytes are acknowledged', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session({ outboundRTPPackets: 5 })], tcp(0, 200000, 190000)); await b.source.poll();
    expect(b.reports[0]).toMatchObject({ egress: 0, rtsp: { queuedMs: 10000, canIncrease: false } });
  });
  it('uses recent kernel delivery for a burst instead of mistaking the offered rate for capacity', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session({ outboundRTPPackets: 100 })], tcp(100000, 60000, 40000) + ' delivery_rate 8000000bps');
    await b.source.poll();
    expect(b.reports[0].egress).toBe(800);
    expect(b.reports[0].rtsp?.queuedMs).toBe(40);
  });
  it('seeds historical RTCP totals and emits each new TCP loss window only once', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session({ outboundRTPPackets: 100, inboundRTCPPackets: 1, outboundRTPPacketsReportedLost: 60000 })], tcp(100000));
    await b.source.poll(); expect(b.reports[0].loss).toBe(0); expect(b.source.state('cam0').loss).toBeNull();
    b.set(2000, [session({ outboundRTPPackets: 200, inboundRTCPPackets: 2, outboundRTPPacketsReportedLost: 60002 })], tcp(200000));
    await b.source.poll(); expect(b.reports[1]).toMatchObject({loss:0.02,rtsp:{lossEvent:true}});
    b.set(3000, [session({ outboundRTPPackets: 300, inboundRTCPPackets: 2, outboundRTPPacketsReportedLost: 60002 })], tcp(300000));
    await b.source.poll(); expect(b.reports[2].loss).toBe(0); expect(b.source.state('cam0').loss).toBe(0.02);
    b.set(8001, [session({ outboundRTPPackets: 400, inboundRTCPPackets: 2, outboundRTPPacketsReportedLost: 60002 })], tcp(400000));
    await b.source.poll(); expect(b.source.state('cam0').loss).toBeNull();
  });
  it('does not use keepalives as healthy video', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session()], tcp(300)); await b.source.poll();
    expect(b.reports).toHaveLength(0); expect(b.block).toHaveBeenLastCalledWith('cam0', true);
  });
  it('waits for actual UDP receiver reports and does not re-date old ones', async () => {
    const b = bench('UDP'); await b.source.poll();
    b.set(1000, [session({ transport: 'UDP', outboundBytes: 100000, outboundRTPPackets: 100 })]);
    await b.source.poll(); expect(b.reports).toHaveLength(0);
    const row = session({ transport: 'UDP', outboundBytes: 500000, outboundRTPPackets: 500,
      inboundRTCPPackets: 1, outboundRTPPacketsReportedLost: 10 });
    b.set(5000, [row]); await b.source.poll(); expect(b.reports).toHaveLength(0);
    b.set(10000, [{...row,outboundBytes:1000000,outboundRTPPackets:1000,inboundRTCPPackets:2,outboundRTPPacketsReportedLost:20}]); await b.source.poll();
    expect(b.reports[0]).toMatchObject({ at: 10000, loss: 0.02, capacity: null, rtsp: { acknowledged: false } });
    b.set(11000, [{...row,outboundBytes:1000000,outboundRTPPackets:1000,inboundRTCPPackets:2,outboundRTPPacketsReportedLost:20}]); await b.source.poll();
    expect(b.reports).toHaveLength(1); expect(b.source.state('cam0').at).toBe(10000);
    b.set(17000, [{...row,outboundBytes:1000000,outboundRTPPackets:1000,inboundRTCPPackets:2,outboundRTPPacketsReportedLost:20}]); await b.source.poll();
    expect(b.source.state('cam0')).toMatchObject({ status: 'limited', freshReaders: 0 });
    expect(b.block).toHaveBeenLastCalledWith('cam0', true);
  });
  it('reacts to server discards before the next UDP receiver report', async () => {
    const b = bench('UDP'); await b.source.poll();
    b.set(1000, [session({ transport: 'UDP', outboundRTPPackets: 90, outboundRTPPacketsDiscarded: 10 })]);
    await b.source.poll();
    expect(b.reports[0].rtsp).toMatchObject({ discarded: 0.1, canIncrease: false });
  });
  it('excludes local readers, publishers, and preview paths from main-stream feedback', async () => {
    const b = bench(); b.set(0, [
      session({ remoteAddr: '127.0.0.1:1234' }), session({ remoteAddr: '[::1]:1234' }),
      session({ remoteAddr: '[::ffff:127.0.0.1]:1234' }), session({ remoteAddr: '10.0.0.1:1234' }),
      session({ state: 'publish' }), session({ path: 'cam0-preview' }),
    ]);
    await b.source.poll(); b.set(1000, []); await b.source.poll();
    expect(b.reports).toHaveLength(0); expect(b.source.state('cam0').readers).toBe(0);
  });
  it('keeps independent receiver identities and prevents increases with incomplete evidence', async () => {
    const b = bench(); const second = session({ id: '22222222-2222-2222-2222-222222222222', remoteAddr: '10.0.0.3:45000' });
    b.set(0, [session(), second]); await b.source.poll();
    b.set(1000, [session({ outboundRTPPackets: 10 }), second], tcp(1000)); await b.source.poll();
    expect(b.source.state('cam0')).toMatchObject({ readers: 2, freshReaders: 1, status: 'limited' });
    expect(b.block).toHaveBeenLastCalledWith('cam0', true);
  });
  it('forgets departed readers and counter resets rather than inventing loss', async () => {
    const b = bench(); b.set(0, [session({ outboundBytes: 1000 })]); await b.source.poll();
    b.set(1000, [session()], tcp(100)); await b.source.poll();
    expect(b.reports).toHaveLength(0); expect(b.forget).toHaveBeenCalledWith('cam0', 'rtsp/' + id);
    b.set(2000, []); await b.source.poll(); expect(b.source.state('cam0').readers).toBe(0);
  });
  it('withdraws evidence and shows unavailable when the collector fails', async () => {
    const b = bench(); await b.source.poll(); b.fail(); await b.source.poll();
    expect(b.source.state('cam0').status).toBe('unavailable');
    expect(JSON.stringify(b.source.state('cam0'))).not.toContain('credential');
    expect(b.forget).toHaveBeenCalled(); expect(b.block).toHaveBeenLastCalledWith('cam0', true);
  });
  it('contains a configuration-read failure rather than rejecting its timer task', async () => {
    let fail = false;
    const source = new RtspFeedback({ cameras: () => { if (fail) throw Error('bad configuration'); return [camera]; },
      password: () => '', report: vi.fn(), forget: vi.fn(), sessions: async () => ({items:[]}), tcp: async () => '' });
    await source.poll(); fail = true;
    await expect(source.poll()).resolves.toBeUndefined();
    expect(source.state('cam0').status).toBe('unavailable');
  });
  it('rejects a loss window whose cumulative delta exceeds all packets in that interval', async () => {
    const b = bench(); await b.source.poll();
    b.set(1000, [session({ outboundRTPPackets: 100, inboundRTCPPackets: 1 })], tcp(100000)); await b.source.poll();
    b.set(2000, [session({ outboundRTPPackets: 200, inboundRTCPPackets: 2, outboundRTPPacketsReportedLost: 10000 })], tcp(200000)); await b.source.poll();
    expect(b.reports.at(-1)?.loss).toBe(0);
    expect(b.reports.at(-1)?.rtsp?.lossEvent).toBe(false);
    expect(b.source.state('cam0').loss).toBeNull();
  });
  it('does not turn an older media-server response into zero-loss feedback', () => {
    const { outboundRTPPacketsReportedLost: _lost, ...old } = session();
    expect(() => parseRtspSessions({ items: [old] })).toThrow();
    expect(() => parseRtspSessions({ items: [], pageCount: 2 })).toThrow();
  });
  it('stops pending work and never publishes after shutdown', async () => {
    let finish!: (x: unknown) => void;
    const report = vi.fn();
    const source = new RtspFeedback({ cameras: () => [camera], password: () => '', report, forget: vi.fn(),
      sessions: () => new Promise(resolve => { finish = resolve; }), tcp: async () => '' });
    const pending = source.poll(); source.stop(); finish({ items: [session()] }); await pending;
    expect(report).not.toHaveBeenCalled();
  });
});
describe('bounded private reads', () => {
  it('normalizes IPv4, IPv6 and mapped addresses while rejecting malformed peers', () => {
    expect(peerAddress('[::ffff:10.0.0.2]:1234')?.key).toBe('10.0.0.2:1234');
    expect(peerAddress('[2001:db8::1]:1234')?.host).toBe('2001:db8::1');
    expect(peerAddress('example.com:1234')).toBeNull();
    expect(peerAddress('10.0.0.2:70000')).toBeNull();
    expect(parseTcpDelivery(tcp(100)).get('10.0.0.2:45000')?.rtt).toBe(70.25);
  });
  it('reads only the fixed metadata route, authenticates, and refuses redirects', async () => {
    const seen: string[] = []; let redirect = false;
    const server = createServer((req, res) => {
      seen.push(req.url || ''); expect(req.headers.authorization).toBe('Basic ' + Buffer.from('yonder-observer:secret').toString('base64'));
      if (redirect) { res.writeHead(302, { location: 'http://example.com/' }); res.end(); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [] })); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await readRtspSessions('secret', undefined, port)).toEqual({ items: [] });
      redirect = true; await expect(readRtspSessions('secret', undefined, port)).rejects.toThrow('unavailable');
      expect(seen).toEqual(['/v3/rtspsessions/list?itemsPerPage=256', '/v3/rtspsessions/list?itemsPerPage=256']);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('has an absolute deadline even when a server keeps trickling response bytes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200); res.write(' ');
      const timer = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await expect(readRtspSessions('secret', undefined, (server.address() as {port:number}).port)).rejects.toThrow('unavailable');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 4000);
});
