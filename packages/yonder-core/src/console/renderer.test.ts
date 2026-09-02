// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleRenderer } from "./renderer.js";
import { AdminCredential } from "./credential.js";
import { SecretStore } from "../secrets/store.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

let dir: string, consoleDir: string, settingsPath: string, secretsPath: string;
let ran: string[][];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-console-render-"));
  consoleDir = join(dir, "console");
  mkdirSync(consoleDir);
  settingsPath = join(consoleDir, "settings.js");
  secretsPath = join(dir, "secrets.yaml");
  ran = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok: CommandRunner = async (argv) => { ran.push(argv); return { code: 0, stdout: "", stderr: "" }; };

function failing(code: number, stderr: string): CommandRunner {
  return async (argv) => { ran.push(argv); return { code, stdout: "", stderr }; };
}

function credential(withPassword = false): AdminCredential {
  const c = new AdminCredential(new SecretStore(secretsPath));
  if (withPassword) c.set("a long enough password");
  return c;
}

function renderer(runner: CommandRunner = ok, opts: { provisioned?: boolean; unit?: string } = {}): ConsoleRenderer {
  return new ConsoleRenderer({
    runner,
    credential: credential(opts.provisioned === true),
    paths: {
      settings: settingsPath,
      userDir: join(dir, "userdir"),
      socket: join(dir, "core.sock"),
      coreTree: join(dir, "core"),
      ...(opts.unit === undefined ? {} : { unit: opts.unit }),
    },
  });
}

function config(edit: (c: Config) => void = () => {}): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  edit(c);
  return c;
}

describe("ConsoleRenderer", () => {
  it("is a renderer named console", () => {
    expect(renderer().name).toBe("console");
  });

  it("writes settings.js and restarts the console", async () => {
    await renderer().render(config());
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toContain("GENERATED FILE");
    expect(ran).toEqual([["systemctl", "restart", "yonder-console.service"]]);
  });

  it("writes a file the console's user can read", () => {
    // Mode 0644: it carries no secret and the console is not root.
    return renderer().render(config()).then(() => {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o644);
    });
  });

  /**
   * Rule 6, through the side door. The console is the internet-adjacent
   * surface; yonder-core is what holds the network up. A console renderer
   * that could restart the daemon would be a console able to take the
   * device's only means of being reached down with it.
   */
  it("restarts only the console, never the daemon", async () => {
    await renderer().render(config());
    await renderer(ok, { provisioned: true }).render(config());
    for (const argv of ran) {
      expect(argv.join(" ")).not.toContain("yonder-core");
      expect(argv.join(" ")).not.toContain("NetworkManager");
      expect(argv[0]).toBe("systemctl");
      expect(argv[1]).toBe("restart");
    }
  });

  it("refuses at construction to be pointed at the daemon's unit", () => {
    expect(() => renderer(ok, { unit: "yonder-core.service" }))
      .toThrow(/will not restart yonder-core/);
  });

  it("writes nothing but settings.js and the generated palette", async () => {
    await renderer().render(config());
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(consoleDir).sort()).toEqual(["public", "settings.js"]);
    expect(readdirSync(join(consoleDir, "public"))).toEqual(["theme.css"]);
  });

  /**
   * The palette is generated from `ui.theme` (R-UI-07) and lives in a
   * directory of its own. `httpStatic` serves that directory in front of the
   * login gate — gating a stylesheet would mean an unstyled login page — so
   * anything in it is readable by whoever can reach the port, and
   * `settings.js` must stay one level up.
   */
  it("puts the palette somewhere httpStatic can serve without exposing settings.js", async () => {
    await renderer().render(config());
    const { readFileSync, readdirSync } = await import("node:fs");
    const publicDir = join(consoleDir, "public");
    expect(readdirSync(publicDir)).not.toContain("settings.js");
    expect(readFileSync(join(publicDir, "theme.css"), "utf8")).toContain("--yonder-background");
  });

  it("writes the palette the configuration asks for", async () => {
    const night = config();
    night.ui.theme = "night";
    await renderer().render(night);
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(consoleDir, "public", "theme.css"), "utf8");
    expect(css).toContain('--yonder-theme: "night"');
    expect(css).not.toContain('--yonder-theme: "day"');
  });

  /**
   * **A theme change must not restart the console**, and that is the whole
   * reason the palette is a separate file.
   *
   * A theme goes through the apply engine like every other change, so it has
   * to be confirmed from the other side within the window or it reverts
   * (R-CFG-03). A restart signs the operator out (K-18) — so if choosing a
   * theme bounced the console, the operator would have to sign back in and
   * confirm before the timer ran out, and the ordinary outcome would be a
   * theme that reverted.
   */
  it("rewrites the palette without restarting, when only the theme changed", async () => {
    const calls: string[][] = [];
    const recording = renderer(async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; });
    await recording.render(config());
    calls.length = 0;

    const night = config();
    night.ui.theme = "night";
    await recording.render(night);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(consoleDir, "public", "theme.css"), "utf8"))
      .toContain('--yonder-theme: "night"');
    expect(calls).toEqual([]);
  });

  /** A change that does touch settings.js still restarts, as it always did. */
  it("still restarts when settings.js itself changed", async () => {
    const calls: string[][] = [];
    const recording = renderer(async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; });
    await recording.render(config());
    calls.length = 0;

    const moved = config();
    moved.ui.port = 3001;
    await recording.render(moved);
    expect(calls.map((c) => c.join(" "))).toEqual(["systemctl restart yonder-console.service"]);
  });

  /**
   * Not an optimisation. Restarting unconditionally would log the operator
   * out of the console on every network change they made from it, and would
   * bounce the console every time yonder-core restarted, because start-up
   * renders the current configuration.
   */
  it("does not restart the console when nothing about it has changed", async () => {
    const r = renderer();
    await r.render(config());
    expect(ran).toHaveLength(1);
    await r.render(config());
    await r.render(config());
    expect(ran).toHaveLength(1);
  });

  it("restarts when the configuration changes the console", async () => {
    const r = renderer();
    await r.render(config());
    await r.render(config((c) => { c.ui.port = 8080; }));
    expect(ran).toHaveLength(2);
    expect(readFileSync(settingsPath, "utf8")).toContain("uiPort: 8080");
  });

  it("restarts when the device gains an administrator password", async () => {
    await renderer().render(config());
    expect(readFileSync(settingsPath, "utf8")).toContain("httpAdminRoot: false");

    // A second renderer over the same secrets file, now provisioned — which
    // is what the daemon builds after POST /admin/password.
    await renderer(ok, { provisioned: true }).render(config());
    expect(ran).toHaveLength(2);
    const text = readFileSync(settingsPath, "utf8");
    expect(text).toContain('httpAdminRoot: "/editor"');
    expect(text).toContain("provisioned: true");
  });

  it("fails the render when the console will not restart", async () => {
    const r = renderer(failing(1, "Failed to restart yonder-console.service: Unit not found."));
    await expect(r.render(config())).rejects.toThrow(/could not restart yonder-console\.service/);
  });

  it("fails the render when there is no systemctl at all", async () => {
    // execFile reports ENOENT as exit 127 with an empty stderr, which is why
    // the message has to survive an empty detail rather than reading
    // "... : undefined".
    const r = renderer(async (argv) => { ran.push(argv); return { code: 127, stdout: "", stderr: "" }; });
    await expect(r.render(config())).rejects.toThrow(/exit 127/);
  });

  it("leaves the written settings in place when the restart fails", async () => {
    // The apply engine rolls the configuration back and re-renders, which
    // rewrites this file. Deleting it here would leave a window with no
    // settings.js at all, and a console that cannot start for a different
    // reason than the one being reported.
    const r = renderer(failing(1, "no"));
    await expect(r.render(config())).rejects.toThrow();
    expect(existsSync(settingsPath)).toBe(true);
  });

  /**
   * A board where 30-console.sh never ran — or ran and failed on a node too
   * old — must still be able to apply a network change. Failing here would
   * fail every apply for ever, and what it would take with it is the
   * operator's only way to fix the network.
   */
  it("skips, loudly, when there is no console installed", async () => {
    const lines: string[] = [];
    const r = new ConsoleRenderer({
      runner: ok,
      credential: credential(),
      paths: { settings: join(dir, "not-installed", "settings.js") },
      log: (l) => lines.push(l),
    });
    await expect(r.render(config())).resolves.toBeUndefined();
    expect(ran).toEqual([]);
    expect(lines.join(" ")).toMatch(/no console to configure/);
  });

  it("never reads the password hash, only whether there is one", async () => {
    await renderer(ok, { provisioned: true }).render(config());
    const text = readFileSync(settingsPath, "utf8");
    const hash = new SecretStore(secretsPath).get("admin_password");
    expect(hash).toBeDefined();
    expect(text).not.toContain(hash!);
    expect(text).not.toContain("scrypt$");
  });
});
