// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceTokenStore } from "./maintenance.js";

let dir: string;
let store: MaintenanceTokenStore;
const id = "12345678-1234-4123-8123-123456789abc";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-maintenance-"));
  store = new MaintenanceTokenStore(join(dir, "state", "maintenance"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MaintenanceTokenStore", () => {
  it("durably publishes, consumes once, and clears one exact operation", () => {
    store.publish(id);
    expect(store.read()).toEqual({ state: "pending", operationId: id });
    expect(readFileSync(join(store.root, "pending.json"), "utf8"))
      .toBe(`{"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"${id}"}\n`);
    store.consume(id);
    expect(store.read()).toEqual({ state: "consumed", operationId: id });
    expect(() => store.consume(id)).toThrow("unavailable or corrupt");
    store.clear(id);
    expect(store.read()).toBeNull();
  });

  it("durably discards the owned temporary file left by a cut before publish", () => {
    store.publish(id);
    const pending = join(store.root, "pending.json");
    const temporary = join(store.root, "pending.json.tmp");
    renameSync(pending, temporary);

    expect(store.read()).toBeNull();
    expect(existsSync(temporary)).toBe(false);
    expect(store.read()).toBeNull();
  });

  it("accepts the exact pending token once its atomic publish rename is visible", () => {
    store.publish(id);
    const pending = join(store.root, "pending.json");
    const temporary = join(store.root, "pending.json.tmp");
    renameSync(pending, temporary);
    renameSync(temporary, pending);
    expect(store.read()).toEqual({ state: "pending", operationId: id });
  });

  it("rejects malformed or ambiguous interrupted-publish state", () => {
    store.publish(id);
    const pending = join(store.root, "pending.json");
    const temporary = join(store.root, "pending.json.tmp");
    renameSync(pending, temporary);
    chmodSync(temporary, 0o644);
    expect(() => store.read()).toThrow("unavailable or corrupt");

    chmodSync(temporary, 0o600);
    writeFileSync(pending,
      `{"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"${id}"}\n`, { mode: 0o600 });
    expect(() => store.read()).toThrow("unavailable or corrupt");
  });

  it("rejects a duplicate token, a foreign operation and permissive extra JSON", () => {
    store.publish(id);
    expect(() => store.publish("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toThrow("unavailable or corrupt");
    expect(() => store.consume("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toThrow("unavailable or corrupt");
    writeFileSync(join(store.root, "pending.json"), `{"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"${id}","extra":true}\n`);
    chmodSync(join(store.root, "pending.json"), 0o600);
    expect(() => store.read()).toThrow("unavailable or corrupt");
    writeFileSync(join(store.root, "pending.json"),
      ` {"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"${id}"}\n`);
    chmodSync(join(store.root, "pending.json"), 0o600);
    expect(() => store.read()).toThrow("unavailable or corrupt");
  });

  it("rejects a token whose mode no longer proves root-private ownership intent", () => {
    store.publish(id);
    chmodSync(join(store.root, "pending.json"), 0o644);
    expect(() => store.read()).toThrow("unavailable or corrupt");
  });

  it("rejects oversized input before parsing it", () => {
    store.publish(id);
    writeFileSync(join(store.root, "pending.json"), "x".repeat(513));
    chmodSync(join(store.root, "pending.json"), 0o600);
    expect(() => store.read()).toThrow("unavailable or corrupt");
  });
});
