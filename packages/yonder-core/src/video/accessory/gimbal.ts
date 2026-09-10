// SPDX-License-Identifier: GPL-3.0-or-later
import type { DumlCommand, DumlFrame } from './duml.js';
import type { AccessoryCommandOptions } from './aoa.js';
import { Intent, type IntentAdmitted, type IntentClock, type IntentIssued, type LiveIntent } from './intent.js';
import { guard, type GimbalAttitude, type GuardContext, type GuardReason, type GuardResult, type MotionCommand } from './guard.js';
import { normalizedQuaternion, RotationProgress } from './rotation-progress.js';

/** Leave enough of the unchanged Intent deadline for USB write plus IPC completion. */
const MIN_RATE_DISPATCH_MS = 200;

/** Caller supplies only CRC-validated DUML frames, and the transport's monotonic clock. */
export function decodeGimbalAttitude(frame: DumlFrame, clock: Pick<IntentClock, 'now'>): GimbalAttitude | null {
  if (frame.commandSet !== 4 || frame.commandId !== 5 || frame.sender !== 4 || frame.response
    || frame.payload.length < 11) return null;
  const p = Buffer.from(frame.payload);
  // HG211 captures carry normal status bits 5/7 (0x20/0x80) during proven
  // motion. Preserve faults for unclassified bit 2 and unproven bits 3/4/6.
  return { pitch: p.readInt16LE(0) / 10, roll: p.readInt16LE(2) / 10, yaw: p.readInt16LE(4) / 10,
    mode: (p[6] >> 6) & 3, at: clock.now(), pitchLimit: !!(p[10] & 1), yawLimit: !!(p[10] & 2), fault: !!(p[10] & 0x5c),
    quaternion: p.length >= 40 ? normalizedQuaternion([24,28,32,36].map(offset => p.readFloatLE(offset))) : null };
}
export type MotionRefusal = { accepted: false; reason: GuardReason | 'busy' | 'unavailable' | 'revoked' | 'write-failed' };
export interface GimbalControllerOptions {
  clock: IntentClock;
  context(): GuardContext;
  /** Resolve only when actual transport I/O completes, never merely on enqueue. */
  write(command: Omit<DumlCommand, 'sequence'>, options: AccessoryCommandOptions): Promise<void>;
  onMotionNotice?(notice: string | null): void;
  leaseMs?: number;
}
/** One per camera. R-CAM-11 / R-CMD-04: repeats only fresh operator intent. */
export class GimbalController {
  private readonly intent: Intent;
  private readonly leaseMs: number;
  private timer?: unknown;
  private pending = false;
  private lastCompletedAt = -Infinity;
  private available = true;
  private closed = false;
  private awaitingMode?: { mode: number; after: number; signal: AbortSignal };
  private discrete?: { controller: AbortController; command: Exclude<MotionCommand, { kind: 'rate' }>; deadline: number };
  private readonly progress = new RotationProgress();
  private rateEpoch?: Readonly<{ gesture: string; owner: string; generation: number; mode: number }>;
  private generation = 0;
  private notice: string | null = null;
  private rangeProbe?: { owner: string; gesture: string; until: number };
  get motionNotice(): string | null { return this.notice; }

  constructor(private readonly options: GimbalControllerOptions) {
    this.leaseMs = options.leaseMs ?? 500;
    this.intent = new Intent({ clock: options.clock, leaseMs: this.leaseMs });
  }
  issue(owner: string, clientGesture?: string): IntentIssued | MotionRefusal {
    if (!this.available || this.closed) return { accepted: false, reason: 'unavailable' };
    if (this.discrete) return { accepted: false, reason: 'busy' };
    const reply = this.intent.issue(owner, clientGesture);
    if (reply.accepted) { this.rangeProbe = undefined; this.rateEpoch = undefined; this.progress.reset(); this.setNotice(null); }
    return reply;
  }
  /** Unix-socket bench operation, not a saved policy or a browser control.
   * DJI OSDK bit 2 is under investigation on HG211. A probe is single-axis,
   * <=3 degrees/s and <=2 seconds; ordinary issues always retain flags 0x80. */
  issueRangeProbe(owner: string, clientGesture: string): IntentIssued | MotionRefusal {
    const reply = this.issue(owner, clientGesture);
    if (reply.accepted) this.rangeProbe = { owner, gesture: reply.grant.gesture, until: this.options.clock.now() + 2000 };
    return reply;
  }
  admit(owner: string, request: unknown): IntentAdmitted | MotionRefusal {
    if (!this.available || this.closed) return { accepted: false, reason: 'unavailable' };
    if (this.discrete) return { accepted: false, reason: 'busy' };
    const result = this.intent.admit(owner, request);
    if (!result.accepted) return result;
    const live = this.intent.live();
    if (!live) { this.clearTimer(); return result; }
    if (this.rangeProbe && (Math.hypot(live.rate.pan, live.rate.tilt) > 3 || (live.rate.pan !== 0 && live.rate.tilt !== 0))) {
      this.reset(); return { accepted: false, reason: 'rate-cap' };
    }
    const effective = quantizedRate(live.rate);
    if (!effective.pan && !effective.tilt) { this.reset(); return { accepted: true, next: null }; }
    const verdict = this.check({ kind: 'rate', ...live.rate });
    if (!verdict.allowed) { this.intent.reset(); this.clearTimer(); return { accepted: false, reason: verdict.reason }; }
    if (!this.rateEpoch || this.rateEpoch.gesture !== live.gesture) {
      this.progress.reset();
      this.rateEpoch = Object.freeze({ gesture: live.gesture, owner: live.owner, generation: this.generation, mode: this.options.context().attitude!.mode });
    }
    live.signal.addEventListener('abort', () => this.clearTimer(), { once: true });
    this.pump();
    if (!this.intent.live()) return { accepted: false, reason: 'revoked' };
    return result;
  }
  end(owner: string, gesture: string): void {
    this.intent.end(owner, gesture);
    if (this.rangeProbe?.owner === owner && this.rangeProbe.gesture === gesture) this.rangeProbe = undefined;
  }
  /** Call on every attitude/configuration update, including a malformed attitude push. */
  refresh(): void {
    if (this.rangeProbe && this.options.clock.now() >= this.rangeProbe.until) { this.reset(); return; }
    if (this.discrete) this.discreteAdmission(this.discrete);
    const live = this.intent.live();
    if (live) this.rateAdmission(live);
    else if (this.rateEpoch) {
      // Between one expired rate and its still-fresh next credential, camera
      // faults/limits/mode changes must retire the gesture too. A later clear
      // report cannot revive it without a new operator press.
      const verdict = this.check({ kind: 'rate', pan: 0.1, tilt: 0 });
      if (!verdict.allowed || this.options.context().attitude?.mode !== this.rateEpoch.mode) this.reset();
    }
  }
  reset(): void {
    this.clearTimer(); this.intent.reset();
    this.rangeProbe = undefined;
    this.rateEpoch = undefined; this.progress.reset(); this.generation++;
    this.discrete?.controller.abort(); this.discrete = undefined;
  }
  disconnect(): void { this.available = false; this.awaitingMode = undefined; this.reset(); this.setNotice(null); }
  /** Fresh transport traffic permits new operator gestures; it originates no command. */
  connect(): void { if (!this.closed) this.available = true; }
  close(): void { this.closed = true; this.disconnect(); }

  async action(owner: string, command: Exclude<MotionCommand, { kind: 'rate' }>): Promise<{ accepted: true } | MotionRefusal | Exclude<IntentIssued, { accepted: true }>> {
    if (!this.available || this.closed) return { accepted: false, reason: 'unavailable' };
    if (this.discrete) return { accepted: false, reason: 'busy' };
    // issue enforces owner conflict even for a grant with no admitted rate, and
    // invalidates the owner's current gesture before guard evaluation or writing.
    if (!command || !['mode', 'recentre'].includes(command.kind)) return { accepted: false, reason: 'malformed-command' };
    const reserved = this.intent.issue(owner);
    if (!reserved.accepted) return reserved;
    this.clearTimer();
    const verdict = this.check(command);
    if (!verdict.allowed || this.pending) {
      this.intent.reset();
      return { accepted: false, reason: verdict.allowed ? 'busy' : verdict.reason };
    }
    const action = { controller: new AbortController(), command: { ...command }, deadline: reserved.grant.deadline };
    this.discrete = action;
    this.watchAction(action);
    // Recentre's measured 02 01 payload also transitions to Follow mode 2.
    const targetMode = command.kind === 'mode' ? command.mode : 2;
    const wire = this.wire(command);
    this.pending = true;
    try {
      await this.options.write(wire, { signal: action.controller.signal, deadline: action.deadline, admission: () => {
        if (!this.discreteAdmission(action)) return false;
        // A successful arbiter admission may precede endpoint admission. From
        // this point dispatch is possible, so cancellation must retain the
        // interlock. Each later admission refreshes the readback cutoff;
        // refresh/watchdog checks do not establish or move it.
        this.awaitingMode = { mode: targetMode, after: this.options.clock.now(), signal: action.controller.signal };
        return true;
      } });
      return action.controller.signal.aborted ? { accepted: false, reason: 'revoked' } : { accepted: true };
    } catch {
      if (!action.controller.signal.aborted) this.disconnect();
      return { accepted: false, reason: 'write-failed' };
    } finally {
      this.pending = false;
      if (this.discrete === action) this.reset();
    }
  }
  private check(command: MotionCommand, signal?: AbortSignal): GuardResult {
    const context = { ...this.options.context(), now: this.options.clock.now() };
    // Only the original discrete command may pass its own unresolved transition.
    const ownTransition = this.awaitingMode !== undefined && this.awaitingMode.signal === signal;
    if (this.awaitingMode && !ownTransition) {
      if (context.attitude?.mode !== this.awaitingMode.mode || context.attitude.at <= this.awaitingMode.after) {
        return { allowed: false, reason: 'mode-unobserved' };
      }
    }
    if (command.kind === 'rate' && context.intentAllowanceMs < this.leaseMs) return { allowed: false, reason: 'stop-allowance-unknown' };
    const verdict = guard(command, context);
    if (verdict.allowed && !ownTransition) this.awaitingMode = undefined;
    return verdict;
  }
  private rateAdmission(live: LiveIntent): boolean {
    if (!this.available || this.closed || !live.isValid() || this.intent.live() !== live) return false;
    if (this.rangeProbe && (this.rangeProbe.owner !== live.owner || this.rangeProbe.gesture !== live.gesture
      || this.options.clock.now() >= this.rangeProbe.until)) { this.reset(); return false; }
    if (!this.check({ kind: 'rate', ...live.rate }).allowed) { this.intent.reset(); this.clearTimer(); return false; }
    const epoch = this.rateEpoch, context = this.options.context();
    if (!epoch || epoch.generation !== this.generation) return false;
    if (context.attitude!.mode !== epoch.mode) {
      this.cancelMotion('Gimbal mode changed; release and start a new gesture.'); return false;
    }
    const notice = this.progress.observe(epoch, context.attitude!, this.options.clock.now());
    if (notice) { this.cancelMotion(notice); return false; }
    return true;
  }
  private setNotice(notice: string | null): void {
    this.notice = notice; this.options.onMotionNotice?.(notice);
  }
  private cancelMotion(notice: string): void { this.reset(); this.setNotice(notice); }
  private discreteAdmission(action: NonNullable<GimbalController['discrete']>): boolean {
    if (this.discrete !== action || action.controller.signal.aborted) return false;
    if (!this.available || this.closed || this.options.clock.now() >= action.deadline || !this.check(action.command, action.controller.signal).allowed) {
      this.reset(); return false;
    }
    return true;
  }
  private pump(): void {
    this.clearTimer();
    const live = this.intent.live();
    if (!live || !this.rateAdmission(live)) return;
    // A skipped end-of-lease repeat is not a transport failure. A renewal
    // invokes pump again with the next credential's original deadline.
    if (!this.hasDispatchBudget(live)) return;
    const now = this.options.clock.now();
    if (!this.pending && now - this.lastCompletedAt >= 100) {
      this.pending = true;
      // Keep the original view's expiry, abort signal and physical admission all
      // the way through Pocket2Device's serialized queue to actual dispatch.
      void this.writeRate(live);
    }
    if (live.signal.aborted) return;
    const cadence = now - this.lastCompletedAt >= 100 ? 100 : 100 - (now - this.lastCompletedAt);
    this.timer = this.options.clock.setTimer(Math.max(1, Math.min(cadence, this.freshFor())), () => this.pump());
  }
  private async writeRate(live: LiveIntent): Promise<void> {
    const epoch = this.rateEpoch;
    let budgetRefused = false;
    try {
      const probe = this.rangeProbe;
      await this.options.write(this.wire({ kind: 'rate', ...live.rate }, probe ? 0x84 : 0x80), {
        signal: live.signal, deadline: Math.min(live.expiresAt, probe?.until ?? Infinity), admission: () => {
          // Recheck after any writer queue delay. Keep this local flag apart
          // from arbitrary endpoint errors, which still disconnect below.
          if (!live.isValid() || this.intent.live() !== live) return false;
          if (!this.hasDispatchBudget(live)) { budgetRefused = true; return false; }
          return this.rateAdmission(live);
        },
      });
      // Promise completion is actual endpoint completion, not admission/enqueue.
      // Renewal preserves the gesture epoch; release, reset and mode/source
      // changes do not. A late canceled write cannot seed any later window.
      if (epoch && this.rateEpoch === epoch && epoch.generation === this.generation && !live.signal.aborted && live.isValid()) {
        const context = this.options.context();
        this.progress.completed(epoch, quantizedRate(live.rate), this.options.clock.now(), context.attitude?.at ?? this.options.clock.now(), context.deviceStopAllowanceMs);
      }
    } catch {
      if (!budgetRefused && !live.signal.aborted) this.disconnect();
    } finally {
      // Enqueue can precede actual transport dispatch by an arbitrary delay.
      // Waiting after completion conservatively preserves the wire cadence.
      this.lastCompletedAt = this.options.clock.now();
      this.pending = false;
    }
  }
  private hasDispatchBudget(live: LiveIntent): boolean {
    return Math.min(live.expiresAt, this.rangeProbe?.until ?? Infinity) - this.options.clock.now() >= Math.min(MIN_RATE_DISPATCH_MS, this.leaseMs);
  }
  private watchAction(action: NonNullable<GimbalController['discrete']>): void {
    this.clearTimer();
    this.timer = this.options.clock.setTimer(Math.max(1, Math.min(action.deadline - this.options.clock.now(), this.freshFor())), () => {
      if (this.discreteAdmission(action)) this.watchAction(action);
    });
  }
  private freshFor(): number {
    const c = this.options.context();
    return c.attitude ? c.attitude.at + c.attitudeMaxAgeMs - this.options.clock.now() : 0;
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.options.clock.clearTimer(this.timer);
    this.timer = undefined;
  }
  private wire(command: MotionCommand, rateFlags: 0x80 | 0x84 = 0x80): Omit<DumlCommand, 'sequence'> {
    const common = { receiver: 4, commandSet: 4, ack: 0 };
    if (command.kind === 'recentre') return { ...common, commandId: 0x4c, payload: Buffer.from([2, 1]) };
    if (command.kind === 'mode') return { ...common, commandId: 0x44, payload: Buffer.from([command.mode]) };
    const payload = Buffer.alloc(7);
    // Truncate toward zero so quantization cannot exceed the guarded speed.
    payload.writeInt16LE(Math.trunc(command.pan * 10), 0);
    payload.writeInt16LE(Math.trunc(command.tilt * 10), 4);
    payload[6] = rateFlags;
    return { ...common, commandId: 0x0c, payload };
  }
}
function quantizedRate(rate: { pan: number; tilt: number }): { pan: number; tilt: number } {
  return { pan: Math.trunc(rate.pan * 10) / 10, tilt: Math.trunc(rate.tilt * 10) / 10 };
}
