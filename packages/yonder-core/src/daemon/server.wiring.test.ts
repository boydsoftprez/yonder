// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers } from "./server.js";
import { DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
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

  /**
   * ADR-0007. The passphrase used to be a random per-device value printed to
   * the journal — which only someone already on the device could read, and
   * joining this access point is how anyone gets on the device. It is now the
   * published default, identical everywhere and never called a secret.
   */
  it("seeds the access point with the published default passphrase", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run,
    });
    expect(secrets.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
    expect(generated).toContain("ap_psk");
  });

  it("gives every device the same passphrase, not a random one each", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const one = buildRenderers({ secretsPath: join(dir, "a.yaml"), dnsmasqPath: join(dir, "y.conf"), runner: run });
    const two = buildRenderers({ secretsPath: join(dir, "b.yaml"), dnsmasqPath: join(dir, "y.conf"), runner: run });
    expect(one.secrets.get("ap_psk")).toBe(two.secrets.get("ap_psk"));
  });

  /**
   * R-SEC-09. The console's administrator password does not exist until the
   * operator sets it; a value seeded here would make the first-run setup step
   * a formality over a credential nobody chose.
   */
  it("does not seed an editor password", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run,
    });
    expect(secrets.get("editor_password")).toBeUndefined();
    expect(generated).not.toContain("editor_password");
  });

  it("does not re-seed a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });

  it("keeps a passphrase the operator has changed", () => {
    const secretsPath = join(dir, "secrets.yaml");
    writeFileSync(secretsPath, "ap_psk: an-operator-chose-this\n", { mode: 0o600 });
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run,
    });
    // The published default is a starting point, never something the daemon
    // reasserts over a choice the operator has already made.
    expect(secrets.get("ap_psk")).toBe("an-operator-chose-this");
    expect(generated).toEqual([]);
  });
});
