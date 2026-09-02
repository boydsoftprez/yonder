// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { scryptSync } from "node:crypto";
import {
  hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P, SALT_BYTES, KEY_BYTES,
} from "./password.js";

const PLAIN = "correct horse battery staple";

/** A stored form built by hand, so a test can name parameters hashPassword never uses. */
function stored(n: number, r: number, p: number, salt: string, plain: string, keyBytes = 32): string {
  const hash = scryptSync(plain, Buffer.from(salt, "utf8"), keyBytes, {
    N: n, r, p, maxmem: 128 * n * r + (1 << 20),
  });
  return ["scrypt", n, r, p, Buffer.from(salt, "utf8").toString("base64"), hash.toString("base64")]
    .join("$");
}

describe("hashPassword", () => {
  it("produces a stored form carrying the parameters it used", () => {
    const parts = hashPassword(PLAIN).split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(SCRYPT_N);
    expect(Number(parts[2])).toBe(SCRYPT_R);
    expect(Number(parts[3])).toBe(SCRYPT_P);
    expect(Buffer.from(parts[4]!, "base64")).toHaveLength(SALT_BYTES);
    expect(Buffer.from(parts[5]!, "base64")).toHaveLength(KEY_BYTES);
  });

  it("hashes the same password to two different strings", () => {
    // A fresh salt every time. Equal hashes would tell anyone who could read
    // secrets.yaml that two devices share a password.
    expect(hashPassword(PLAIN)).not.toBe(hashPassword(PLAIN));
  });

  /**
   * R-SEC-10. The hash is written to a file, quoted in error messages during
   * development, and read by anyone with root. None of that may hand back the
   * password itself, in any encoding it could plausibly be stored in.
   */
  it("contains no copy of the plaintext", () => {
    const form = hashPassword(PLAIN);
    expect(form).not.toContain(PLAIN);
    expect(form).not.toContain(Buffer.from(PLAIN, "utf8").toString("base64"));
    expect(form).not.toContain(Buffer.from(PLAIN, "utf8").toString("hex"));
  });
});

describe("verifyPassword", () => {
  it("accepts the password it was made from and rejects any other", () => {
    const form = hashPassword(PLAIN);
    expect(verifyPassword(PLAIN, form)).toBe(true);
    expect(verifyPassword("correct horse battery stapl", form)).toBe(false);
    expect(verifyPassword("Correct horse battery staple", form)).toBe(false);
    expect(verifyPassword(`${PLAIN} `, form)).toBe(false);
  });

  /**
   * The parameters are read from the string, not from the constants above.
   * Raising the cost later must not lock out an operator whose password was
   * hashed by an earlier build.
   */
  it("re-derives with the parameters the stored form records, not today's", () => {
    const old = stored(1024, 4, 2, "an old salt, sixteen", PLAIN);
    expect(old).toContain("$1024$4$2$");
    expect(verifyPassword(PLAIN, old)).toBe(true);
    expect(verifyPassword("something else", old)).toBe(false);
  });

  it("verifies a stored form whose hash is a different length", () => {
    // Nothing pins the derived length; it is read from the stored hash.
    const wide = stored(1024, 4, 1, "a salt of sixteen", PLAIN, 64);
    expect(verifyPassword(PLAIN, wide)).toBe(true);
  });

  /**
   * An empty plaintext is what an empty form field, an absent JSON key and a
   * `password=` with nothing after it all arrive as. None of them opens
   * anything, whatever the stored value happens to be.
   */
  it("refuses an empty plaintext against any stored value", () => {
    expect(verifyPassword("", hashPassword(PLAIN))).toBe(false);
    expect(verifyPassword("", hashPassword(""))).toBe(false);
    expect(verifyPassword("", "")).toBe(false);
  });

  /**
   * A corrupt secrets.yaml entry must lock the operator out with a
   * wrong-password message, not throw on every login attempt. A daemon that
   * dies on login is a device with no network at all, which is a much worse
   * failure than a password that will not work.
   */
  it("returns false, and never throws, for a stored form it cannot read", () => {
    const good = hashPassword(PLAIN);
    const [, , , , salt, hash] = good.split("$");
    const junk = [
      "",
      "x",
      "scrypt$$$$",
      "scrypt$16384$8$1$$",
      // Empty salt and hash decode to zero-length buffers, and
      // timingSafeEqual calls two empty buffers equal. Rejected before it
      // gets that far.
      `scrypt$16384$8$1$${Buffer.alloc(0).toString("base64")}$${Buffer.alloc(0).toString("base64")}`,
      "$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012",
      "scrypt$16384$8$1$notbase64!!$notbase64!!",
      // Truncated salt.
      `scrypt$16384$8$1$${salt!.slice(0, 6)}$${hash}`,
      // Truncated hash.
      `scrypt$16384$8$1$${salt}$${hash!.slice(0, 8)}`,
      // Too few fields, and too many.
      `scrypt$16384$8$${salt}$${hash}`,
      `scrypt$16384$8$1$${salt}$${hash}$extra`,
      // Parameters that are not decimal counts.
      `scrypt$0x4000$8$1$${salt}$${hash}`,
      `scrypt$ 16384$8$1$${salt}$${hash}`,
      `scrypt$-16384$8$1$${salt}$${hash}`,
      `scrypt$16384.0$8$1$${salt}$${hash}`,
      // N is not a power of two.
      `scrypt$16383$8$1$${salt}$${hash}`,
      // A different algorithm entirely.
      `argon2id$16384$8$1$${salt}$${hash}`,
      "plaintext",
      PLAIN,
    ];
    for (const form of junk) {
      expect(() => verifyPassword(PLAIN, form), `threw on ${JSON.stringify(form)}`).not.toThrow();
      expect(verifyPassword(PLAIN, form), `accepted ${JSON.stringify(form)}`).toBe(false);
    }
  });

  /**
   * The parameters travel in the string, so the string is a way to ask this
   * device for memory. A board with a gigabyte of RAM flying an aircraft must
   * not be pushed into the OOM killer by a number in a file it reads on every
   * login attempt.
   */
  it("refuses a stored form demanding absurd memory instead of trying to allocate it", () => {
    const [, , , , salt, hash] = hashPassword(PLAIN).split("$");
    // 128 * 2^30 * 8 is a terabyte.
    const greedy = `scrypt$1073741824$8$1$${salt}$${hash}`;
    const before = Date.now();
    expect(verifyPassword(PLAIN, greedy)).toBe(false);
    // Rejected by reading the number, not by attempting the derivation.
    expect(Date.now() - before).toBeLessThan(1000);
  });
});
