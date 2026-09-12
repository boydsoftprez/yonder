// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdminClient } from "../admin/client.js";
import { createAdminServer } from "../admin/server.js";
import { hashPassword } from "../console/password.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DurableStateCoordinator } from "../state/coordinator.js";
import { startServer } from "./server.js";

// Real journal, helper socket/client and core startup. Native commands are
// deliberately intercepted: these checks must never operate the host OS.
describe("core startup against a retained helper operation", () => {
  it.each(["restore", "maintenance"] as const)("attaches to %s without disabling durable state", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "yh-"));
    const configPath = join(root, "config.yaml");
    const secretsPath = join(root, "secrets.yaml");
    const userDir = join(root, "console");
    mkdirSync(userDir);
    const sessionPath = join(userDir, ".sessions.json");
    writeFileSync(sessionPath, '{"old-session":true}');
    const config = structuredClone(DEFAULT_CONFIG);
    config.system.hostname = "yonder-before";
    const coordinator = new DurableStateCoordinator({
      root: join(root, "transactions"), configPath, secretsPath,
      maintenanceRoot: join(root, "maintenance"),
      observeStorageMode: () => "protected",
      bootstrap: async () => ({ config, secrets: { ap_psk: "fixture-access-point", admin_password: await hashPassword("fixture-owner-password") }, linuxOwner: null, zeroTier: null }),
    });
    let helper: ReturnType<typeof createAdminServer> | undefined;
    let client: AdminClient | undefined;
    let core: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await coordinator.recover();
      let selected = (await coordinator.status()).activeGeneration;
      if (kind === "restore") {
        const transaction = await coordinator.begin({ id: randomUUID(), kind: "restore" });
        const next = structuredClone(transaction.previous.state);
        next.config.system.hostname = "yonder-restored";
        await transaction.stage(next);
        await transaction.activate();
        selected = (await transaction.commitForRestart(randomUUID())).generation;
      } else await coordinator.requestMaintenance({ id: randomUUID() });
      expect((await coordinator.status()).operation).not.toBeNull();
      const socketPath = join(root, "admin.sock");
      helper = createAdminServer({ coordinator, socketPath });
      if (!helper.listening) await once(helper, "listening");
      client = new AdminClient(socketPath);
      const calls: string[][] = [];
      const rendered: string[] = [];
      core = await startServer({
        socketPath: join(root, "core.sock"), configPath, secretsPath,
        journalPath: join(root, "apply.json"), stateCoordinator: client,
        renderers: [{ name: "observe", async render(value) { rendered.push(value.system.hostname); } }],
        runner: async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
        clock: { now: () => 0, setTimer: () => 1, clearTimer() {} },
        counters: () => null,
        console: { settings: join(userDir, "settings.js"), publicDir: join(userDir, "public"), userDir,
          socket: join(root, "core.sock"), coreTree: join(root, "core"), unit: "yonder-console.service" },
      });
      expect(rendered).toContain(kind === "restore" ? "yonder-restored" : "yonder-before");
      const status = await client.status();
      expect(status.activeGeneration).toBe(selected);
      if (kind === "restore") {
        expect(status.operation).toBeNull();
        expect(existsSync(sessionPath)).toBe(false);
        expect(calls).toContainEqual(["systemctl", "stop", "yonder-console.service"]);
        expect(calls).toContainEqual(["systemctl", "start", "yonder-console.service"]);
        const next = await client.begin({ id: randomUUID(), kind: "config-apply" });
        await next.rollback("integration-probe");
      } else {
        expect(status.operation).toMatchObject({ kind: "maintenance", phase: "awaiting-maintenance-reboot" });
        expect(readFileSync(sessionPath, "utf8")).toContain("old-session");
        await expect(client.begin({ id: randomUUID(), kind: "config-apply" })).rejects.toMatchObject({ code: "STATE_BUSY" });
      }
    } finally {
      await core?.close();
      client?.close();
      if (helper) await new Promise<void>((resolve) => helper!.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
