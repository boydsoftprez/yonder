// SPDX-License-Identifier: GPL-3.0-or-later
import { createECDH, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateOwnerPassword, validateOwnerPasswordHash, validateOwnerPublicKey, validateOwnerRecord, validateOwnerUsername } from "./model.js";

function field(value: string | Buffer): Buffer {
  const data = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  return Buffer.concat([size, data]);
}
const publicBytes = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const ed = `ssh-ed25519 ${Buffer.concat([field("ssh-ed25519"), field(publicBytes)]).toString("base64")}`;
const hash = `$y$j9T$${"a".repeat(22)}$${"b".repeat(43)}`;
const record = { username: "pilot", passwordHash: hash, authorizedKeys: [], sshEnabled: false, sshPasswordAuthentication: false, sudo: true };

describe("Linux owner input boundary (R-SYS-10/R-SEC-10/14)", () => {
  it("keeps service/reserved accounts and command/database syntax outside owner names", () => {
    expect(validateOwnerUsername("pilot-1")).toBe("pilot-1");
    for (const name of ["root", "yonder", "yonder-test", "systemd-new", "sudo", "nobody", "-flag", "AUser", "a:b", "a\nb", "../pilot", "a".repeat(32)]) {
      expect(() => validateOwnerUsername(name)).toThrow();
    }
  });
  it("preserves password bytes and excludes input framing injection", () => {
    expect(validateOwnerPassword("  long:pass word  ")).toBe("  long:pass word  ");
    for (const value of ["short", "        ", "password\nroot:x", "password\0x", "password\r", "é".repeat(513)]) {
      expect(() => validateOwnerPassword(value)).toThrow();
    }
  });
  it("accepts supported native crypt records but rejects locks, app hashes and excessive cost", () => {
    expect(validateOwnerPasswordHash(hash)).toBe(hash);
    const sha = `$6$rounds=100000$salt$${"a".repeat(86)}`;
    expect(validateOwnerPasswordHash(sha)).toBe(sha);
    for (const value of ["", "!", "*", "scrypt$abc", `!${hash}`, hash + "\n", hash.replace("j9T", "zzzzz"), sha.replace("100000", "999999999")]) {
      expect(() => validateOwnerPasswordHash(value)).toThrow();
    }
  });
  it("accepts complete Ed25519/ECDSA/RSA keys and records stable fingerprints", () => {
    expect(validateOwnerPublicKey(ed + " pilot@desktop").fingerprint).toMatch(/^SHA256:/);
    const ec = createECDH("prime256v1"); ec.generateKeys();
    const ecdsa = `ecdsa-sha2-nistp256 ${Buffer.concat([field("ecdsa-sha2-nistp256"), field("nistp256"), field(ec.getPublicKey())]).toString("base64")}`;
    expect(validateOwnerPublicKey(ecdsa).line).toBe(ecdsa);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
    const positive = (value: string) => { const bytes = Buffer.from(value, "base64url"); return field((bytes[0]! & 0x80) ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); };
    const key = `ssh-rsa ${Buffer.concat([field("ssh-rsa"), positive(rsa.e!), positive(rsa.n!)]).toString("base64")}`;
    expect(validateOwnerPublicKey(key).line).toBe(key);
  });
  it("rejects key options, private/certificate keys, malformed wire data and extra lines", () => {
    for (const value of [`command="sudo sh" ${ed}`, ed + "\n" + ed, "-----BEGIN PRIVATE KEY-----", "ssh-ed25519 AAAA", ed.replace("ssh-ed25519", "ssh-rsa"),
      `ssh-ed25519 ${Buffer.concat([field("ssh-ed25519"), field(publicBytes), Buffer.from([0])]).toString("base64")}`]) {
      expect(() => validateOwnerPublicKey(value)).toThrow();
    }
  });
  it("rejects extra account policy, duplicate keys and SSH with no authentication method", () => {
    expect(validateOwnerRecord(record)).toEqual(record);
    expect(validateOwnerRecord({ ...record, sshEnabled: true, sshPasswordAuthentication: true })).toMatchObject({ sshEnabled: true });
    for (const bad of [{ ...record, shell: "/bin/sh" }, { ...record, sudo: false }, { ...record, authorizedKeys: [ed, ed + " another-comment"] }, { ...record, sshEnabled: true }]) {
      expect(() => validateOwnerRecord(bad)).toThrow();
    }
  });
});
