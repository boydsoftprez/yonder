// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./routes.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { AdminCredential } from "../console/credential.js";
import { SecretStore } from "../secrets/store.js";
import { DiagnosticJobs } from "../diag/jobs.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-tools-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function harness() {
  const configPath = join(dir, "config.yaml"); saveConfig(configPath, DEFAULT_CONFIG);
  const store = new SecretStore(join(dir, "secrets.yaml")); const credential = new AdminCredential(store);
  const engine = new ApplyEngine({ configPath, journalPath: join(dir, "journal.json"), renderers: [] });
  const reboot = vi.fn(async () => {}), onPasswordChanged = vi.fn(); let refusal: string | null = null;
  const jobs = new DiagnosticJobs({ runner: () => ({ done: Promise.resolve({ code: 0 }), stop() {} }), devices: async () => [] });
  const router = createRouter({ engine, configPath, credential, reboot, onPasswordChanged, diagnosticJobs: jobs,
    rebootRefusal: () => refusal, interfaces: async () => ({ sampledAt: 1, interfaces: [], routes: [], defaultRoutes: [] }) });
  return { router, store, engine, credential, reboot, onPasswordChanged, refuse: (reason: string) => { refusal = reason; } };
}
describe("device maintenance routes", () => {
  it("keeps new tools behind provisioning and requires explicit reboot confirmation", async () => {
    const h = harness();
    expect((await h.router("GET", "/net/interfaces")).status).toBe(403);
    expect((await h.router("POST", "/system/reboot", { confirm: "REBOOT" })).status).toBe(403);
    h.credential.set("old password");
    expect((await h.router("POST", "/system/reboot", {})).status).toBe(400);
    h.refuse("Disarm before rebooting.");
    expect((await h.router("POST", "/system/reboot", { confirm: "REBOOT" })).status).toBe(409);
    expect(h.reboot).not.toHaveBeenCalled();
  });
  it("persists password changes, rejects the old password, and triggers session invalidation only after success", async () => {
    const h = harness(); h.credential.set("old password");
    expect((await h.router("POST", "/admin/change-password", { currentPassword: "wrong", newPassword: "new password", confirmPassword: "new password" })).status).toBe(401);
    expect(h.onPasswordChanged).not.toHaveBeenCalled();
    expect((await h.router("POST", "/admin/change-password", { currentPassword: "old password", newPassword: "new password", confirmPassword: "new password" })).status).toBe(200);
    expect(h.credential.verify("old password")).toBe(false);
    expect(new AdminCredential(new SecretStore(join(dir, "secrets.yaml"))).verify("new password")).toBe(true);
    expect(h.onPasswordChanged).toHaveBeenCalledOnce();
    expect(readFileSync(join(dir, "secrets.yaml"), "utf8")).not.toContain("new password");
  });
  it("does not change a password on mismatch or failed persistence", async () => {
    const h = harness(); h.credential.set("old password");
    expect((await h.router("POST", "/admin/change-password", { currentPassword: "old password", newPassword: "new password", confirmPassword: "different" })).status).toBe(400);
    vi.spyOn(h.store, "put").mockImplementation(() => { throw new Error("disk unavailable"); });
    expect((await h.router("POST", "/admin/change-password", { currentPassword: "old password", newPassword: "new password", confirmPassword: "new password" })).status).toBe(500);
    expect(h.onPasswordChanged).not.toHaveBeenCalled();
    expect(h.credential.verify("old password")).toBe(true);
  });
  it("schedules a reboot only when explicitly confirmed and the engine is idle", async () => {
    const h = harness(); h.credential.set("old password");
    expect((await h.router("POST", "/system/reboot", { confirm: "REBOOT" })).status).toBe(200);
    expect(h.reboot).toHaveBeenCalledOnce();
  });
  it("allows a reboot after a confirmed palette change", async () => {
    const h = harness(); h.credential.set("old password");
    await h.router("POST", "/ui/theme", { theme: "night" });
    expect(h.engine.status().state).toBe("confirmed");
    expect((await h.router("POST", "/system/reboot", { confirm: "REBOOT" })).status).toBe(200);
  });
});
