// SPDX-License-Identifier: GPL-3.0-or-later
import type { DumlCommand, DumlFrame } from './duml.js';
import type { AccessoryCommandOptions } from './aoa.js';
import { Intent, type IntentAdmitted, type IntentClock, type IntentIssued, type LiveIntent } from './intent.js';
import { guard, type GimbalAttitude, type GuardContext, type GuardReason, type GuardResult, type MotionCommand } from './guard.js';

/** Caller supplies only CRC-validated DUML frames, and the transport's monotonic clock. */
export function decodeGimbalAttitude(frame: DumlFrame, clock: Pick<IntentClock, 'now'>): GimbalAttitude | null {
  if (frame.commandSet !== 4 || frame.commandId !== 5 || frame.sender !== 4 || frame.response
    || frame.payload.length < 11) return null;
  const p = Buffer.from(frame.payload);
  // HG211 captures carry normal status bits 5/7 (0x20/0x80) during proven
  // motion. Preserve faults for unclassified bit 2 and unproven bits 3/4/6.
  return { pitch: p.readInt16LE(0) / 10, roll: p.readInt16LE(2) / 10, yaw: p.readInt16LE(4) / 10,
    mode: (p[6] >> 6) & 3, at: clock.now(), pitchLimit: !!(p[10] & 1), yawLimit: !!(p[10] & 2), fault: !!(p[10] & 0x5c) };
}
export type MotionRefusal = { accepted: false; reason: GuardReason | 'busy' | 'unavailable' | 'revoked' | 'write-failed' };
export interface GimbalControllerOptions {
  clock: IntentClock;
  context(): GuardContext;
  /** Resolve only when actual transport I/O completes, never merely on enqueue. */
  write(command: Omit<DumlCommand, 'sequence'>, options: AccessoryCommandOptions): Promise<void>;
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

  constructor(private readonly options: GimbalControllerOptions) {
    this.leaseMs = options.leaseMs ?? 500;
    this.intent = new Intent({ clock: options.clock, leaseMs: this.leaseMs });
  }
  issue(owner: string, clientGesture?: string): IntentIssued | MotionRefusal {
    if (!this.available || this.closed) return { accepted: false, reason: 'unavailable' };
    if (this.discrete) return { accepted: false, reason: 'busy' };
    return this.intent.issue(owner, clientGesture);
  }
  admit(owner: string, request: unknown): IntentAdmitted | MotionRefusal {
    if (!this.available || this.closed) return { accepted: false, reason: 'unavailable' };
    if (this.discrete) return { accepted: false, reason: 'busy' };
    const result = this.intent.admit(owner, request);
    if (!result.accepted) return result;
    const live = this.intent.live();
    if (!live) { this.clearTimer(); return result; }
    const verdict = this.check({ kind: 'rate', ...live.rate });
    if (!verdict.allowed) { this.intent.reset(); this.clearTimer(); return { accepted: false, reason: verdict.reason }; }
    live.signal.addEventListener('abort', () => this.clearTimer(), { once: true });
    this.pump();
    return result;
  }
  end(owner: string, gesture: string): void { this.intent.end(owner, gesture); }
  /** Call on every attitude/configuration update, including a malformed attitude push. */
  refresh(): void {
    if (this.discrete) this.discreteAdmission(this.discrete);
    const live = this.intent.live();
    if (live) this.rateAdmission(live);
  }
  reset(): void {
    this.clearTimer(); this.intent.reset();
    this.discrete?.controller.abort(); this.discrete = undefined;
  }
  disconnect(): void { this.available = false; this.awaitingMode = undefined; this.reset(); }
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
    this.awaitingMode = { mode: targetMode, after: this.options.clock.now(), signal: action.controller.signal };
    const wire = this.wire(command);
    this.pending = true;
    try {
      await this.options.write(wire, { signal: action.controller.signal, deadline: action.deadline, admission: () => {
        if (!this.discreteAdmission(action)) return false;
        // Refresh/watchdog checks do not move this boundary. Only actual
        // serialized dispatch establishes how new target-mode readback must be.
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
    if (!this.check({ kind: 'rate', ...live.rate }).allowed) { this.intent.reset(); this.clearTimer(); return false; }
    return true;
  }
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
    try {
      await this.options.write(this.wire({ kind: 'rate', ...live.rate }), {
        signal: live.signal, deadline: live.expiresAt, admission: () => this.rateAdmission(live),
      });
    } catch {
      if (!live.signal.aborted) this.disconnect();
    } finally {
      // Enqueue can precede actual transport dispatch by an arbitrary delay.
      // Waiting after completion conservatively preserves the wire cadence.
      this.lastCompletedAt = this.options.clock.now();
      this.pending = false;
    }
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
  private wire(command: MotionCommand): Omit<DumlCommand, 'sequence'> {
    const common = { receiver: 4, commandSet: 4, ack: 0 };
    if (command.kind === 'recentre') return { ...common, commandId: 0x4c, payload: Buffer.from([2, 1]) };
    if (command.kind === 'mode') return { ...common, commandId: 0x44, payload: Buffer.from([command.mode]) };
    const payload = Buffer.alloc(7);
    // Truncate toward zero so quantization cannot exceed the guarded speed.
    payload.writeInt16LE(Math.trunc(command.pan * 10), 0);
    payload.writeInt16LE(Math.trunc(-command.tilt * 10), 4);
    payload[6] = 0x80;
    return { ...common, commandId: 0x0c, payload };
  }
}
