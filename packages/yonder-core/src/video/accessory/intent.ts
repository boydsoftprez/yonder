// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";

/** Daemon time only. Implementations must be monotonic; timer callbacks may be late. */
export interface IntentClock {
  now(): number;
  setTimer(ms: number, callback: () => void): unknown;
  clearTimer(timer: unknown): void;
}

// Grant age and forwarding lease are separate bounds, each at most 500 ms.
const GRANT_LIFETIME_MS = 500;

const monotonicClock: IntentClock = {
  now: () => Number(process.hrtime.bigint()) / 1_000_000,
  setTimer: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface IntentGrant {
  gesture: string;
  deadline: number;
  credential: string;
}

export interface IntentRate { pan: number; tilt: number }
export type IntentRejectionReason = "malformed" | "busy" | "gesture" | "owner" | "credential" | "deadline" | "sequence" | "inactive";
export interface IntentRejected { accepted: false; reason: IntentRejectionReason }
export type IntentIssued = { accepted: true; grant: IntentGrant } | IntentRejected;
export type IntentAdmitted = { accepted: true; next: IntentGrant | null } | IntentRejected;

export interface LiveIntent {
  readonly owner: string;
  readonly gesture: string;
  /** Endpoint deadline: original grant freshness and forwarding lease combined. */
  readonly expiresAt: number;
  readonly deadline: number;
  readonly rate: IntentRate;
  readonly signal: AbortSignal;
  /** Check immediately before dispatch as well as passing signal to queued I/O. */
  isValid(): boolean;
}

interface Command {
  controller: AbortController;
  leaseUntil: number;
  view: LiveIntent;
}
interface Generation {
  owner: string;
  clientGesture?: string;
  grant: IntentGrant;
  lastSequence: number;
  command?: Command;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reject(reason: IntentRejectionReason): IntentRejected { return { accepted: false, reason }; }

/**
 * One instance per camera, owned by the daemon. Grants never cross instances.
 * R-CAM-11 / R-CMD-04: this model admits operator rates; it originates no motion.
 * 500 ms is the maximum intent allowance, separate from device stopping time.
 * At most one generation, one command and one timer are retained; retired grants
 * cannot become current again, so no tombstone history is necessary.
 */
export class Intent {
  private readonly clock: IntentClock;
  private readonly leaseMs: number;
  private readonly tokenFactory: () => string;
  private active?: Generation;
  private timer?: unknown;
  private timerGeneration?: symbol;

  constructor(options: { clock?: IntentClock; leaseMs?: number; tokenFactory?: () => string } = {}) {
    this.clock = options.clock ?? monotonicClock;
    this.leaseMs = options.leaseMs ?? 500;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > 500) {
      throw new RangeError("Intent lease must be positive and at most 500 ms");
    }
  }

  issue(owner: string, clientGesture?: string): IntentIssued {
    if (!validId(owner) || (clientGesture !== undefined && !validId(clientGesture))) return reject("malformed");
    const now = this.clock.now();
    this.expire(now);
    if (this.active && this.active.owner !== owner) return reject("busy");
    if (this.active && clientGesture !== undefined && this.active.clientGesture === clientGesture) return reject("gesture");
    this.reset();
    const grant = this.grant(this.tokenFactory(), now);
    this.active = { owner, clientGesture, grant, lastSequence: -1 };
    this.armTimer(now);
    return { accepted: true, grant };
  }

  admit(owner: string, request: unknown): IntentAdmitted {
    if (!validId(owner) || !record(request) || !record(request.rate)
      || !Number.isFinite(request.rate.pan) || !Number.isFinite(request.rate.tilt)) return reject("malformed");
    const now = this.clock.now();
    this.expire(now);
    const active = this.active;
    if (!active) return reject("inactive");
    if (active.owner !== owner) return reject("owner");
    if (request.gesture !== active.grant.gesture) return reject("gesture");
    if (request.credential !== active.grant.credential) return reject("credential");
    if (request.deadline !== active.grant.deadline) return reject("deadline");
    if (!Number.isSafeInteger(request.seq) || (request.seq as number) <= active.lastSequence) return reject("sequence");

    // Zero is cancellation, not a fresh grant from which motion can resume.
    if (request.rate.pan === 0 && request.rate.tilt === 0) {
      this.reset();
      return { accepted: true, next: null };
    }
    const previous = active.command;
    const controller = new AbortController();
    const command: Command = {
      controller,
      leaseUntil: now + this.leaseMs,
      view: Object.freeze({
        owner,
        gesture: active.grant.gesture,
        deadline: active.grant.deadline,
        expiresAt: Math.min(active.grant.deadline, now + this.leaseMs),
        rate: Object.freeze({ pan: request.rate.pan as number, tilt: request.rate.tilt as number }),
        signal: controller.signal,
        isValid: () => {
          this.expire(this.clock.now());
          // Every retirement path aborts this command, including renewal.
          return !controller.signal.aborted;
        },
      }),
    };
    active.lastSequence = request.seq as number;
    active.command = command;
    active.grant = this.grant(active.grant.gesture, now);
    this.armTimer(now);
    previous?.controller.abort();
    return { accepted: true, next: active.grant };
  }

  live(): LiveIntent | null {
    this.expire(this.clock.now());
    return this.active?.command?.view ?? null;
  }

  retains(owner: string, gesture: string): boolean {
    this.expire(this.clock.now());
    return this.active?.owner === owner && this.active.grant.gesture === gesture;
  }

  /** Stops need no live credential; an older owner/generation cannot stop a newer one. */
  end(owner: string, gesture: string): void {
    if (this.active?.owner === owner && this.active.grant.gesture === gesture) this.reset();
  }

  /** Recovery may admit a new physical gesture, but never restore the old one. */
  disconnect(): void { this.reset(); }

  reset(): void {
    const command = this.active?.command;
    this.active = undefined;
    this.clearTimer();
    command?.controller.abort();
  }

  private grant(gesture: string, now: number): IntentGrant {
    return Object.freeze({ gesture, deadline: now + GRANT_LIFETIME_MS, credential: this.tokenFactory() });
  }

  private expiresAt(active: Generation): number {
    return active.command
      ? Math.min(active.command.view.expiresAt, active.grant.deadline)
      : active.grant.deadline;
  }

  private expire(now: number): void {
    const active = this.active;
    if (!active) return;
    if (now >= active.grant.deadline) { this.reset(); return; }
    if (active.command && now >= active.command.view.expiresAt) {
      // The old rate expires at its ORIGINAL dispatch deadline. The separately
      // issued next credential may still be travelling to the held browser and
      // back. Retain only that credential, never the expired rate or its I/O.
      // Release, fault, disconnect and generation changes still revoke both.
      const command = active.command;
      active.command = undefined;
      command.controller.abort();
      this.armTimer(now);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.timerGeneration = undefined;
  }

  private armTimer(now: number): void {
    this.clearTimer();
    if (!this.active) return;
    const generation = Symbol();
    this.timerGeneration = generation;
    this.timer = this.clock.setTimer(Math.max(0, this.expiresAt(this.active) - now), () => {
      if (this.timerGeneration !== generation) return;
      this.timer = undefined;
      const currentTime = this.clock.now();
      this.expire(currentTime);
      // Rounding or early callbacks cannot discard the remaining expiry timer.
      if (this.active) this.armTimer(currentTime);
    });
  }
}
