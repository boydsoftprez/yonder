// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The administrator password, hashed.
 *
 * `node:crypto`'s scrypt rather than bcrypt, deliberately. `bcrypt` is a
 * native module and needs a compiler on the target, which an offline arm64
 * install does not have; `bcryptjs` is pure JavaScript but is one more
 * vendored dependency to carry onto a board. scrypt is already in Node, is
 * designed for exactly this, and costs nothing to ship.
 *
 * This file knows hashing and nothing else. Where the hash lives is
 * credential.ts's business, and what a password is allowed to be — a minimum
 * length, a refusal to accept whitespace — is enforced at the point of
 * *setting* one, not here. A verifier that applied a policy would start
 * refusing passwords that were legal when they were set, the day the policy
 * was tightened.
 */

/** Cost parameters used for a hash made today. */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** 16 bytes of salt, 32 bytes of derived key. */
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;

/**
 * The most memory a stored form is allowed to ask for: 64 MiB.
 *
 * scrypt's whole point is to be expensive in memory, and the parameters are
 * read back out of the stored string so they can be raised later without
 * invalidating existing hashes. That is also a way for a corrupt — or
 * tampered-with — `secrets.yaml` to ask this device to allocate a gigabyte on
 * every login attempt. A board with 1 GB of RAM flying an aircraft must not
 * be able to be pushed into the OOM killer by a number in a file, so the
 * request is bounded, and a stored form asking for more is simply one that
 * does not verify.
 *
 * 64 MiB leaves four doublings of N above today's 16 MiB, which is more
 * headroom than this project will plausibly need.
 */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** The shortest decoded salt and hash a stored form may carry. */
const MIN_SALT_BYTES = 8;
const MIN_KEY_BYTES = 16;

const PREFIX = "scrypt";

interface StoredForm {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** 128 * N * r is scrypt's working set; p multiplies the work, not the memory. */
function memoryFor(n: number, r: number): number {
  return 128 * n * r;
}

/** N must be a power of two greater than one — scrypt itself requires it. */
function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/**
 * A positive integer, written in decimal, with nothing else in the field.
 *
 * `Number("16384\n")` is 16384 and `Number("0x10")` is 16, and neither is
 * something this project ever wrote. Being exact here is what makes a
 * malformed stored form fail as malformed rather than as a plausible set of
 * parameters that happens to derive the wrong key.
 */
function parseCount(field: string | undefined): number | undefined {
  if (field === undefined || !/^[1-9][0-9]{0,9}$/.test(field)) return undefined;
  return Number(field);
}

/**
 * Base64 that decodes back to exactly what was written.
 *
 * `Buffer.from(x, "base64")` skips characters it does not recognise, so it
 * turns `"!!!!"` into an empty buffer rather than saying no. Re-encoding and
 * comparing is what turns that silence into a rejection.
 */
function parseBase64(field: string | undefined, minBytes: number): Buffer | undefined {
  if (field === undefined || field === "") return undefined;
  const decoded = Buffer.from(field, "base64");
  if (decoded.length < minBytes) return undefined;
  if (decoded.toString("base64") !== field) return undefined;
  return decoded;
}

/**
 * Read a stored form, or return undefined.
 *
 * Never throws. A `secrets.yaml` an operator has hand-edited into nonsense
 * must lock them out with a wrong-password message, not crash the daemon on
 * every login attempt — a daemon that dies on login is a device with no
 * network, which is a far worse failure than a password that will not work.
 */
function parseStored(stored: string): StoredForm | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined;

  const n = parseCount(parts[1]);
  const r = parseCount(parts[2]);
  const p = parseCount(parts[3]);
  if (n === undefined || r === undefined || p === undefined) return undefined;
  if (!isPowerOfTwo(n)) return undefined;
  if (r > 64 || p > 16) return undefined;
  if (memoryFor(n, r) > MAX_MEMORY_BYTES) return undefined;

  const salt = parseBase64(parts[4], MIN_SALT_BYTES);
  const hash = parseBase64(parts[5], MIN_KEY_BYTES);
  if (salt === undefined || hash === undefined) return undefined;

  return { n, r, p, salt, hash };
}

/**
 * Derive a key, or return undefined if scrypt itself refuses.
 *
 * Synchronous on purpose. The daemon is single-purpose and the throttle in
 * throttle.ts bounds how often this can be asked for, so the event loop is
 * blocked for the length of one derivation and only a handful of times before
 * the caller is refused outright. The alternative — an async derivation —
 * buys concurrency this daemon has no use for and adds a way for several
 * verifications to be in flight at once, each holding scrypt's working set.
 */
function derive(plain: string, form: Pick<StoredForm, "n" | "r" | "p" | "salt">, keyBytes: number):
Buffer | undefined {
  try {
    return scryptSync(plain, form.salt, keyBytes, {
      N: form.n,
      r: form.r,
      p: form.p,
      // Explicit, because Node's default is 32 MiB and a stored form is
      // allowed to name parameters above that. The bound that matters is
      // MAX_MEMORY_BYTES, checked in parseStored; this only stops the
      // library refusing a set of parameters we have already accepted.
      maxmem: memoryFor(form.n, form.r) + (1 << 20),
    });
  } catch {
    return undefined;
  }
}

/**
 * Hash a password for storage. The salt is fresh every time, so hashing the
 * same password twice produces two different strings.
 *
 * Stored form: `scrypt$<N>$<r>$<p>$<base64 salt>$<base64 hash>`. The
 * parameters travel with the hash so they can be raised later without
 * invalidating a password an operator has already set.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(plain, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt }, KEY_BYTES);
  if (hash === undefined) {
    // Only reachable if this build of Node cannot do scrypt at all, which is
    // not a thing to paper over with a weaker hash.
    throw new Error("cannot hash a password: scrypt is unavailable");
  }
  return [
    PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), hash.toString("base64"),
  ].join("$");
}

/**
 * Whether `plain` is the password `stored` records.
 *
 * Fails closed: an unparseable stored form, a scrypt that refuses, an empty
 * plaintext — all `false`, none an exception.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  // Before anything else. An empty password is what an empty form field, an
  // absent JSON key and a `password=` with nothing after it all arrive as,
  // and none of them should ever be able to open anything — not even against
  // a stored form that somehow hashes the empty string.
  if (plain === "") return false;

  const form = parseStored(stored);
  if (form === undefined) return false;

  const candidate = derive(plain, form, form.hash.length);
  if (candidate === undefined || candidate.length !== form.hash.length) return false;
  return timingSafeEqual(candidate, form.hash);
}
