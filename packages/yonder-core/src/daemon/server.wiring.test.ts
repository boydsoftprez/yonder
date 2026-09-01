// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers } from "./server.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-wire-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("buildRenderers", () => {
  it("produces a network renderer", () => {
    saveConfig(join(dir, "config.yaml"), DEFAULT_CONFIG);
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { renderers } = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      dnsmasqPath: join(dir, "y.conf"),
      runner: run,
    });
    expect(renderers.map((r) => r.name)).toEqual(["network"]);
  });

  it("generates the access-point secret if it is absent", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run,
    });
    expect(secrets.get("ap_psk")).toBeTruthy();
    expect(generated).toContain("ap_psk");
  });

  it("does not regenerate a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });
});
