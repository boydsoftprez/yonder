// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, createPublicKey, ECDH } from "node:crypto";
import { OwnerAccessRecordSchema, type OwnerAccessRecord } from "../state/types.js";

export class OwnerValidationError extends Error {
  constructor(readonly code: "USERNAME" | "PASSWORD" | "PUBLIC_KEY" | "PASSWORD_HASH" | "RECORD") {
    super(`Invalid Linux access ${code.toLowerCase().replaceAll("_", " ")}`);
    this.name = "OwnerValidationError";
  }
}

const RESERVED = new Set([
  "root", "yonder", "yonder-bench", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail",
  "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats", "nobody", "sshd", "_apt",
  "messagebus", "polkitd", "avahi", "dnsmasq", "zerotier-one", "mediamtx", "node-red", "nodered",
  "systemd-network", "systemd-resolve", "systemd-timesync", "systemd-coredump", "tss", "uuidd",
  "sudo", "wheel", "adm", "shadow", "disk", "audio", "video", "input", "netdev", "plugdev",
]);

/** Also check the destination's actual passwd/group databases under the operation guard. */
export function validateOwnerUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,30}$/.test(value)
    || RESERVED.has(value) || value.startsWith("systemd-") || value.startsWith("yonder-")) {
    throw new OwnerValidationError("USERNAME");
  }
  return value;
}

export function validateOwnerPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || Buffer.byteLength(value) > 1024
    || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new OwnerValidationError("PASSWORD");
  return value; // Never trim or normalize an owner's password.
}

/** Supported native crypt formats. Native validation remains mandatory before projection. */
export function validateOwnerPasswordHash(value: unknown): string {
  if (typeof value !== "string") throw new OwnerValidationError("PASSWORD_HASH");
  // Our Trixie helper emits the native yescrypt default. A bounded parameter set
  // prevents a restored record from making PAM allocate attacker-chosen memory.
  if (/^\$y\$j9T\$[./A-Za-z0-9]{22}\$[./A-Za-z0-9]{43}$/.test(value)) return value;
  // Compatibility with native SHA-512 records, including the default 5000 rounds.
  const sha = /^\$6\$(?:rounds=([1-9][0-9]{3,6})\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/.exec(value);
  if (sha && (!sha[1] || (Number(sha[1]) >= 1000 && Number(sha[1]) <= 1_000_000))) return value;
  throw new OwnerValidationError("PASSWORD_HASH");
}

export interface ValidatedPublicKey { line: string; fingerprint: string }

/** Single bare OpenSSH public key; no options, certificates, private keys or extra lines. */
export function validateOwnerPublicKey(value: unknown): ValidatedPublicKey {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 || /[\x00-\x1f\x7f]/.test(value)) throw 0;
    const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) +([A-Za-z0-9+/]+={0,2})(?: +([^\r\n]{1,256}))?$/.exec(value.trim());
    if (!match) throw 0;
    const [, kind, encoded, comment] = match;
    const blob = Buffer.from(encoded!, "base64");
    if (blob.toString("base64").replace(/=+$/, "") !== encoded!.replace(/=+$/, "")) throw 0;
    let cursor = 0;
    const field = (): Buffer => {
      if (cursor + 4 > blob.length) throw 0;
      const length = blob.readUInt32BE(cursor); cursor += 4;
      if (length > blob.length - cursor) throw 0;
      const result = blob.subarray(cursor, cursor + length); cursor += length;
      return result;
    };
    if (!field().equals(Buffer.from(kind!))) throw 0;
    if (kind === "ssh-ed25519") {
      if (field().length !== 32) throw 0;
    } else if (kind === "ssh-rsa") {
      const positive = (): Buffer => {
        const bytes = field();
        if (!bytes.length || (bytes[0]! & 0x80) || (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80))) throw 0;
        return bytes[0] === 0 ? bytes.subarray(1) : bytes;
      };
      const e = positive(), n = positive();
      const bits = n.length * 8 - (Math.clz32(n[0] ?? 0) - 24);
      if (bits < 2048 || bits > 8192 || !e.length || e.length > 8 || !(e[e.length - 1]! & 1)
        || (e.length === 1 && e[0]! < 3)) throw 0;
      createPublicKey({ key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }, format: "jwk" });
    } else {
      const curve = field().toString("utf8");
      if (kind !== `ecdsa-sha2-${curve}`) throw 0;
      const curves: Record<string, { native: string; size: number }> = {
        nistp256: { native: "prime256v1", size: 65 }, nistp384: { native: "secp384r1", size: 97 },
        nistp521: { native: "secp521r1", size: 133 },
      };
      const selected = curves[curve], point = field();
      if (!selected || point.length !== selected.size || point[0] !== 4) throw 0;
      ECDH.convertKey(point, selected.native); // Reject points outside the curve.
    }
    if (cursor !== blob.length) throw 0;
    return {
      line: `${kind} ${blob.toString("base64")}${comment ? ` ${comment.trim()}` : ""}`,
      fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    };
  } catch { throw new OwnerValidationError("PUBLIC_KEY"); }
}

export function validateOwnerRecord(value: unknown): OwnerAccessRecord {
  const parsed = OwnerAccessRecordSchema.safeParse(value);
  if (!parsed.success) throw new OwnerValidationError("RECORD");
  const record = parsed.data;
  validateOwnerUsername(record.username);
  validateOwnerPasswordHash(record.passwordHash);
  const keys = record.authorizedKeys.map(validateOwnerPublicKey);
  if (new Set(keys.map(key => key.fingerprint)).size !== keys.length) throw new OwnerValidationError("PUBLIC_KEY");
  if (record.sshEnabled && !record.sshPasswordAuthentication && keys.length === 0) throw new OwnerValidationError("RECORD");
  return { ...record, authorizedKeys: keys.map(key => key.line) };
}
