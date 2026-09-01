// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./routes.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Clock, Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";

let dir: string, configPath: string, journalPath: string;
const noopRenderer: Renderer = { name: "noop", async render() {} };
const frozenClock: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-api-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function router() {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  return createRouter({ engine, configPath });
}

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

describe("router", () => {
  it("GET /config returns the current configuration", async () => {
    const res = await router()("GET", "/config", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { version: number }).version).toBe(1);
  });

  it("GET /status reports idle before any apply", async () => {
    const res = await router()("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe("idle");
  });

  it("POST /apply returns 200 and an id", async () => {
    const res = await router()("POST", "/apply", changed());
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBeTruthy();
  });

  it("POST /apply returns 400 with issues when config is invalid", async () => {
    const res = await router()("POST", "/apply", { version: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("POST /confirm keeps the change", async () => {
    const r = router();
    const applied = await r("POST", "/apply", changed());
    const id = (applied.body as { id: string }).id;
    const res = await r("POST", "/confirm", { id });
    expect(res.status).toBe(200);
    expect(((await r("GET", "/status", undefined)).body as { state: string }).state).toBe("confirmed");
  });

  it("POST /confirm with a wrong id returns 400", async () => {
    const r = router();
    await r("POST", "/apply", changed());
    const res = await r("POST", "/confirm", { id: "wrong" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await router()("GET", "/nope", undefined);
    expect(res.status).toBe(404);
  });
});
