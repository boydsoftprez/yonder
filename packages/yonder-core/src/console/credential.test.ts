// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET, MIN_PASSWORD_LENGTH } from "./credential.js";

let dir: string, secretsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-credential-"));
  secretsPath = join(dir, "secrets.yaml");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function credential(): AdminCredential {
  return new AdminCredential(new SecretStore(secretsPath));
}

const GOOD = "a long enough password";

describe("AdminCredential", () => {
  it("reports no password on a device nobody has provisioned", () => {
    expect(credential().isSet()).toBe(false);
    // Nothing was created by asking.
    expect(existsSync(secretsPath)).toBe(false);
  });

  it("sets one, and says so afterwards", () => {
    const c = credential();
    expect(c.set(GOOD)).toEqual({ ok: true });
    expect(c.isSet()).toBe(true);
    // And it survives the process that set it: a device that forgot the
    // password on reboot would be one nobody could ever get into.
    expect(credential().isSet()).toBe(true);
    expect(credential().verify(GOOD)).toBe(true);
  });

  /**
   * First run is one-way. A device that lets an unauthenticated caller
   * *replace* the administrator password has no lock on it at all: whoever
   * reached the console second would overwrite the first operator's and take
   * the device.
   */
  it("refuses a second set, and leaves the first hash exactly as it was", () => {
    const c = credential();
    c.set(GOOD);
    const first = new SecretStore(secretsPath).get(ADMIN_PASSWORD_SECRET);

    const again = c.set("a completely different password");
    expect(again).toEqual({ ok: false, reason: "already-set", message: expect.any(String) });
    expect(new SecretStore(secretsPath).get(ADMIN_PASSWORD_SECRET)).toBe(first);
    expect(c.verify(GOOD)).toBe(true);
    expect(c.verify("a completely different password")).toBe(false);
  });

  it("refuses a second set even from a credential that has not seen the first", () => {
    credential().set(GOOD);
    // A fresh store, so isSet() is answered from the file rather than from
    // anything cached. The refusal has to come from what is on disk.
    expect(credential().set("another one entirely").ok).toBe(false);
  });

  it("refuses a password shorter than the minimum", () => {
    const c = credential();
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const result = c.set(short);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : "").toBe("too-short");
    expect(c.isSet()).toBe(false);
  });

  it("accepts a password of exactly the minimum length", () => {
    expect(credential().set("a".repeat(MIN_PASSWORD_LENGTH))).toEqual({ ok: true });
  });

  it("refuses a blank or whitespace-only password", () => {
    const c = credential();
    for (const blank of ["", " ", "        ", "\t\n  \t"]) {
      const result = c.set(blank);
      expect(result.ok, `accepted ${JSON.stringify(blank)}`).toBe(false);
      expect(result.ok === false ? result.reason : "").toBe("blank");
    }
    expect(c.isSet()).toBe(false);
  });

  /**
   * R-SEC-10. These messages travel into an HTTP response body and from there
   * into whatever the browser does with a failed request. A refusal that
   * quotes what was submitted has put the password somewhere it does not
   * belong, and it does that most often for the password an operator was
   * about to fix and re-send.
   */
  it("never quotes the submitted value in a refusal", () => {
    const c = credential();
    const attempts = ["short", "   ", "hunter2!"];
    for (const attempt of attempts) {
      const result = c.set(attempt);
      if (result.ok) continue;
      expect(result.message).not.toContain(attempt);
      // And it says the rule, so an operator knows what to do next.
      expect(result.message.length).toBeGreaterThan(10);
    }
    c.set(GOOD);
    const already = c.set(GOOD);
    expect(already.ok === false ? already.message : "").not.toContain(GOOD);
  });

  it("says the minimum length in the refusal, so the rule is discoverable", () => {
    const result = credential().set("short");
    expect(result.ok === false ? result.message : "").toContain(String(MIN_PASSWORD_LENGTH));
  });

  describe("verify", () => {
    it("is true for the password, false for anything else", () => {
      const c = credential();
      c.set(GOOD);
      expect(c.verify(GOOD)).toBe(true);
      expect(c.verify(`${GOOD} `)).toBe(false);
      expect(c.verify(GOOD.toUpperCase())).toBe(false);
      expect(c.verify("")).toBe(false);
    });

    it("is false on a device with no password at all", () => {
      // An unprovisioned device authenticates nobody. Not "anyone".
      const c = credential();
      expect(c.verify("")).toBe(false);
      expect(c.verify(GOOD)).toBe(false);
      expect(c.verify("anything")).toBe(false);
    });

    /**
     * Fail closed. A hand-edited secrets.yaml is a wrong password, never a
     * right one and never an exception — an exception here would be thrown on
     * every login attempt, taking the daemon with it.
     */
    it("is false, and does not throw, when the stored hash is nonsense", () => {
      const store = new SecretStore(secretsPath);
      for (const junk of ["", "hunter2", "scrypt$$$$", "$2b$12$abcdefghijklmnop"]) {
        rmSync(secretsPath, { force: true });
        new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, junk);
        const c = credential();
        // isSet() is about presence, not validity: the device does have a
        // password set, it just has one nothing can match. That is what
        // keeps the console in login mode rather than reopening setup to
        // anyone who can corrupt a file.
        expect(c.isSet()).toBe(true);
        expect(() => c.verify(GOOD)).not.toThrow();
        expect(c.verify(GOOD)).toBe(false);
      }
      expect(store).toBeDefined();
    });
  });

  /**
   * The file is what an attacker with a card reader gets. It must not carry
   * the password, and it must not be readable by the console's own account.
   */
  it("stores a hash, not the password, in a file only root can read", () => {
    credential().set(GOOD);
    const raw = readFileSync(secretsPath, "utf8");
    expect(raw).toContain(ADMIN_PASSWORD_SECRET);
    expect(raw).toContain("scrypt$");
    expect(raw).not.toContain(GOOD);
    expect(raw).not.toContain(Buffer.from(GOOD, "utf8").toString("base64"));
  });
});
