// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "./store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-sec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("SecretStore", () => {
  // R-STO-03/R-SEC-10: a failed first-owner/AP credential write must not
  // appear configured in memory while the next boot finds no credential.
  for (const operation of ["ensure", "ensureValue"] as const) {
    it(`does not cache a failed ${operation}, and permits a durable retry`, () => {
      const parent = join(dir, "not-mounted");
      const path = join(parent, "secrets.yaml");
      const store = new SecretStore(path);
      const attempt = () => operation === "ensure"
        ? store.ensure("admin_password", "password")
        : store.ensureValue("admin_password", "fixture-password-hash");
      expect(attempt).toThrow(/cannot write/);
      expect(store.get("admin_password")).toBeUndefined();
      mkdirSync(parent);
      const retried = attempt();
      expect(retried.created).toBe(true);
      expect(new SecretStore(path).get("admin_password")).toBe(retried.value);
    });
  }

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

  it("sets a fixed value on first ensureValue and reports it as new", () => {
    const s = new SecretStore(join(dir, "secrets.yaml"));
    const first = s.ensureValue("ap_psk", "yonder1234");
    expect(first).toEqual({ value: "yonder1234", created: true });
    // A published default is a starting point. Once the value is there it is
    // the device's, and a later start must not put the default back.
    expect(s.ensureValue("ap_psk", "yonder1234")).toEqual({ value: "yonder1234", created: false });
  });

  it("never replaces an existing value with the one ensureValue was given", () => {
    const p = join(dir, "secrets.yaml");
    const s = new SecretStore(p);
    s.ensureValue("ap_psk", "an-operator-chose-this");
    expect(s.ensureValue("ap_psk", "yonder1234")).toEqual({
      value: "an-operator-chose-this", created: false,
    });
    expect(new SecretStore(p).get("ap_psk")).toBe("an-operator-chose-this");
  });

  it("reloads an atomically projected set without retaining removed rows", () => {
    const path = join(dir, "secrets.yaml");
    const store = new SecretStore(path);
    store.put("old", "old-value");
    writeFileSync(path, "fresh: fresh-value\n", { mode: 0o600 });
    store.reload();
    expect(store.get("old")).toBeUndefined();
    expect(store.get("fresh")).toBe("fresh-value");
    expect(store.snapshot()).toEqual({ fresh: "fresh-value" });
  });

  it("keeps its previous view when a projected file is unreadable", () => {
    const path = join(dir, "secrets.yaml");
    const store = new SecretStore(path);
    store.put("kept", "kept-value");
    writeFileSync(path, "kept:\n\tbad", { mode: 0o600 });
    expect(() => store.reload()).toThrow(/not valid YAML/);
    expect(store.get("kept")).toBe("kept-value");
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

  it("rejects a secrets file that is not a flat map of strings", () => {
    const p = join(dir, "secrets.yaml");
    writeFileSync(p, "ap_psk:\n  nested: true\n");
    expect(() => new SecretStore(p)).toThrow(/flat map/);
  });
});

describe("SecretStore, when the file will not parse", () => {
  // The passphrase and the hash below are what a real secrets.yaml holds, and
  // the YAML parser quotes the line it choked on straight back into its
  // error message. That message used to reach ApplyStatus.degraded and so
  // GET /status, which sits in front of the administrator-password gate.
  // R-SEC-10: no credential in an error message or an API response.
  const PSK = "field-passphrase-do-not-leak";
  const HASH = "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2g";

  const malformed = [
    ["a tab for indentation", `ap_psk: ${PSK}\n\tadmin_password: ${HASH}\n`],
    ["an unclosed quote", `ap_psk: "${PSK}\n  admin_password: ${HASH}\n`],
    ["a duplicated key", `ap_psk: ${PSK}\nap_psk: ${HASH}\n`],
  ] as const;

  for (const [why, text] of malformed) {
    it(`refuses ${why} without repeating what it read`, () => {
      const path = join(dir, "secrets.yaml");
      writeFileSync(path, text);

      let thrown: Error | undefined;
      try { new SecretStore(path); } catch (e) { thrown = e as Error; }

      // It must fail — a file it cannot parse is not a file it may treat as
      // empty, because an empty bag looks exactly like a device with no
      // administrator password set.
      expect(thrown, "a malformed secrets.yaml must not parse as an empty one").toBeDefined();

      // Everything the caller could ever print. `message` already folds the
      // issues in, but assert on both so neither can regress alone.
      const surfaces = [thrown!.message, ...((thrown as { issues?: string[] }).issues ?? [])].join("\n");
      expect(surfaces).not.toContain(PSK);
      expect(surfaces).not.toContain(HASH);

      // And it still has to be useful to whoever has to fix the file.
      expect(surfaces).toContain(path);
    });
  }

  it("keeps the position, which names nothing", () => {
    const path = join(dir, "secrets.yaml");
    writeFileSync(path, `ap_psk: ${PSK}\n\tadmin_password: ${HASH}\n`);
    try { new SecretStore(path); } catch (e) {
      expect((e as Error).message).toMatch(/line \d+, column \d+/);
    }
  });
});
