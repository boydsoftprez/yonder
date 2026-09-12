// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { decodeAdminRequest, encodeAdminMessage } from "./protocol.js";
import { MAX_RECOVERY_ARCHIVE_BYTES } from "../recovery/schema.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("admin protocol", () => {
  it("accepts only allowlisted typed operations", () => {
    expect(decodeAdminRequest(JSON.stringify({ id, method: "state.status", params: {} })))
      .toEqual({ id, method: "state.status", params: {} });
    expect(() => decodeAdminRequest(JSON.stringify({
      id,
      method: "state.status",
      params: { path: "/etc/shadow" },
    }))).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => decodeAdminRequest(JSON.stringify({ id, method: "exec", params: {} }))).toThrow();
  });

  it("accepts bounded owner operations and rejects loose or secret-shaped parameters", () => {
    expect(decodeAdminRequest(JSON.stringify({
      id,
      method: "owner.create",
      params: { username: "pilot", newPassword: "owner-password", confirmPassword: "owner-password" },
    }))).toEqual({
      id,
      method: "owner.create",
      params: { username: "pilot", newPassword: "owner-password", confirmPassword: "owner-password" },
    });
    expect(() => decodeAdminRequest(JSON.stringify({
      id,
      method: "owner.ssh",
      params: { enabled: true, passwordAuthentication: false, authorizedKeys: [], passwordHash: "private" },
    }))).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => decodeAdminRequest(JSON.stringify({
      id,
      method: "owner.password",
      params: { newPassword: "x".repeat(1025), confirmPassword: "x".repeat(1025) },
    }))).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("rejects standard controls over 64 KiB and permits bounded staged state", () => {
    expect(() => decodeAdminRequest(JSON.stringify({
      id,
      method: "state.rollback",
      params: { id, reasonCode: `x${"a".repeat(70 * 1024)}` },
    }))).toThrowError(expect.objectContaining({ code: "REQUEST_TOO_LARGE" }));
    const state = { config: DEFAULT_CONFIG, secrets: { blob: "x".repeat(70 * 1024) }, linuxOwner: null, zeroTier: null };
    expect(decodeAdminRequest(JSON.stringify({ id, method: "state.stage", params: { id, state } })).method)
      .toBe("state.stage");
  });

  it("admits one exact 4 MiB recovery archive without widening ordinary controls", () => {
    const exact = Buffer.alloc(MAX_RECOVERY_ARCHIVE_BYTES).toString("base64");
    expect(decodeAdminRequest(JSON.stringify({ id, method: "recovery.preview", params: {
      archiveBase64: exact, sessionId: "session_owner_123456",
    } })).method).toBe("recovery.preview");
    const oversized = Buffer.alloc(MAX_RECOVERY_ARCHIVE_BYTES + 1).toString("base64");
    expect(() => decodeAdminRequest(JSON.stringify({ id, method: "recovery.preview", params: {
      archiveBase64: oversized, sessionId: "session_owner_123456",
    } }))).toThrowError(expect.objectContaining({ code: "REQUEST_TOO_LARGE" }));
    expect(() => decodeAdminRequest(JSON.stringify({ id, method: "recovery.preview", params: {
      archiveBase64: "not base64", sessionId: "session_owner_123456",
    } }))).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => decodeAdminRequest(JSON.stringify({ id, method: "state.status", params: {
      archiveBase64: exact,
    } }))).toThrowError(expect.objectContaining({ code: "REQUEST_TOO_LARGE" }));
  });

  it("rejects excessive structural depth before dispatch", () => {
    const deep = `{"id":"${id}","method":"state.status","params":${"[".repeat(65)}0${"]".repeat(65)}}`;
    expect(() => decodeAdminRequest(deep)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("bounds encoded replies without serializing secret-bearing failures", () => {
    expect(encodeAdminMessage({ id, ok: false, error: { code: "INTERNAL", message: "admin operation failed" } }))
      .toContain("admin operation failed");
    expect(() => encodeAdminMessage({ id, ok: true, result: "x".repeat(5 * 1024 * 1024) }))
      .toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });
});
