// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { SessionStore, IDLE_TIMEOUT_MS } from "./session.js";
import type { Clock } from "../apply/types.js";

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    setTimer: () => { throw new Error("sessions must not arm a timer"); },
    clearTimer: () => { throw new Error("sessions must not arm a timer"); },
    advance(ms: number) { t += ms; },
  };
}

describe("SessionStore", () => {
  it("mints a token that validates", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const token = sessions.mint();
    expect(sessions.check(token)).toBe(true);
  });

  it("mints a different token every time", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const tokens = new Set([sessions.mint(), sessions.mint(), sessions.mint()]);
    expect(tokens.size).toBe(3);
    for (const token of tokens) expect(sessions.check(token)).toBe(true);
  });

  it("rejects anything that is not a token it minted", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const real = sessions.mint();
    const [id, signature] = real.split(".");
    for (const junk of [
      "",
      ".",
      "..",
      "no-dot-at-all",
      `${id}.`,
      `.${signature}`,
      `${id}.${signature}x`,
      `${id}x.${signature}`,
      // A signature of the right shape but the wrong length: timingSafeEqual
      // throws on mismatched buffers, so this must be decided before it.
      `${id}.${Buffer.alloc(8).toString("base64url")}`,
      // Two empty buffers are equal to timingSafeEqual, so an empty
      // signature must be refused before the comparison too.
      `${id}.${Buffer.alloc(0).toString("base64url")}`,
    ]) {
      expect(sessions.check(junk), JSON.stringify(junk)).toBe(false);
    }
    expect(sessions.check(real)).toBe(true);
  });

  /**
   * The signing key is minted per process, so a token from a console that has
   * since restarted — or from another device entirely — is not a session
   * here. That is the whole reason sessions do not survive a restart, and it
   * is the property that makes it true.
   */
  it("rejects a token signed with a different key", () => {
    const clock = fakeClock();
    const key = randomBytes(32);
    const mine = new SessionStore({ clock, key });
    const theirs = new SessionStore({ clock, key: randomBytes(32) });

    const token = theirs.mint();
    expect(theirs.check(token)).toBe(true);
    expect(mine.check(token)).toBe(false);

    // And the same store, restarted with the same key, still does not know
    // the session: the set is in memory, not in the token.
    const restarted = new SessionStore({ clock, key });
    expect(restarted.check(mine.mint())).toBe(false);
  });

  it("expires a session that has sat unused", () => {
    const clock = fakeClock();
    const sessions = new SessionStore({ clock });
    const token = sessions.mint();

    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(sessions.check(token)).toBe(true);
    clock.advance(IDLE_TIMEOUT_MS);
    expect(sessions.check(token)).toBe(false);
  });

  /**
   * Sliding, not absolute. An operator watching a flight should not be logged
   * out for having been logged in twelve hours; one who walked away from an
   * open browser should not stay logged in for ever.
   */
  it("refreshes the idle timer each time the session is used", () => {
    const clock = fakeClock();
    const sessions = new SessionStore({ clock, idleMs: 1000 });
    const token = sessions.mint();

    for (let i = 0; i < 10; i++) {
      clock.advance(900);
      expect(sessions.check(token), `use ${i + 1}`).toBe(true);
    }
    clock.advance(1000);
    expect(sessions.check(token)).toBe(false);
  });

  it("forgets an expired session rather than keeping it about", () => {
    const clock = fakeClock();
    const sessions = new SessionStore({ clock, idleMs: 1000 });
    sessions.mint();
    expect(sessions.size).toBe(1);
    clock.advance(2000);
    // Pruned when the next one is minted, so a session nobody ever presents
    // again does not sit in the map for the life of the process.
    sessions.mint();
    expect(sessions.size).toBe(1);
  });

  it("revokes one session and leaves the others", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const a = sessions.mint();
    const b = sessions.mint();
    sessions.revoke(a);
    expect(sessions.check(a)).toBe(false);
    expect(sessions.check(b)).toBe(true);
  });

  it("shrugs off a revoke of something that is not a token", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const token = sessions.mint();
    expect(() => { sessions.revoke("nonsense"); }).not.toThrow();
    expect(sessions.check(token)).toBe(true);
  });

  it("revokes all of them at once", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const tokens = [sessions.mint(), sessions.mint()];
    sessions.revokeAll();
    for (const token of tokens) expect(sessions.check(token)).toBe(false);
    expect(sessions.size).toBe(0);
  });

  it("arms no timer, so there is nothing to stop when the console closes", () => {
    const clock = fakeClock();
    const sessions = new SessionStore({ clock });
    expect(() => {
      const token = sessions.mint();
      sessions.check(token);
      sessions.revoke(token);
      sessions.revokeAll();
    }).not.toThrow();
  });

  /** The token is an id and a signature — never anything about the operator. */
  it("puts nothing in the token but randomness", () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    const token = sessions.mint();
    expect(token).not.toContain("yonder");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // 24 bytes of id and a SHA-256 signature, both base64url.
    expect(token.split(".")[0]).toHaveLength(32);
  });
});
