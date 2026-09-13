// SPDX-License-Identifier: GPL-3.0-or-later
import { expireCameraSession } from './camera-session.js';
import { screenToCamera, screenRollToCamera, aimFailure } from './aim-response.js';
type AimRate = { pan: number; tilt: number; roll?: number };
export interface AimTarget {
  url?: string; generation?: number; inhibited?: string | null; maxRate?: number; imageDirection?: string; mode?: string | null;
  rollControl?: { available: boolean; reason: string | null; maxRate: number };
}
function withinRate(target: AimTarget, rate: AimRate): boolean {
  const limit = target.maxRate === undefined ? 10 : target.maxRate;
  const roll = rate.roll ?? 0;
  if (!Number.isFinite(roll)) return false;
  if (roll !== 0 && (!target.rollControl?.available || rate.pan !== 0 || rate.tilt !== 0
    || !Number.isFinite(target.rollControl.maxRate) || target.rollControl.maxRate <= 0
    || Math.abs(roll) > target.rollControl.maxRate)) return false;
  return Number.isFinite(limit) && limit > 0 && [rate.pan, rate.tilt].every(Number.isFinite)
    && Math.hypot(rate.pan, rate.tilt, roll) <= Math.min(limit, 120);
}
type Grant = { gesture: string; credential: string; deadline: number };
type Held = AimRate & { client: string; target: string; generation?: number; mode?: string | null; imageDirection: string; grant?: Grant; seq: number;
  preset?: {slot:number;revision:number;maxRate:number} };
export type RecallState = {slot:number;state:'moving'|'reached';name?:string}|null;
let recallSerial=0;
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
    private readonly changed: (rate: AimRate, reason: string | null) => void = () => {},
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly recallChanged: (state:RecallState)=>void = () => {}) {
    if (typeof window !== 'undefined') { window.addEventListener('blur', this.blur); window.addEventListener('offline', this.blur); document.addEventListener('visibilitychange', this.lost); }
  }
  update(rate: AimRate & { gesture: string }): void {
    if (this.disposed || this.blocked === rate.gesture) return;
    const target = this.target();
    const axes = screenToCamera(rate, target?.imageDirection);
    const roll = rate.roll === undefined ? undefined : screenRollToCamera(rate.roll, target?.imageDirection);
    const mapped = axes && roll !== null ? { ...axes, ...(roll === undefined ? {} : { roll }) } : null;
    if (!target?.url || target.inhibited || !mapped || !withinRate(target, mapped)
      || ![mapped.pan, mapped.tilt, mapped.roll ?? 0].some(v => Math.trunc(v * 10) !== 0)) { this.stop(); this.blocked = rate.gesture; return; }
    if (this.held?.client !== rate.gesture) {
      this.stop();
      this.held = { client: rate.gesture, ...mapped, target: target.url, generation: target.generation, mode: target.mode, imageDirection: target.imageDirection ?? 'identity', seq: 0 };
    } else { this.held.pan = mapped.pan; this.held.tilt = mapped.tilt; this.held.roll = mapped.roll; }
    if (!this.pending && !this.timer) void this.tick();
  }
  recall(slot:number,revision:number,maxRate:number):void {
    this.stop();const target=this.target();
    if(this.disposed || !target?.url || target.inhibited || !Number.isInteger(slot) || slot<1 || slot>6
      || !Number.isSafeInteger(revision) || revision<0 || !Number.isFinite(maxRate) || maxRate<1)return;
    this.held={client:`preset-${Date.now().toString(36)}-${++recallSerial}`,pan:0,tilt:0,target:target.url,
      generation:target.generation,mode:target.mode,imageDirection:target.imageDirection??'identity',seq:0,preset:{slot,revision,maxRate:Math.min(60,maxRate)}};
    this.recallChanged({slot,state:'moving'});
    if(!this.pending && !this.timer)void this.tick();
  }
  refresh(): void { if (this.held && !this.current(this.held)) this.stop(); }
  private current(held: Held): boolean {
    const target = this.target();
    return !this.disposed && this.held === held && !!target && !target.inhibited && target.url === held.target
      && target.generation === held.generation && (target.imageDirection ?? 'identity') === held.imageDirection
      && target.mode === held.mode
      && withinRate(target, held) && !(typeof document !== 'undefined' && document.hidden);
  }
  private async request(url: string, body: object): Promise<any> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 450);
    try {
      const response = await this.fetcher(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Yonder-Aim': '1' }, body: JSON.stringify(body) });
      if (response.status === 401) expireCameraSession();
      if (!response.ok) throw new Error(`Aim request failed (${response.status})`);
      const reply = await response.json();
      if (!reply?.accepted) throw new Error(aimFailure(reply?.reason ?? 'Camera movement was refused'));
      return reply;
    } finally { clearTimeout(timeout); }
  }
  private async tick(): Promise<void> {
    this.timer = undefined; const held = this.held;
    if (this.pending || !held || !this.current(held)) { if (held && !this.current(held)) this.stop(); return; }
    this.pending = true;
    try {
      if (!held.grant) {
        const reply = await this.request(held.target, held.preset ? {op:'issue-recall',clientGesture:held.client,...held.preset} : { op: 'issue', clientGesture: held.client });
        if (!this.current(held)) { if (reply.grant?.gesture) this.endRemote(held.target, reply.grant.gesture); return; }
        held.grant = reply.grant;
        if (!held.grant) throw new Error('Aim grant missing');
      }
      if (this.current(held)) {
        // Sample after the preceding response, never retain an old queued rate.
        const sent = { pan: held.pan, tilt: held.tilt, ...(held.roll === undefined ? {} : { roll: held.roll }) };
        this.nextRequestAt = performance.now() + 100;
        const reply = await this.request(held.target, held.preset ? {op:'recall',...held.grant,seq:++held.seq} : { op: 'slew', ...held.grant, seq: ++held.seq, ...sent });
        if (!this.current(held)) return;
        if(held.preset && reply.arrived){this.stop();this.recallChanged({slot:held.preset.slot,state:'reached',name:reply.name});return;}
        if(held.preset)this.recallChanged({slot:held.preset.slot,state:'moving',name:reply.name});
        held.grant = reply.next;
        if (!held.grant) { this.stop(); return; }
        this.changed(held.preset && reply.rate ? reply.rate : sent, null);
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
    this.recallChanged(null);
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
