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
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";

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
  /**
   * The clock the confirmation window and the fallback deadline are measured
   * on. Test-only, for the same reason as `runner`: nothing in this daemon
   * may wait on the wall clock in a test.
   */
  clock?: Clock;
}

export interface BuildRenderersOptions {
  secretsPath: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
  /** Drives the network renderer's bounded wait for a radio. See waitForRadio. */
  clock?: Clock;
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
  /** The same renderer as `renderers[0]`, typed, for waitForRadio. */
  renderer: NetworkRenderer;
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
  const renderer = new NetworkRenderer({ client, secrets, log, clock: opts.clock });
  return { renderers: [renderer], renderer, secrets, client, generated };
}

export async function startServer(opts: ServerOptions): Promise<{ close(): Promise<void> }> {
  const clock = opts.clock ?? systemClock;
  // Fixed before any work: the fallback deadline is measured from here, not
  // from whenever the daemon finally gets round to arming it (R-NET-07).
  const startedAt = clock.now();

  // EVERY step between here and listen() is guarded, and each one for the
  // same reason: the socket must always bind. A device whose configuration is
  // broken is precisely the device an operator has to be able to reach in
  // order to fix it, and one that exits instead is, under Restart=always, a
  // crash loop with no socket rather than a device (R-CFG-08). Nothing below
  // may throw out of this function except the bind itself.

  // First, before anything reads the configuration: a device that has never
  // been configured has no file to load. The installer seeds the same content
  // on a clean install; this is the half that also covers a hand-installed
  // board, an upgrade from a build that shipped no default, and a
  // configuration someone deleted. Seeding covers *absent*, not *invalid* —
  // an existing file is never touched, whatever is in it — so the steps below
  // still have to survive a config.yaml an operator has hand-edited into
  // nonsense, or one a schema tightening on upgrade has just invalidated.
  try {
    if (seedConfigIfAbsent(opts.configPath)) {
      process.stdout.write(`seeded a default configuration at ${opts.configPath}\n`);
    }
  } catch (e) {
    warn(`could not seed a default configuration, serving anyway: ${(e as Error).message}`);
  }

  // A malformed secrets.yaml throws out of the SecretStore constructor. That
  // must cost the network renderer, not the socket: without the socket there
  // is no way to post the corrected configuration either.
  let built: ReturnType<typeof buildRenderers> | undefined;
  // Set when buildRenderers could not be assembled, and handed to the apply
  // engine so it refuses POST /apply instead of "succeeding" against a
  // renderer set missing the one that does real work — see
  // ApplyEngineOptions.degraded. GET /config and GET /status do not depend
  // on it, so the device stays reachable and diagnosable either way.
  let degraded: string | undefined;
  try {
    built = buildRenderers({
      secretsPath: opts.secretsPath ?? "/etc/yonder/secrets.yaml",
      runner: opts.runner,
      clock,
    });
  } catch (e) {
    const message = (e as Error).message;
    warn(`could not assemble the network renderer, serving anyway: ${message}`);
    degraded = `the network renderer could not be built (${message}); `
      + "fix that and restart yonder-core before applying a network change";
  }
  const netRenderers = built?.renderers ?? [];
  // The watchdog still needs a way to talk to NetworkManager even when the
  // renderers could not be built — raising the access point is the one action
  // that helps a device in that state. Constructing a client cannot fail; it
  // is only the secret store above that can.
  const client = built?.client
    ?? new NmcliClient(opts.runner ?? systemRunner, (l) => process.stdout.write(`${l}\n`));

  // No secret is ever printed. That mechanism existed to surface a random
  // per-device access-point passphrase and there is no longer one to surface
  // (ADR-0007). What an operator does need telling is that the device is
  // still on the published default — which stays true on every boot until
  // they change it, not just the boot that seeded it.
  if (built?.secrets.get("ap_psk") === DEFAULT_AP_PASSPHRASE) {
    process.stdout.write(
      "access point: using the published default passphrase; change it from the console\n",
    );
  }

  const engine = new ApplyEngine({
    configPath: opts.configPath,
    journalPath: opts.journalPath,
    renderers: [...opts.renderers, ...netRenderers],
    renderTimeoutMs: opts.renderTimeoutMs,
    clock,
    degraded,
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

  // Armed after recover(), because recovery may roll a config back and the
  // watchdog must judge the configuration actually in force rather than the
  // one that was just discarded — but *before* the start-up render below,
  // which can spend a full renderTimeoutMs inside a wedged renderer. A
  // watchdog armed after that render is a watchdog whose deadline moved,
  // and the deadline is the guarantee.
  //
  // A configuration the schema rejects must not cost the fallback either: the
  // access point is exactly what an operator needs raised on a device whose
  // config.yaml is unloadable. The defaults are used instead, which is what
  // the fallback's own settings would be on a device nobody has configured.
  let watchdogConfig: Config = DEFAULT_CONFIG;
  try {
    watchdogConfig = loadConfig(opts.configPath);
  } catch (e) {
    warn(`fallback: cannot read the configuration, using defaults: ${(e as Error).message}`);
  }
  // Assigned once the socket is bound, below. Declared here because the
  // watchdog's action has to be able to wait on it.
  //
  // Until that assignment this is a resolved promise, so the `await
  // radioSettled` in apUp is a no-op for the whole of start-up — recorded as
  // K-17, along with why it cannot simply be assigned earlier.
  let radioSettled: Promise<void> = Promise.resolve();

  const watchdog = new FallbackWatchdog({
    client,
    clock,
    config: watchdogConfig,
    since: startedAt,
    // The fallback's only action is `nmcli connection up yonder-ap`, and that
    // profile exists only because a render created it. On a cold boot the
    // render may still be waiting for the radio when the deadline lands —
    // `network.ap.fallback.timeout` goes as low as 30 s, the same order as
    // RADIO_WAIT_MS — and raising a profile that does not exist yet fails
    // with an error about an unknown connection, which says nothing about the
    // real cause and buries the one line an operator needed.
    //
    // The deadline itself is not moved: that is the guarantee, and moving it
    // is what `since` exists to prevent. Only the *action* waits, and only on
    // something already bounded by RADIO_WAIT_MS, so the fallback is at worst
    // that much later and never silently wrong.
    apUp: async () => {
      await radioSettled;
      await client.up(AP_CONNECTION);
    },
    log: (l) => process.stdout.write(`${l}\n`),
  });
  watchdog.start();

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

  // The start-up render above ran once, before the socket bound, and on a
  // cold boot it can run before NetworkManager has finished bringing the
  // radio up — a real board printed `wlan0:wifi:unavailable:` at exactly that
  // moment. A single render against that list leaves no usable access point,
  // and nothing ever rendered again, so the device came up unreachable.
  //
  // The wait is *here*, after listen(), rather than in front of the start-up
  // render. Two reasons, and they point the same way:
  //
  //   - Reaching the device beats rendering it. A board whose radio never
  //     appears is precisely the one an operator needs to be able to ask what
  //     is wrong, and making them wait 30 s for the socket to answer buys
  //     nothing — the render happens either way.
  //   - The pre-listen render stays exactly as it was, so a console still
  //     cannot connect to a device carrying a configuration that recovery has
  //     not yet rolled back. That ordering is a separate guarantee and this
  //     change does not touch it.
  //
  // Nothing awaits this: it is background work with its own bound. A failure
  // is logged, the same as the start-up render's.
  radioSettled = (async () => {
    const renderer = built?.renderer;
    if (renderer === undefined) return;
    try {
      if (!(await renderer.waitForRadio())) return;
      process.stdout.write("network: a wifi radio became usable; rendering again\n");
      // Through the engine, not the renderer: renderCurrent() refuses while
      // an apply is in flight, so this cannot push a stale configuration
      // through a renderer mid-apply.
      await engine.renderCurrent();
    } catch (e) {
      warn(`could not render after waiting for the wifi radio: ${(e as Error).message}`);
    }
  })();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        // Stopped before the server closes, or a restart (or a test) leaves
        // the fallback timer running against a socket that no longer exists.
        // The radio wait is stopped for exactly the same reason: it is the
        // other timer this daemon owns, and a poll loop outliving its daemon
        // would go on questioning NetworkManager — and could still reach a
        // render — on behalf of a process that has already closed.
        watchdog.stop();
        built?.renderer.cancelRadioWait();
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
