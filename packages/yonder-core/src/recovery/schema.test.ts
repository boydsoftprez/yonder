// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { canonicalJson } from "./canonical.js";
import { decodeRecoveryArchive, encodeRecoveryArchive, MAX_RECOVERY_ARCHIVE_BYTES } from "./schema.js";
const source = { version: "2026.9.0", board: "radxa-zero3w" as const, configSchemaVersion: 1 as const };
const state = () => ({ config: structuredClone(DEFAULT_CONFIG), secrets: { admin_password: "private-fixture" }, linuxOwner: null, zeroTier: null });
const bytes = () => encodeRecoveryArchive(state(), source, new Date("2026-09-11T12:00:00Z"));
function change(fn: (archive: any) => void) { const archive = JSON.parse(bytes().toString()); fn(archive); return Buffer.from(JSON.stringify(archive)); }
describe("bounded plain recovery archives", () => {
  it("round trips typed state with stable canonical key order", () => {
    const result = decodeRecoveryArchive(bytes(), "2026.9.0");
    expect(result.payload).toEqual(state());
    expect(canonicalJson({ z: [true, null], a: { y: 2, x: "é" } })).toBe('{"a":{"x":"é","y":2},"z":[true,null]}');
    expect(bytes()).toEqual(bytes());
  });
  it("rejects corruption, unknown sections and unknown nested configuration fields", () => {
    for (const input of [change(a => a.payload.secrets.admin_password = "changed"), change(a => a.bootFiles = {}),
      change(a => a.payload.config.hidden = true), change(a => a.payload.home = "/root")]) {
      expect(() => decodeRecoveryArchive(input, "2026.9.0")).toThrow("invalid");
    }
  });
  it("rejects future archive/application schemas and unsupported older versions", () => {
    for (const input of [change(a => a.formatVersion = 2), change(a => a.source.configSchemaVersion = 2),
      change(a => a.source.version = "2027.1.0"), change(a => a.source.version = "2026.8.0")]) {
      expect(() => decodeRecoveryArchive(input, "2026.9.0")).toThrow();
    }
  });
  it("checks bytes and structure before schema work, without quoting private input", () => {
    expect(() => decodeRecoveryArchive(Buffer.alloc(MAX_RECOVERY_ARCHIVE_BYTES + 1), "2026.9.0")).toThrow("4 MiB");
    expect(() => decodeRecoveryArchive(Buffer.from([0xff]), "2026.9.0")).toThrow("invalid");
    const deep = Buffer.from('['.repeat(40) + '0' + ']'.repeat(40));
    expect(() => decodeRecoveryArchive(deep, "2026.9.0")).toThrow("invalid");
    try { decodeRecoveryArchive(Buffer.from('{"private-fixture"'), "2026.9.0"); } catch (error) { expect(String(error)).not.toContain("private-fixture"); }
  });
  it("accepts exactly the byte limit and refuses an oversized export instead of truncating", () => {
    const archive = bytes();
    const exact = Buffer.concat([archive, Buffer.alloc(MAX_RECOVERY_ARCHIVE_BYTES - archive.length, 0x20)]);
    expect(decodeRecoveryArchive(exact, "2026.9.0").payload).toEqual(state());
    const large = state();
    large.secrets = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`secret${index}`, "x".repeat(256 * 1024)])) as typeof large.secrets;
    expect(() => encodeRecoveryArchive(large, source)).toThrow("4 MiB");
  });
  it("does not accept native account database content as an owner record", () => {
    expect(() => decodeRecoveryArchive(change(a => a.payload.linuxOwner = { username: "root", passwordHash: "!" }), "2026.9.0")).toThrow("invalid");
  });
  it("requires canonical unique sorted mesh memberships and single-line identities", () => {
    for (const zeroTier of [
      { identitySecret: "secret", identityPublic: "public", memberships: [{ networkId: "bbbbbbbbbbbbbbbb" }, { networkId: "aaaaaaaaaaaaaaaa" }] },
      { identitySecret: "secret", identityPublic: "public", memberships: [{ networkId: "aaaaaaaaaaaaaaaa" }, { networkId: "aaaaaaaaaaaaaaaa" }] },
      { identitySecret: "secret\nleak", identityPublic: "public", memberships: [] },
    ]) {
      const candidate = state(); candidate.zeroTier = zeroTier;
      expect(() => encodeRecoveryArchive(candidate, source)).toThrow("invalid");
    }
  });
});
