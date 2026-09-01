// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ApplyEngine } from "../apply/engine.js";
import { warn } from "../log.js";
import { createRouter } from "./routes.js";
import { loadConfig } from "../config/load.js";
import { seedConfigIfAbsent } from "../config/defaults.js";
import { SecretStore } from "../secrets/store.js";
import { NmcliClient } from "../net/nmcli/client.js";
import { NetworkRenderer } from "../net/renderer.js";
import { FallbackWatchdog } from "../net/watchdog.js";
import { AP_CONNECTION, DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import { systemClock, type Renderer } from "../apply/types.js";

export interface ServerOptions {
  socketPath: string;
  configPath: string;
  journalPath: string;
  renderers: Renderer[];
  /** Where the device's secrets (the access-point passphrase, later the administrator password, …) live. */
  secretsPath?: string;
  /** Forwarded to ApplyEngine; defaults to the engine's own default when unset. */
  renderTimeoutMs?: number;
  /**
   * Overrides the network renderer's command runner. Not part of the public
   * shape production code needs — it exists so tests can inject a fake and
   * never invoke a real nmcli, the same reason buildRenderers takes one.
   */
  runner?: CommandRunner;
}

export interface BuildRenderersOptions {
  secretsPath: string;
  dnsmasqPath?: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
}

/**
 * Assemble the renderers and make sure the access point has a passphrase.
 *
 * ap_psk is seeded with the published default, not a random per-device value
 * (ADR-0007, R-SEC-01). The random one could only ever be read from the
 * device's own journal, and joining this access point is how anyone gets to
 * the device — so it shipped a credential no operator could retrieve.
 *
 * editor_password is deliberately not seeded at all. It must not exist until
 * the operator sets it from the console; that is what makes the first-run
 * setup step mean something (R-SEC-09).
 *
 * `generated` names what was created just now, so a caller can tell a first
 * boot from a restart. It is no longer a list of values to display.
 */
export function buildRenderers(opts: BuildRenderersOptions): {
  renderers: Renderer[];
  secrets: SecretStore;
  client: NmcliClient;
  generated: string[];
} {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const secrets = new SecretStore(opts.secretsPath);
  const generated: string[] = [];
  // Only if absent: an operator who has changed the passphrase keeps theirs.
  if (secrets.ensureValue("ap_psk", DEFAULT_AP_PASSPHRASE).created) generated.push("ap_psk");
  const client = new NmcliClient(opts.runner ?? systemRunner, log);
  const renderer = new NetworkRenderer({
    client, secrets, dnsmasqPath: opts.dnsmasqPath, log,
  });
  return { renderers: [renderer], secrets, client, generated };
}

export async function startServer(opts: ServerOptions): Promise<{ close(): Promise<void> }> {
  // First, before anything reads the configuration. A device that has never
  // been configured has no file to load, and every path below — recover(),
  // the startup render, the watchdog — would throw before the socket could
  // bind, which under Restart=always is a crash loop rather than a device
  // (R-CFG-08). The installer seeds the same content on a clean install; this
  // is the half that also covers a hand-installed board, an upgrade from a
  // build that shipped no default, and a configuration someone deleted.
  if (seedConfigIfAbsent(opts.configPath)) {
    process.stdout.write(`seeded a default configuration at ${opts.configPath}\n`);
  }

  const { renderers: netRenderers, secrets, client } = buildRenderers({
    secretsPath: opts.secretsPath ?? "/etc/yonder/secrets.yaml",
    runner: opts.runner,
  });
  // No secret is ever printed. That mechanism existed to surface a random
  // per-device access-point passphrase and there is no longer one to surface
  // (ADR-0007). What an operator does need telling is that the device is
  // still on the published default — which stays true on every boot until
  // they change it, not just the boot that seeded it.
  if (secrets.get("ap_psk") === DEFAULT_AP_PASSPHRASE) {
    process.stdout.write(
      "access point: using the published default passphrase; change it from the console\n",
    );
  }

  const engine = new ApplyEngine({
    configPath: opts.configPath,
    journalPath: opts.journalPath,
    renderers: [...opts.renderers, ...netRenderers],
    renderTimeoutMs: opts.renderTimeoutMs,
  });

  // Anything left pending by a previous process is reverted before we serve.
  // A failure here must not stop the socket binding: recovery is exactly the
  // path that runs after a crash, and a daemon that refuses to start because
  // it could not roll back leaves an operator with no way in at all. The
  // journal is left in place, so the next start tries again.
  try {
    await engine.recover();
  } catch (e) {
    warn(`recovery failed, serving anyway: ${(e as Error).message}`);
  }

  // Nothing else renders on a clean start. renderAll runs only from apply()
  // and from the two rollback paths, so a device nobody has ever posted an
  // apply to came up with no access point at all — and nobody could post one,
  // because reaching the device is what the access point is for (R-CFG-08,
  // R-NET-01).
  //
  // Guarded exactly like recover() above, and for the same reason: the
  // configuration API must come up even when the network cannot. A board
  // whose NetworkManager is wedged is one an operator still has to be able to
  // ask what is wrong.
  try {
    await engine.renderCurrent();
  } catch (e) {
    warn(`could not render the current configuration, serving anyway: ${(e as Error).message}`);
  }

  const route = createRouter({ engine, configPath: opts.configPath });

  // Started after recover(), not before: recovery may roll a config back,
  // and the watchdog must judge the configuration actually in force rather
  // than the one that was just discarded.
  const watchdog = new FallbackWatchdog({
    client,
    clock: systemClock,
    config: loadConfig(opts.configPath),
    apUp: () => client.up(AP_CONNECTION),
    log: (l) => process.stdout.write(`${l}\n`),
  });
  watchdog.start();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body is not valid JSON" }));
          return;
        }
      }
      void route(req.method ?? "GET", req.url ?? "/", body).then((r) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
  });

  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);

  // A Unix socket, never a TCP port: the configuration API is reachable only
  // through the filesystem, so no interface can expose it by accident.
  // A bind failure has to come back as a rejection: an unhandled 'error'
  // event would take the process down with a stack trace instead of a line
  // saying which path could not be bound.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, 0o660);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        // Stopped before the server closes, or a restart (or a test) leaves
        // the fallback timer running against a socket that no longer exists.
        watchdog.stop();
        server.close(() => {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
          resolve();
        });
      }),
  };
}

async function main(): Promise<void> {
  await startServer({
    socketPath: process.env.YONDER_SOCKET ?? "/run/yonder/core.sock",
    configPath: process.env.YONDER_CONFIG ?? "/etc/yonder/config.yaml",
    journalPath: process.env.YONDER_JOURNAL ?? "/var/lib/yonder/apply.json",
    secretsPath: process.env.YONDER_SECRETS ?? "/etc/yonder/secrets.yaml",
    renderers: [],
  });
  process.stdout.write("yonder-core listening\n");
}

/**
 * Compare file URLs, not strings: process.argv[1] is a path, and building a
 * URL from it by hand mis-encodes spaces and non-ASCII and never matches when
 * the daemon is started through the symlink npm installs for `bin`. A missed
 * match here exits 0 having done nothing, which under Restart=always is a
 * silent restart loop.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: unknown) => {
    warn(`failed to start: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
