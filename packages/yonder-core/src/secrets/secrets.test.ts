// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "./store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-sec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("SecretStore", () => {
  it("creates a secret on first ensure and reports it as new", () => {
    const s = new SecretStore(join(dir, "secrets.yaml"));
    const first = s.ensure("ap_psk", "psk");
    expect(first.created).toBe(true);
    const second = s.ensure("ap_psk", "psk");
    expect(second.created).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it("writes the file 0600", () => {
    const p = join(dir, "secrets.yaml");
    new SecretStore(p).ensure("ap_psk", "psk");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("persists across instances", () => {
    const p = join(dir, "secrets.yaml");
    const value = new SecretStore(p).ensure("ap_psk", "psk").value;
    expect(new SecretStore(p).get("ap_psk")).toBe(value);
  });

  it("resolves a secret reference", () => {
    const p = join(dir, "secrets.yaml");
    const s = new SecretStore(p);
    const value = s.ensure("editor_password", "password").value;
    expect(s.resolve({ secret: "editor_password" })).toBe(value);
  });

  it("throws when resolving a reference that does not exist", () => {
    const s = new SecretStore(join(dir, "secrets.yaml"));
    expect(() => s.resolve({ secret: "missing" })).toThrow(/missing/);
  });
});
