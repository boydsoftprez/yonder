// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers, consolePathsFromEnv, startServer, SIGNAL_POLL_SECONDS } from "./server.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import type { Renderer } from "../apply/types.js";
import type { CommandResult } from "../net/runner.js";
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
    expect(renderers.map((r) => r.name)).toEqual(["hostname", "network"]);
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
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network"]);
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
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "console"]);
    expect(built.consoleRenderer).toBeDefined();
  });

  /**
   * In front of the network, and for the mirror image of the reason the
   * console is behind it. K-19: a failing renderer stops the ones behind it.
   * HostnameRenderer cannot fail, so nothing is put at risk by going first —
   * and a board whose NetworkManager is wedged still gets the name its
   * configuration gives it, which is the board most likely to be searched for
   * by name.
   */
  it("puts the hostname renderer in front of everything, because it cannot fail", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers[0]?.name).toBe("hostname");
  });
});

describe("consolePathsFromEnv", () => {
  it("uses the installed paths when the environment says nothing", () => {
    expect(consolePathsFromEnv({})).toEqual({
      settings: "/var/lib/yonder/console/settings.js",
      publicDir: "/var/lib/yonder/console/public",
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

/**
 * The daemon's own wiring, over the socket.
 *
 * These exist for one reason: every layer below has its own tests, and all of
 * them keep passing if the line in `startServer` that connects one to the
 * socket is deleted. A modem this daemon can read but never serves, and a
 * reach monitor nothing asks, are both a green suite and a blank page.
 */
const FIXTURES = new URL("../net/modem/mmcli/fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/** Talk to the daemon the way the console will: over the Unix socket. */
function call(socketPath: string, method: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * A board with the measured modem on it, answered from the same fixtures the
 * mmcli client's own tests read. Nothing here reaches a real command: the
 * runner is the only way anything in this daemon shells out, and this is it.
 */
function boardRunner(seen: string[][]): CommandRunner {
  return async (argv): Promise<CommandResult> => {
    seen.push(argv);
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "mmcli") {
      if (argv[1] === "-L") return ok(fixture("modem-list.txt"));
      if (argv[1] === "-m" && argv[2] === "/org/freedesktop/ModemManager1/Modem/0") {
        if (argv.includes("--signal-get")) return ok(fixture("signal-get.txt"));
        if (argv.some((a) => a.startsWith("--signal-setup"))) return ok("");
        return ok(fixture("modem-show.txt"));
      }
      if (argv[1] === "-b") {
        return ok(argv[2]?.endsWith("/1") === true
          ? fixture("bearer-connected.txt")
          : fixture("bearer-initial.txt"));
      }
    }
    if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
      return ok("eth0:ethernet:connected:yonder-eth\ncdc-wdm0:gsm:connected:yonder-modem\n");
    }
    return ok("");
  };
}

describe("the daemon serves what M3a assembles", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    saveConfig(configPath, DEFAULT_CONFIG);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  async function serve(seen: string[][]): Promise<{ close(): Promise<void> }> {
    return startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: boardRunner(seen),
    });
  }

  it("serves GET /modem/state from ModemManager", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      // Read from the device, not from the configuration: the APN comes off
      // the *connected* bearer, so this is what the link is using rather than
      // what was asked for.
      expect(res.body).toMatchObject({ operator: "Dark Star", technology: "lte", apn: "ereseller" });
    } finally {
      await server.close();
    }
  });

  it("serves GET /reach/state", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      expect(res.status).toBe(200);
      const state = res.body as { paths: { path: string }[]; carrying: boolean };
      expect(state.paths.map((p) => p.path)).toContain("modem");
      // Nothing has probed anything, so nothing is stood down and the answer
      // is the safe one. See ReachMonitor.carrying.
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * R-CEL-10. Without this the modem reports only a coarse quality
   * percentage, which on the measured board read 60 and then 29 while the
   * real numbers moved three dB — so a page bound to it would show a signal
   * halving that had not.
   */
  it("arms detailed signal reporting, once, on the modem it read", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/modem/state");
      const armed = seen.filter((a) => a.some((w) => w.startsWith("--signal-setup")));
      expect(armed).toHaveLength(1);
      expect(armed[0]).toContain(`--signal-setup=${SIGNAL_POLL_SECONDS}`);
    } finally {
      await server.close();
    }
  });

  it("never lets arming signal fail a read", async () => {
    // A modem that has just appeared may not be ready, and the numbers a page
    // does get are worth more than a 500 saying it could not have more.
    const seen: string[][] = [];
    const failing: CommandRunner = async (argv) => {
      if (argv.some((a) => a.startsWith("--signal-setup"))) {
        return { code: 1, stdout: "", stderr: "error: operation not allowed" };
      }
      return boardRunner(seen)(argv);
    };
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath, runner: failing,
    });
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ operator: "Dark Star" });
    } finally {
      await server.close();
    }
  });

  it("puts no credential in either record", async () => {
    // R-SEC-10, asserted at the socket rather than trusted. `gsm.password` is
    // written to a NetworkManager profile and has no field to arrive back in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      for (const path of ["/modem/state", "/reach/state"]) {
        const res = await call(socketPath, "GET", path);
        expect(JSON.stringify(res.body)).not.toMatch(/password|passphrase|secret/i);
      }
    } finally {
      await server.close();
    }
  });

  it("reaches no real command for any of it", async () => {
    // Every subprocess this daemon runs goes through the injected runner. A
    // test that reached a real mmcli would answer whatever the machine
    // running it happens to have plugged in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/reach/state");
      expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
      expect(seen.every((a) => ["mmcli", "nmcli", "rfkill", "hostnamectl", "curl"].includes(a[0] ?? ""))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("buildRenderers and the modem", () => {
  /**
   * One runner, for the reason NmcliClient records about rfkill: two runners
   * that must agree can stop agreeing, and the failure mode is a test
   * reaching a real mmcli on the machine running it.
   */
  it("builds the mmcli client on the same runner as the nmcli one", async () => {
    const seen: string[][] = [];
    const run: CommandRunner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
    };
    const built = buildRenderers({ secretsPath: join(dir, "secrets.yaml"), runner: run });
    expect(built.modemClient).toBeDefined();
    await built.modemClient.modems();
    expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
  });
});
