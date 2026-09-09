// SPDX-License-Identifier: GPL-3.0-or-later
export interface AimTarget { url?: string; generation?: number; inhibited?: string | null }
type Grant = { gesture: string; credential: string; deadline: number };
type Held = { client: string; pan: number; tilt: number; target: string; generation?: number; grant?: Grant; seq: number };
/** Current held gesture only. No retry, backlog, wall-clock deadline, or reconnect resume. */
export class AimTransport {
  private held?: Held;
  private blocked?: string;
  private pending = false;
  private ending?: { url: string; gesture: string };
  private timer?: ReturnType<typeof setTimeout>;
  private nextRequestAt = 0;
  private disposed = false;
  private readonly lost = () => { if (typeof document === 'undefined' || document.hidden) this.stop(); };
  private readonly blur = () => this.stop();
  constructor(private readonly target: () => AimTarget | null | undefined,
    private readonly changed: (rate: { pan: number; tilt: number }, reason: string | null) => void = () => {},
    private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {
    if (typeof window !== 'undefined') { window.addEventListener('blur', this.blur); window.addEventListener('offline', this.blur); document.addEventListener('visibilitychange', this.lost); }
  }
  update(rate: { gesture: string; pan: number; tilt: number }): void {
    if (this.disposed || this.blocked === rate.gesture) return;
    const target = this.target();
    if (!target?.url || target.inhibited || ![rate.pan, rate.tilt].every(v => Number.isFinite(v) && Math.abs(v) <= 10)
      || (!rate.pan && !rate.tilt)) { this.stop(); this.blocked = rate.gesture; return; }
    if (this.held?.client !== rate.gesture) {
      this.stop();
      this.held = { client: rate.gesture, pan: rate.pan, tilt: rate.tilt, target: target.url, generation: target.generation, seq: 0 };
    } else { this.held.pan = rate.pan; this.held.tilt = rate.tilt; }
    if (!this.pending && !this.timer) void this.tick();
  }
  refresh(): void { if (this.held && !this.current(this.held)) this.stop(); }
  private current(held: Held): boolean {
    const target = this.target();
    return !this.disposed && this.held === held && !!target && !target.inhibited && target.url === held.target
      && target.generation === held.generation && !(typeof document !== 'undefined' && document.hidden);
  }
  private async request(url: string, body: object): Promise<any> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 450);
    try {
      const response = await this.fetcher(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Yonder-Aim': '1' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Aim request failed (${response.status})`);
      const reply = await response.json();
      if (!reply?.accepted) throw new Error(reply?.reason ?? 'Aim refused');
      return reply;
    } finally { clearTimeout(timeout); }
  }
  private async tick(): Promise<void> {
    this.timer = undefined; const held = this.held;
    if (this.pending || !held || !this.current(held)) { if (held && !this.current(held)) this.stop(); return; }
    this.pending = true;
    try {
      if (!held.grant) {
        const reply = await this.request(held.target, { op: 'issue', clientGesture: held.client });
        if (!this.current(held)) { if (reply.grant?.gesture) this.endRemote(held.target, reply.grant.gesture); return; }
        held.grant = reply.grant;
        if (!held.grant) throw new Error('Aim grant missing');
      }
      if (this.current(held)) {
        // Sample after the preceding response, never retain an old queued rate.
        const sent = { pan: held.pan, tilt: held.tilt };
        this.nextRequestAt = performance.now() + 100;
        const reply = await this.request(held.target, { op: 'slew', ...held.grant, seq: ++held.seq, ...sent });
        if (!this.current(held)) return;
        held.grant = reply.next;
        if (!held.grant) { this.stop(); return; }
        this.changed(sent, null);
      }
    } catch (error) {
      if (this.held === held) { this.stop(); this.changed({ pan: 0, tilt: 0 }, error instanceof Error ? error.message : 'Aim transport failed'); }
    } finally {
      this.finished();
    }
  }
  private finished(): void {
    this.pending = false;
    const ending = this.ending; this.ending = undefined;
    if (ending) { this.endRemote(ending.url, ending.gesture); return; }
    if (this.held && this.current(this.held)) this.timer = setTimeout(() => void this.tick(), Math.max(0, this.nextRequestAt - performance.now()));
  }
  private endRemote(url: string, gesture: string): void {
    // A termination marker is the only deferred message. No rate or action is queued.
    // Intent's original deadline still expires while an outstanding request settles.
    if (this.pending) { this.ending = { url, gesture }; return; }
    this.pending = true;
    void this.request(url, { op: 'stop', gesture }).catch(() => {}).finally(() => this.finished());
  }
  stop(send = true): void {
    clearTimeout(this.timer); this.timer = undefined;
    const held = this.held; this.held = undefined;
    if (held) { this.blocked = held.client; if (send && held.grant) this.endRemote(held.target, held.grant.gesture); }
    this.changed({ pan: 0, tilt: 0 }, null);
  }
  async action(command: { op: 'recentre' } | { op: 'mode'; mode: number }): Promise<void> {
    if (this.pending) { this.stop(); this.changed({ pan: 0, tilt: 0 }, 'Aim request still pending; press again after it settles'); return; }
    this.stop(false); const target = this.target(); if (!target?.url || this.disposed) return;
    this.pending = true;
    try { await this.request(target.url, command); }
    catch (error) { this.changed({ pan: 0, tilt: 0 }, error instanceof Error ? error.message : 'Aim refused'); }
    finally { this.finished(); }
  }
  close(): void {
    this.stop(); this.disposed = true;
    if (typeof window !== 'undefined') { window.removeEventListener('blur', this.blur); window.removeEventListener('offline', this.blur); document.removeEventListener('visibilitychange', this.lost); }
  }
}
