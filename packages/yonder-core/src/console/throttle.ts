// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";

/**
 * Backoff on failed administrator logins.
 *
 * Pure and clock-injected: it holds two numbers and answers questions about
 * them. No timer, so nothing here can outlive the daemon or need stopping,
 * and a test drives it by moving the clock rather than by waiting.
 *
 * **One counter, not a map.** There is one administrator on this device, so
 * there is one thing to count. A map keyed by anything a caller could supply
 * — an address, a session, a username — is memory an unauthenticated request
 * can make this daemon allocate, on a board with a gigabyte of RAM, and it
 * would buy nothing: whoever is guessing is guessing at the same one
 * password.
 *
 * The cost of that choice is stated plainly: a sustained guessing attempt
 * locks the real operator out for the same 60 seconds. That is the right way
 * round. The lock is short, it is measured from the last attempt rather than
 * compounding, and the alternative — letting an attacker keep guessing so the
 * operator is never inconvenienced — defeats the point.
 *
 * It also bounds something else. verifyPassword is a synchronous scrypt, so
 * every attempt blocks this daemon's event loop for the length of one
 * derivation. This is what stops a caller turning that into a way to stall
 * the configuration socket.
 */

/** Consecutive failures before attempts are refused. */
export const FAILURE_LIMIT = 5;
/** How long they are refused for. */
export const LOCKOUT_MS = 60_000;

export interface ThrottleOptions {
  clock?: Clock;
  limit?: number;
  lockoutMs?: number;
}

/** Allowed, or refused with the whole seconds left to wait. */
export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

export class AttemptThrottle {
  private readonly clock: Clock;
  private readonly limit: number;
  private readonly lockoutMs: number;
  private failures = 0;
  /** When the current lockout ends. 0 when there is not one. */
  private until = 0;

  constructor(opts: ThrottleOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.limit = opts.limit ?? FAILURE_LIMIT;
    this.lockoutMs = opts.lockoutMs ?? LOCKOUT_MS;
  }

  /**
   * Whether an attempt may be made now.
   *
   * Asked *before* the password is checked, so a refused attempt costs no
   * scrypt derivation at all.
   *
   * A lockout that has run out clears the counter rather than granting one
   * attempt at a time: an operator who mistyped five times and waited a
   * minute gets a fresh five, which is what they would expect, and someone
   * guessing still pays a minute for every five guesses either way.
   */
  check(): ThrottleDecision {
    if (this.until === 0) return { allowed: true };
    const remaining = this.until - this.clock.now();
    if (remaining > 0) return { allowed: false, retryAfter: Math.ceil(remaining / 1000) };
    this.reset();
    return { allowed: true };
  }

  /**
   * Record how an attempt went.
   *
   * A success resets everything — the counter is of *consecutive* failures,
   * and someone who has just proved they know the password is not the person
   * the count was about.
   */
  record(succeeded: boolean): void {
    if (succeeded) {
      this.reset();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.limit) {
      this.until = this.clock.now() + this.lockoutMs;
    }
  }

  /** Consecutive failures so far. For a status line, not for a decision. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  private reset(): void {
    this.failures = 0;
    this.until = 0;
  }
}
