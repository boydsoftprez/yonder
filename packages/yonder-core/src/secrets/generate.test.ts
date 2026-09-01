// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * node:crypto is wrapped so a test can see *which* source of randomness was
 * used. "Randomness from node:crypto only" is a security constraint, and a
 * secret drawn from Math.random() is indistinguishable from a good one by
 * looking at the output: same length, same alphabet, no repeats in a sample.
 * The only observable difference is that the CSPRNG was never asked.
 */
const rec = vi.hoisted(() => ({ bounds: [] as number[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: actual,
    randomInt: (...args: unknown[]) => {
      if (args.length === 1) rec.bounds.push(args[0] as number);
      return (actual.randomInt as (...a: unknown[]) => number)(...args);
    },
  };
});

const { generateSecret } = await import("./generate.js");

/** Every kind, and the length each is required to have. */
const KINDS = [
  ["psk", 16],
  ["password", 16],
  ["token", 32],
] as const;

beforeEach(() => { rec.bounds.length = 0; });

describe("generateSecret", () => {
  it.each(KINDS)("draws every character of a %s from node:crypto", (kind, length) => {
    const secret = generateSecret(kind);
    expect(secret).toHaveLength(length);
    // One CSPRNG draw per character, and every draw over the same alphabet.
    expect(rec.bounds).toHaveLength(length);
    expect(new Set(rec.bounds).size).toBe(1);
    expect(rec.bounds[0]).toBeGreaterThan(32);
  });

  it.each(KINDS)("gives a %s its stated length", (kind, length) => {
    expect(generateSecret(kind)).toHaveLength(length);
  });

  it("produces a WPA2-legal pre-shared key", () => {
    const s = generateSecret("psk");
    expect(s.length).toBeGreaterThanOrEqual(12);
    expect(s.length).toBeLessThanOrEqual(63);
  });

  it("never repeats across many calls", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateSecret("psk")));
    expect(seen.size).toBe(500);
  });

  it.each(KINDS)("avoids characters that are ambiguous when read aloud in a %s", (kind) => {
    for (let i = 0; i < 100; i++) {
      expect(generateSecret(kind)).not.toMatch(/[O0lI1]/);
    }
  });
});
