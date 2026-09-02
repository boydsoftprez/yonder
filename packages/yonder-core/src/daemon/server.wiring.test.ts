// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers, consolePathsFromEnv } from "./server.js";
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
      runner: run,
    });
    expect(renderers.map((r) => r.name)).toEqual(["network"]);
  });

  /**
   * Absent unless a caller says where the console is. That is what stops a
   * test — or a future call site that forgot an option — writing to
   * /opt/yonder on whatever machine it happens to run on. Production supplies
   * the paths from consolePathsFromEnv, in main().
   */
  it("produces no console renderer when nobody said where the console is", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({ secretsPath: join(dir, "secrets.yaml"), runner: run });
    expect(built.consoleRenderer).toBeUndefined();
    expect(built.renderers.map((r) => r.name)).toEqual(["network"]);
  });

  /**
   * Order is load-bearing. Renderers run in sequence, so the console goes
   * behind a network that has already settled: if the console then fails and
   * the apply rolls back, the rollback re-renders a network that was working.
   * The reverse order would let a console failure leave the access point
   * untouched by either pass, which is rule 6.
   */
  it("puts the console renderer after the network one", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers.map((r) => r.name)).toEqual(["network", "console"]);
    expect(built.consoleRenderer).toBeDefined();
  });
});

describe("consolePathsFromEnv", () => {
  it("uses the installed paths when the environment says nothing", () => {
    expect(consolePathsFromEnv({})).toEqual({
      settings: "/opt/yonder/console/settings.js",
      userDir: "/var/lib/yonder/console",
      socket: "/run/yonder/core.sock",
      coreTree: "/opt/yonder/packages/yonder-core",
      unit: "yonder-console.service",
    });
  });

  it("takes the socket from the same variable the daemon binds", () => {
    // One variable, so the daemon and the console cannot end up pointed at
    // two different sockets — which would be a console that can never
    // authenticate anyone and a device nobody can log in to.
    expect(consolePathsFromEnv({ YONDER_SOCKET: "/tmp/probe.sock" }).socket).toBe("/tmp/probe.sock");
  });

  it("lets the tree the console requires its wiring from be moved", () => {
    // The generated settings.js requires a module out of the daemon's own
    // installed tree, so an install with a different prefix has to be able to
    // say where that is. Same for the unit, which the renderer restarts.
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_CORE_TREE: "/srv/yonder/core",
      YONDER_CONSOLE_UNIT: "yonder-console-test.service",
    });
    expect(paths.coreTree).toBe("/srv/yonder/core");
    expect(paths.unit).toBe("yonder-console-test.service");
  });

  it("lets the settings path and userDir be moved", () => {
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_SETTINGS: "/srv/console/settings.js",
      YONDER_CONSOLE_USERDIR: "/srv/console/state",
    });
    expect(paths.settings).toBe("/srv/console/settings.js");
    expect(paths.userDir).toBe("/srv/console/state");
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
      secretsPath, runner: run,
    });
    expect(secrets.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
    expect(generated).toContain("ap_psk");
  });

  it("gives every device the same passphrase, not a random one each", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const one = buildRenderers({ secretsPath: join(dir, "a.yaml"), runner: run });
    const two = buildRenderers({ secretsPath: join(dir, "b.yaml"), runner: run });
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
      secretsPath, runner: run,
    });
    expect(secrets.get("editor_password")).toBeUndefined();
    expect(generated).not.toContain("editor_password");
  });

  it("does not re-seed a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, runner: run });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, runner: run });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });

  it("keeps a passphrase the operator has changed", () => {
    const secretsPath = join(dir, "secrets.yaml");
    writeFileSync(secretsPath, "ap_psk: an-operator-chose-this\n", { mode: 0o600 });
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run,
    });
    // The published default is a starting point, never something the daemon
    // reasserts over a choice the operator has already made.
    expect(secrets.get("ap_psk")).toBe("an-operator-chose-this");
    expect(generated).toEqual([]);
  });
});
