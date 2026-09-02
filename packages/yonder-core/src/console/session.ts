// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { systemClock, type Clock } from "../apply/types.js";

/**
 * Console sessions: in memory, signed with a key minted at start-up.
 *
 * **They die with the process.** A console restart logs everyone out. That is
 * correct for a device whose console is restarted whenever its configuration
 * changes, and it means there is no session secret at rest — nothing on the
 * card that lets someone forge a session for a device they have taken the
 * SD card out of.
 *
 * The token is an opaque id and a signature over it. The id alone would be
 * enough, since a set is consulted either way; the signature is what makes a
 * token minted by a *different* process — a console that has since restarted,
 * or another device — fail without touching the set at all, and it is
 * checked in constant time so a token cannot be discovered a byte at a time.
 *
 * Pure and clock-injected. No timer, so there is nothing to stop and no test
 * has to wait: expiry is a comparison, made when a token is presented.
 */

/** How long a session may sit unused before it stops working. */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Bytes of randomness in a session id. */
const ID_BYTES = 24;

export interface SessionStoreOptions {
  clock?: Clock;
  idleMs?: number;
  /** Test-only: a fixed signing key, so a test can mint a token under another one. */
  key?: Buffer;
}

export class SessionStore {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly key: Buffer;
  /** Session id to the time it was last presented. */
  private readonly live = new Map<string, number>();

  constructor(opts: SessionStoreOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
    this.key = opts.key ?? randomBytes(32);
  }

  /** A new session, valid from now. */
  mint(): string {
    this.prune();
    const id = randomBytes(ID_BYTES).toString("base64url");
    this.live.set(id, this.clock.now());
    return `${id}.${this.sign(id)}`;
  }

  /**
   * Whether this token is a live session, refreshing its idle timer if so.
   *
   * Sliding rather than absolute: an operator watching a flight should not be
   * logged out mid-flight for having been logged in twelve hours, and one who
   * walked away from an open browser should not stay logged in for ever.
   */
  check(token: string): boolean {
    const id = this.verified(token);
    if (id === undefined) return false;

    const lastSeen = this.live.get(id);
    if (lastSeen === undefined) return false;
    const now = this.clock.now();
    if (now - lastSeen >= this.idleMs) {
      this.live.delete(id);
      return false;
    }
    this.live.set(id, now);
    return true;
  }

  /** End one session — what POST /logout does. */
  revoke(token: string): void {
    const id = this.verified(token);
    if (id !== undefined) this.live.delete(id);
  }

  /** End all of them. */
  revokeAll(): void {
    this.live.clear();
  }

  /** How many sessions are live. For a test and a status line, not a decision. */
  get size(): number {
    return this.live.size;
  }

  /**
   * The id inside a token whose signature is ours, or undefined.
   *
   * Everything a caller could have made up is rejected here, before the set
   * is consulted: the wrong shape, a signature of the wrong length, a
   * signature from another key.
   */
  private verified(token: string): string | undefined {
    if (typeof token !== "string") return undefined;
    const cut = token.lastIndexOf(".");
    if (cut <= 0 || cut === token.length - 1) return undefined;
    const id = token.slice(0, cut);
    const signature = Buffer.from(token.slice(cut + 1), "base64url");
    const expected = Buffer.from(this.sign(id), "base64url");
    // timingSafeEqual throws on a length mismatch, and two empty buffers are
    // equal to it — both of which are a caller's choice of input, so both are
    // decided here rather than by the comparison.
    if (signature.length !== expected.length || expected.length === 0) return undefined;
    return timingSafeEqual(signature, expected) ? id : undefined;
  }

  private sign(id: string): string {
    return createHmac("sha256", this.key).update(id).digest("base64url");
  }

  /**
   * Drop sessions that have already timed out.
   *
   * Called from mint(), because a session that is never presented again is
   * never looked at by check() and would otherwise sit in the map for the
   * life of the process. Bounded work: one pass over what is there, at the
   * only moment the map can grow.
   */
  private prune(): void {
    const now = this.clock.now();
    for (const [id, lastSeen] of this.live) {
      if (now - lastSeen >= this.idleMs) this.live.delete(id);
    }
  }
}
