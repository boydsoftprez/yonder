// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential } from "../console/credential.js";
import { DaemonClient } from "../console/client.js";

it("wires the real theme API to only render and persist the console palette", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yonder-palette-"));
  const configPath = join(dir, "config.yaml"), secretsPath = join(dir, "secrets.yaml");
  const socketPath = join(dir, "core.sock"), publicDir = join(dir, "public");
  const config = structuredClone(DEFAULT_CONFIG); config.network.ap.enabled = false;
  config.ui.theme = "night"; saveConfig(configPath, config);
  new AdminCredential(new SecretStore(secretsPath)).set("isolated theme test");
  mkdirSync(publicDir);
  const calls: string[][] = [];
  const server = await startServer({
    configPath, secretsPath, socketPath, journalPath: join(dir, "apply.json"), renderers: [],
    clock: { now: () => 1, setTimer: () => 1, clearTimer() {} },
    console: { settings: join(dir, "settings.cjs"), publicDir, userDir: dir, socket: socketPath, coreTree: dir },
    runner: async argv => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
  });
  try {
    const client = new DaemonClient({ socketPath });
    calls.length = 0;
    const reply = await client.request({ method: "POST", path: "/ui/theme", body: { theme: "day" } });
    expect(reply).toMatchObject({ ok: true, status: 200, body: { expiresAt: null } });
    expect(readFileSync(join(publicDir, "theme.css"), "utf8")).toContain('--yonder-theme: "day"');
    expect(calls, "appearance change must issue no network, camera or service command").toEqual([]);
    expect(await client.request({ method: "GET", path: "/ui/preferences" })).toMatchObject({ status: 200, body: { theme: "day" } });
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
