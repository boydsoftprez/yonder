// SPDX-License-Identifier: GPL-3.0-or-later
import type { SecretStore } from "../secrets/store.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * The administrator password: where it lives, and the only three questions
 * anyone gets to ask about it.
 *
 * password.ts knows hashing. This knows storage. Splitting them is what lets
 * the hash parameters be raised later without anything else moving, and it
 * keeps the rule about *what a password may be* in exactly one place.
 *
 * The hash never leaves this process. `secrets.yaml` is 0600 root and the
 * console runs as the unprivileged `yonder` user, so the console cannot read
 * it — which is the desired state, not a limitation to work around. The
 * console asks the daemon whether a submitted password is right; a compromise
 * of the console therefore yields nothing to crack offline (ADR-0007).
 */

/** The name this hash is stored under in secrets.yaml. */
export const ADMIN_PASSWORD_SECRET = "admin_password";

/**
 * The shortest password accepted.
 *
 * Eight, and no character-class rule. A rule that demands a digit and a
 * symbol produces `Password1!` on every device in the fleet; length is the
 * property that actually costs a guesser anything. This is the floor, not
 * advice — the console says so.
 */
export const MIN_PASSWORD_LENGTH = 8;

export type SetRefusal = "already-set" | "too-short" | "blank";

/**
 * Distinguishable on purpose. The daemon route turns `already-set` into a
 * 409 and the other two into a 400, and a caller that could only see "it
 * failed" would have to guess which.
 */
export type SetResult =
  | { ok: true }
  | { ok: false; reason: SetRefusal; message: string };

export class AdminCredential {
  private readonly secrets: SecretStore;

  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /** Whether this device has an administrator password at all (R-SEC-09). */
  isSet(): boolean {
    return this.secrets.get(ADMIN_PASSWORD_SECRET) !== undefined;
  }

  /**
   * Set the password. Once.
   *
   * First run is a one-way step. A device that lets an unauthenticated caller
   * *replace* the administrator password has no lock on it at all — whoever
   * reached the console second would simply overwrite the first operator's
   * and take the device. Changing a password you already know is a different
   * operation, it is authenticated, and it is not this one.
   *
   * The refusal messages state the rule and never quote the submitted value
   * (R-SEC-10): they travel into an HTTP response body and, from there, into
   * whatever the browser does with a failed request.
   */
  set(plain: string): SetResult {
    // Checked before the hash, so a repeat POST costs no scrypt derivation.
    // The store's ensureValue below is still what makes this safe rather than
    // this check: it will not replace an existing value whatever happens
    // between the two.
    if (this.isSet()) {
      return {
        ok: false,
        reason: "already-set",
        message: "an administrator password is already set on this device",
      };
    }
    if (plain.trim() === "") {
      return {
        ok: false,
        reason: "blank",
        message: "the administrator password cannot be blank or only spaces",
      };
    }
    if (plain.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        reason: "too-short",
        message: `the administrator password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      };
    }

    const { created } = this.secrets.ensureValue(ADMIN_PASSWORD_SECRET, hashPassword(plain));
    if (!created) {
      // Something set it between isSet() and here. ensureValue left the first
      // one in place, which is the whole point of using it.
      return {
        ok: false,
        reason: "already-set",
        message: "an administrator password is already set on this device",
      };
    }
    return { ok: true };
  }

  /**
   * Whether `plain` is this device's administrator password.
   *
   * False when none is set: an unprovisioned device authenticates nobody. The
   * whole path fails closed — a stored form that cannot be read is a wrong
   * password, never a right one.
   */
  verify(plain: string): boolean {
    const stored = this.secrets.get(ADMIN_PASSWORD_SECRET);
    if (stored === undefined) return false;
    return verifyPassword(plain, stored);
  }
}
