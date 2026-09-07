// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApplyEngine } from "../apply/engine.js";
import { warn, note, trace } from "../log.js";
import { createRouter, type CameraProbes, type DiagProbes } from "./routes.js";
import { AdminCredential } from "../console/credential.js";
import { ConsoleRenderer } from "../console/renderer.js";
import { consolePaths, type ConsolePaths } from "../console/settings.js";
import { loadConfig } from "../config/load.js";
import { answerableAddresses } from "../net/dial-in.js";
import { seedConfigIfAbsent } from "../config/defaults.js";
import { SecretStore } from "../secrets/store.js";
import { NmcliClient } from "../net/nmcli/client.js";
import { MmcliClient } from "../net/modem/mmcli/client.js";
import { modemState } from "../net/modem/state.js";
import { ModemNetPort } from "../net/modem/netport.js";
import { Standing, type StandingView } from "../net/reach/standing.js";
import { commandProbe } from "../net/reach/probe.js";
import { ReachMonitor, pathDevices, pathsDown, pathsHolding } from "../net/reach/monitor.js";
import { ReachWatch } from "../net/reach/watch.js";
import type { CounterReader } from "../net/reach/counters.js";
import type { PathName } from "../net/reach/standing.js";
import { NetworkRenderer } from "../net/renderer.js";
import { HostnameRenderer } from "../system/hostname.js";
import { FallbackWatchdog } from "../net/watchdog.js";
import { joinSucceeded } from "../net/joined.js";
import { networkState } from "../net/state.js";
import { readRemoteState } from "../remote/state.js";
import { RemoteRenderer } from "../remote/renderer.js";
import { MediaRenderer, MEDIA_CONFIG_PATH } from "../media/renderer.js";
import { Supervisor, systemSpawner, type ProcessSpawner } from "../video/supervisor.js";
import { PipelineRenderer } from "../video/renderer.js";
import { detectCameras, probeCamera } from "../video/probe/camera.js";
import { probeEncoder, type Encoder } from "../video/probe/encoder.js";
import { applyControls } from "../video/controls.js";
import { EncoderChannel } from "../video/encoder.js";
import { Viewers } from "../video/viewers.js";
import { Adaptation } from "../video/adaptation.js";
import { readSupply } from "../system/supply.js";
import { ZeroTierCli } from "../remote/zerotier/cli.js";
import { readTraffic } from "../remote/traffic.js";
import { TrafficSampler } from "../remote/sampler.js";
import { MavlinkRenderer, ROUTER_CONF_PATH } from "../mav/renderer.js";
import { openPortWith } from "../mav/serial.js";
import { LinkTracker } from "../mav/link.js";
import { LoopbackListener } from "../mav/listener.js";
import type { OpenPort } from "../mav/detect.js";
import { AP_CONNECTION, DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
import { scanForNetworks } from "../net/scan.js";
import { ping, reachable } from "../diag/probe.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";

/**
 * How long after an administrator password is set before the console is
 * restarted into its provisioned shape.
 *
 * The restart kills the process that is answering the operator's browser, so
 * it has to happen after that answer is on its way. A second and a half is
 * far longer than a local socket round trip and a page write, and it is time
 * the operator spends reading "the console is restarting".
 */
export const PROVISION_RESTART_DELAY_MS = 1_500;

/**
 * How often ModemManager is asked to refresh the detailed signal numbers.
 *
 * R-CEL-10. Until this is set a modem reports only a coarse quality
 * percentage, which on the measured board read 60 and then 29 while the real
 * numbers moved three dB. Two seconds is the modem's own polling interval,
 * not a rate anything here reads at: the readings are taken from the modem
 * when a page asks, and arming this costs no bytes on the operator's link
 * (R-CEL-09).
 */
export const SIGNAL_POLL_SECONDS = 2;

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
  /**
   * Where the byte counters are read from. Test-only, and for exactly the
   * reason `runner` is: the default is `readFileSync("/sys/class/net/…")`,
   * and a test that reaches the real one is asserting about whatever
   * interfaces the machine running it happens to have. It passes today only
   * because the fixture names do not exist on the host; a CI board with a
   * `wwan0` or an `eth0` would take a different branch of `ReachWatch`.
   */
  counters?: CounterReader;
  /**
   * Where the console lives, and whether there is one to render at all.
   * Absent means no ConsoleRenderer is assembled — see BuildRenderersOptions.
   */
  console?: Partial<ConsolePaths>;
  /**
   * Where the media server's generated configuration goes. **Given, never
   * defaulted**, like `console`: absent means no MediaRenderer is assembled,
   * so nothing in a test can write to — or delete from — a real
   * /etc/mediamtx by forgetting to override a path. main() supplies the
   * production value.
   */
  mediaConfigPath?: string;
  /**
   * The camera layer, given whole instead of probed for.
   *
   * **Test-only, exactly like `runner` and `clock` above, and `main()` never
   * supplies it.** There is no environment variable for it and there must not
   * be: a switch that makes this daemon report the cameras a file names rather
   * than the ones the board has is a device lying about its own hardware, and
   * an aircraft is the wrong place to discover that somebody set it.
   * Supplying it takes writing a different program, which is what
   * `scripts/pages-daemon.mjs` is.
   *
   * It exists because the capture gate (R-UI-12) has no camera. With none
   * attached there is no camera page, so the gate covers none of the camera
   * work and does not complain — from its point of view there is nothing
   * there. Given whole rather than as a fake `runner`, because
   * `detectCameras` reads `/dev/v4l/by-path` as well as running `v4l2-ctl`,
   * and a machine with no `/dev/v4l` answers `byPathStable: false` — which is
   * the one thing the Cameras page exists to report honestly (R-CAM-05).
   */
  cameraLayer?: CameraLayer;
  /**
   * How a pipeline is started, handed straight to `buildRenderers`.
   *
   * **Test-only, and `main()` never supplies it**, exactly like `cameraLayer`
   * above and for the same reason: with a default, a test of this daemon
   * would run `gst-launch-1.0` on whatever machine the suite is on.
   *
   * It exists because the runtime half of the video layer — the rate
   * controller and the register of who is watching — is assembled in
   * `startServer` and nowhere else, and the only honest way to prove that a
   * browser's statistic arriving at this socket reaches a running encoder is
   * to have a pipeline this daemon actually started and can actually talk to.
   * Without this option that join could only be asserted one layer down,
   * which is precisely the layer where every part already worked and nothing
   * connected them.
   */
  spawner?: ProcessSpawner;
   /**
   * How to open a serial port, and where the two telemetry files live.
   * Absent means neither a `MavlinkRenderer` nor the loopback listener is
   * assembled, and every `/mav/*` route says so — see
   * BuildRenderersOptions.mavlink, which explains why it is not defaulted.
   */
  mavlink?: BuildRenderersOptions["mavlink"];
}

/**
 * Everything about cameras this daemon would otherwise ask the board for.
 *
 * All three together, not one at a time: a probe that answered from a fixture
 * beside an encoder read off the host would be a view no device has ever had.
 */
export interface CameraLayer {
  cameras: CameraProbes;
  encoder: () => Promise<Encoder>;
  /** What `GET /cameras/:id/stream-address` resolves. See ServerOptions.cameraLayer. */
  rtspPassword: () => string | null;
}

export interface BuildRenderersOptions {
  secretsPath: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
  /**
   * Where the nmcli command lines go. The journal, never the activity pane:
   * an operator looking for what their Join did should not have to read every
   * `device status` a status line polled for.
   */
  trace?: (line: string) => void;
  /** Drives the network renderer's bounded wait for a radio. See waitForRadio. */
  clock?: Clock;
  /**
   * Which paths have stopped reaching anything, read by the network renderer
   * while it generates route metrics (R-NET-13). Read-only, and an input to
   * generating configuration rather than a second writer of it — see
   * NetworkRendererOptions.standing.
   */
  standing?: StandingView;
  /**
   * Told when a path has actually been re-dialled (R-CEL-09).
   *
   * Wired to `ReachWatch.redialled`, which tests that path on its next tick.
   * The renderer is the only component that knows a re-dial happened — the
   * interface name does not change and, for a modem that is standing by
   * rather than in use, neither do any byte counters the watch could read.
   * Optional, so a renderer built without one behaves exactly as it did.
   */
  onRedial?: (path: PathName) => void;
  /**
   * Where the console lives. **Given, never defaulted**: a ConsoleRenderer is
   * assembled only when a caller says where the console is, so nothing in a
   * test can write to /opt/yonder by forgetting to override a path. The
   * production values come from consolePathsFromEnv(), in main().
   */
  console?: Partial<ConsolePaths>;
  /**
   * Where the remote renderer records the mesh it joined. **Given, never
   * defaulted**, like `console` above and for the same reason: a path with a
   * default is a path a test writes to by forgetting to override it, and this
   * one would be `/var/lib/yonder`.
   */
  remoteStatePath: string;
  /**
   * Where the media server's generated configuration goes. **Given, never
   * defaulted**, for the same reason as `console` and `remoteStatePath`:
   * absent means no MediaRenderer is assembled, and a path with a default is
   * a path a test writes to by forgetting to override it — this one would be
   * a real media server's configuration, credential and all.
   */
  mediaConfigPath?: string;
  /**
   * How a pipeline is started. Defaults to `systemSpawner`, which runs
   * `gst-launch-1.0`.
   *
   * Injected for exactly the reason `runner` is: **no test in this repository
   * spawns a real pipeline.** Without it, the only way to see whether
   * `PipelineRenderer` is genuinely wired to the supervisor the camera routes
   * use would be to start `gst-launch-1.0` on the machine running the suite —
   * so the join would go untested, which is the failure this renderer exists
   * to end, one layer up.
   */
  spawner?: ProcessSpawner;
   /**
   * Everything the telemetry renderer needs, or nothing at all.
   *
   * **Present only when a caller supplies a way to open a serial port.**
   * `MavlinkRenderer` resolves the autopilot's port and speed by sweeping it
   * (R-MAV-01), so a renderer built without an `OpenPort` could not do the
   * first thing it exists for. `mav/serial.ts` implements one against real
   * hardware and `main()` supplies it; this stays given-and-never-defaulted
   * so that a *test* which forgets to override it gets no telemetry renderer
   * rather than a real `/dev` and a real `stty`. The same shape as `console`
   * above, and the same rule for its two paths, so no test writes to
   * `/etc/mavlink-router` by forgetting to override one.
   */
  mavlink?: {
    open: OpenPort;
    /** `/etc/mavlink-router/main.conf` in production — `ROUTER_CONF_PATH`. */
    confPath: string;
    /** The remembered port and speed, under /var/lib/yonder (R-MAV-13). */
    hintPath: string;
    /**
     * Overrides `LOOPBACK_PORT` for the listener on the control plane's own
     * feed. **Test-only**, exactly like `runner` and `clock` above: a test
     * binds an ephemeral port (`0`) so the suite neither collides with a
     * daemon that is already running nor depends on a fixed port being free
     * on whatever machine it runs on. There is deliberately no matching
     * override for the *address* — see `LOOPBACK_ADDRESS` and R-MAV-07.
     */
    loopbackPort?: number;
  };
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
  /** Present only when `opts.console` said where the console is. */
  consoleRenderer?: ConsoleRenderer;
  secrets: SecretStore;
  client: NmcliClient;
  /** ModemManager, read and never driven. See net/modem/mmcli/client.ts. */
  modemClient: MmcliClient;
  /** Talks to the installed zerotier-cli, over the same runner as everything else. */
  zerotier: ZeroTierCli;
  remoteRenderer: RemoteRenderer;
  /** Present only when `opts.mediaConfigPath` said where the file goes. */
  mediaRenderer?: MediaRenderer;
  /**
   * The one supervisor this process owns, for the whole of its life.
   *
   * Built here, beside the renderers, and deliberately not inside a Node-RED
   * node: a redeploy destroys and recreates every node, so a supervisor in one
   * would drop every camera's pipeline the moment somebody edited a flow —
   * including, on a flying aircraft, the feed a ground station is watching.
   *
   * Not a renderer. Starting and stopping a stream is a runtime action that
   * survives no apply and no reboot (R-CTL-01), so it has no place in a
   * sequence whose whole purpose is to make a configuration true.
   *
   * **A renderer drives it, which is a different claim.** `PipelineRenderer`
   * below restarts a pipeline that is *already running* when the applied
   * configuration would compose a different launch line for it (K-48), and
   * starts nothing that is not running. The runtime action stays the
   * operator's; what the apply owns is that a camera on the air is on the air
   * with the settings that were kept.
   */
  supervisor: Supervisor;
  /** Present only when `opts.mavlink` said how to open a serial port. */
  mavlinkRenderer?: MavlinkRenderer;
  /**
   * The control plane's own feed off `127.0.0.1:14559` (R-MAV-05), sharing
   * one `LinkTracker` with the renderer above. Assembled here and *started*
   * by `startServer`, the same division `TrafficSampler` follows: this
   * function builds, the daemon opens sockets.
   */
  mavlinkListener?: LoopbackListener;
  generated: string[];
} {
  const log = opts.log ?? note;
  const secrets = new SecretStore(opts.secretsPath);
  const generated: string[] = [];
  // Only if absent: an operator who has changed the passphrase keeps theirs.
  if (secrets.ensureValue("ap_psk", DEFAULT_AP_PASSPHRASE).created) generated.push("ap_psk");
  // Two loggers, deliberately. The renderer says things an operator acts on
  // - "bringing the access point up", "the wifi client did not come up" - and
  // those belong in the activity pane. The client says which nmcli command it
  // ran, which belongs in the journal and nowhere else: with a status line
  // polling every few seconds, routing both to the same place filled the
  // operator's view with `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
  // status` twice a tick and buried what their Join actually did.
  const client = new NmcliClient(opts.runner ?? systemRunner, opts.trace ?? trace);
  // The same runner as the nmcli client, deliberately, for the reason
  // NmcliClient records about rfkill: two runners that must agree can stop
  // agreeing, and the failure mode is a test reaching a real mmcli on the
  // machine running it. The same two loggers apply too — an `mmcli` command
  // line is diagnostic and belongs in the journal, not in the operator's
  // activity pane.
  const modemClient = new MmcliClient(opts.runner ?? systemRunner, opts.trace ?? trace);
  const renderer = new NetworkRenderer({
    client, secrets, log, clock: opts.clock, standing: opts.standing,
    ...(opts.onRedial === undefined ? {} : { onRedial: opts.onRedial }),
  });

  // After the network renderer: a mesh runs over whatever the network layer
  // just brought up, so ordering it first would join over an interface that
  // does not exist yet.
  const zerotier = new ZeroTierCli(opts.runner ?? systemRunner, opts.trace ?? trace);
  const remoteRenderer = new RemoteRenderer({
    cli: zerotier,
    run: opts.runner ?? systemRunner,
    statePath: opts.remoteStatePath,
    log,
    clock: opts.clock,
  });

  // After the network renderer, deliberately. Renderers run in order, so this
  // puts the console behind a network that has already settled: if the
  // console then fails and the apply rolls back, the rollback re-renders a
  // network that was working rather than one that was never rendered at all.
  // The reverse order would mean a console failure could leave the access
  // point untouched by either pass, which is rule 6.
  const consoleRenderer = opts.console === undefined
    ? undefined
    : new ConsoleRenderer({
      runner: opts.runner ?? systemRunner,
      credential: new AdminCredential(secrets),
      paths: opts.console,
      log,
    });

  // Last of all, and deliberately the opposite of the console's reasoning.
  //
  // Renderers run in sequence and a failure stops the ones behind it, so the
  // question is what each one is allowed to prevent. A media server that will
  // not start must not stop the console being re-rendered: the console is how
  // an operator fixes a device, and video is not. Nothing is behind this one,
  // so nothing is at risk from it.
  const mediaRenderer = opts.mediaConfigPath === undefined
    ? undefined
    : new MediaRenderer({
      path: opts.mediaConfigPath,
      runner: opts.runner ?? systemRunner,
      secrets,
      log,
    });
  // Last, and deliberately. Telemetry rides on a network that has already
  // settled, and this is the renderer that can take longest — a full sweep is
  // four speeds on each of two devices, and §3's whole point is that spending
  // it costs nothing. Nothing is behind it to be stopped by a failure, which
  // matters less than it looks because render() does not throw at all (K-19,
  // and §5: no telemetry fault is worth reverting a whole configuration for).
  if (opts.mavlink === undefined) {
    // **Say it.** Without this, a device with no serial opener accepted an
    // apply that configured three ground stations, wrote no
    // /etc/mavlink-router/main.conf, started no router, and put nothing
    // anywhere saying why — a successful apply that did nothing, which is the
    // worst shape a missing capability can take. Not `degraded`: that refuses
    // *every* apply, and a board without telemetry must still be configurable
    // (rule 6). One line an operator can act on, on the same channel the rest
    // of the renderers report on.
    log(
      "mavlink: telemetry is not configured on this device — this daemon was started without a way to open "
        + "a serial port, so mavlink-router is neither configured nor started and the Telemetry page will "
        + "stay empty (R-MAV-01, R-MAV-08)",
    );
  }
  // **One tracker, two writers.** The renderer supplies the sweep's outcome
  // and the router's own counters (`observed`, `sampled`); the listener
  // supplies heartbeats off the loopback copy (`heard`). Handing both the same
  // instance is what makes GET /mav/state one answer rather than two halves
  // stitched together at the route — and it is why the listener depends on
  // `LinkTracker` rather than on the renderer. Built here, where both are, so
  // no caller can get it wrong by forgetting.
  //
  // The two are built together rather than each on its own line, because the
  // tracker is what they share and a block is the only shape that says so.
  // The listener exists exactly when the renderer does: without one, no
  // /etc/mavlink-router/main.conf is written and no router is started, so
  // nothing anywhere sends to :14559 — a socket held open for a feed that
  // cannot exist is a port held for nothing.
  let mavlinkRenderer: MavlinkRenderer | undefined;
  let mavlinkListener: LoopbackListener | undefined;
  if (opts.mavlink !== undefined) {
    const tracker = new LinkTracker({ clock: opts.clock ?? systemClock });
    mavlinkRenderer = new MavlinkRenderer({
      run: opts.runner ?? systemRunner,
      open: opts.mavlink.open,
      confPath: opts.mavlink.confPath,
      hintPath: opts.mavlink.hintPath,
      tracker,
      log,
      clock: opts.clock,
    });
    mavlinkListener = new LoopbackListener({
      tracker,
      log,
      ...(opts.mavlink.loopbackPort === undefined ? {} : { port: opts.mavlink.loopbackPort }),
    });
  }

  // First, and deliberately.
  //
  // K-19: renderers run in sequence and a failure stops the ones behind it,
  // which is why the console is behind the network. This one goes in *front*
  // of the network for the mirror-image reason: it cannot fail (see
  // HostnameRenderer.render), so nothing is put at risk by it, and a board
  // whose NetworkManager is wedged still ends up with the name its
  // configuration gives it — which is the board an operator is most likely to
  // be looking for by name. It also means NetworkManager sends the right
  // hostname on the DHCP request the network render is about to make.
  const hostname = new HostnameRenderer({ runner: opts.runner ?? systemRunner, log });

  // Nothing is spawned by constructing it: a Supervisor holds no process
  // until something calls start(), which only POST /cameras/:id/run does.
  const supervisor = new Supervisor({
    spawner: opts.spawner ?? systemSpawner,
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });

  /**
   * K-48: an applied bitrate reaching the running encoder.
   *
   * **Last of all, behind the media server**, for two reasons that point the
   * same way. A pipeline publishes into mediamtx, so the server has to be in
   * the shape this configuration asks for before a pipeline is restarted into
   * it. And a camera that cannot be restarted must be able to cost nothing
   * else: nothing runs behind this, so nothing is at risk from it — the same
   * reasoning that put the media renderer behind the console, one step
   * further along.
   *
   * **Unconditional, unlike the console and media renderers.** Those are
   * built only when a caller says where their file goes, because a defaulted
   * path is a path a test writes to by accident. This one writes nothing and
   * reads no path: it holds the supervisor built above and does nothing at
   * all until something has actually started a pipeline. A renderer that is
   * assembled only sometimes is a fix that is applied only sometimes, and
   * this branch has been bitten by exactly that before.
   */
  const pipelineRenderer = new PipelineRenderer({
    supervisor,
    // The same probe the start route composes with, over the same runner as
    // everything else here — so a test injecting a fake runner cannot reach a
    // real `v4l2-ctl`, and the line this renderer builds for a camera and the
    // line a Start would build for it cannot differ by their encoder.
    encoder: () => probeEncoder({ runner: opts.runner ?? systemRunner }),
    log,
  });

  // One list, both subsystems. The order is the order they run in: the
  // hostname and the network first, then the console, then the things that
  // depend on a configured device — media, telemetry — and the camera
  // pipelines last, because a pipeline is composed from what the renderers
  // above it have already settled.
  const renderers: Renderer[] = [hostname, renderer, remoteRenderer];
  if (consoleRenderer !== undefined) renderers.push(consoleRenderer);
  if (mediaRenderer !== undefined) renderers.push(mediaRenderer);
  if (mavlinkRenderer !== undefined) renderers.push(mavlinkRenderer);
  renderers.push(pipelineRenderer);

  return {
    renderers,
    renderer,
    ...(consoleRenderer === undefined ? {} : { consoleRenderer }),
    secrets,
    client,
    modemClient,
    zerotier,
    remoteRenderer,
    ...(mediaRenderer === undefined ? {} : { mediaRenderer }),
    supervisor,
    ...(mavlinkRenderer === undefined ? {} : { mavlinkRenderer }),
    ...(mavlinkListener === undefined ? {} : { mavlinkListener }),
    generated,
  };
}

/**
 * Where the console is on a real device.
 *
 * Read from the environment with the installed paths as defaults, in one
 * place, so that the only thing which decides a production path is this
 * function and the only thing which decides a test path is the test.
 */
export function consolePathsFromEnv(env: NodeJS.ProcessEnv = process.env): ConsolePaths {
  const overrides: Partial<ConsolePaths> = {};
  if (env.YONDER_CONSOLE_SETTINGS !== undefined) overrides.settings = env.YONDER_CONSOLE_SETTINGS;
  if (env.YONDER_CONSOLE_USERDIR !== undefined) overrides.userDir = env.YONDER_CONSOLE_USERDIR;
  if (env.YONDER_SOCKET !== undefined) overrides.socket = env.YONDER_SOCKET;
  if (env.YONDER_CONSOLE_CORE_TREE !== undefined) overrides.coreTree = env.YONDER_CONSOLE_CORE_TREE;
  if (env.YONDER_CONSOLE_UNIT !== undefined) overrides.unit = env.YONDER_CONSOLE_UNIT;
  return consolePaths(overrides);
}

/**
 * The apply journal's own path on a real device.
 *
 * A constant rather than a literal in `main()` because two production
 * decisions are derived from it — the mesh record and the telemetry hint both
 * live beside it — and a second copy of the default is how the three come to
 * disagree on a board whose `YONDER_JOURNAL` is set.
 */
export const DEFAULT_JOURNAL_PATH = "/var/lib/yonder/apply.json";

/**
 * Everything the telemetry renderer needs on a real device (R-MAV-01).
 *
 * The same shape and the same purpose as `consolePathsFromEnv` above: the
 * only thing that decides a production path is this function, and the only
 * thing that decides a test path is the test. Without it these three values
 * would live inside `main()`, which nothing can call and nothing therefore
 * checks — and a hint written to the wrong place is a sweep on every boot,
 * silently, for ever.
 *
 * `run` is a parameter for the same reason every renderer takes one: nothing
 * in a test may reach a real `stty`. `opts` is there for the same reason
 * again, one level down: without it the opener this function builds is welded
 * to the wall clock and to no journal at all, so the first test that wires
 * this function through would sleep on real time and lose whatever the opener
 * had to say. `main()` passes the real ones.
 */
export function mavlinkFromEnv(
  run: CommandRunner = systemRunner,
  env: NodeJS.ProcessEnv = process.env,
  opts: { clock?: Clock; log?: (line: string) => void } = {},
): NonNullable<ServerOptions["mavlink"]> {
  return {
    open: openPortWith(run, opts),
    confPath: ROUTER_CONF_PATH,
    // Beside the apply journal and the mesh record — one state directory for
    // this daemon, not a third one the telemetry renderer invented. It
    // follows YONDER_JOURNAL so a board running out of an alternate state
    // directory keeps all three together.
    hintPath: join(dirname(env.YONDER_JOURNAL ?? DEFAULT_JOURNAL_PATH), "mavlink-link.json"),
  };
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
      note(`seeded a default configuration at ${opts.configPath}`);
    }
  } catch (e) {
    warn(`could not seed a default configuration, serving anyway: ${(e as Error).message}`);
  }

  // The configuration, read fresh every time rather than captured: an apply
  // can replace it under any of the callers below, and a monitor answering
  // from the document that was in force at start-up would be answering about
  // a device that no longer exists. Defined here because the standing below
  // needs it, and the standing has to exist before the renderer that reads it.
  const reachConfig = (): Config => {
    try {
      return loadConfig(opts.configPath);
    } catch {
      return DEFAULT_CONFIG;
    }
  };
  /** `usb` is in the schema's interface list and no renderer writes one. */
  const reachOrder = (config: Config): PathName[] =>
    config.network.priority.filter((i): i is PathName => i !== "usb");

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

  /**
   * R-NET-13's second half: **traffic moves to the next path that works.**
   *
   * Standing decides whether a path participates; the renderer generates the
   * route metrics; this is the wire between them. On a change of standing —
   * a demotion or a recovery, never a probe — the renderer recomputes the
   * metrics for the egress connections it owns and writes them, which is what
   * actually moves the default route.
   *
   * **It is not a second writer of configuration.** `config.yaml` still
   * states preference, `metricFor` still generates the numbers from it, and
   * the renderer is still the only thing that writes one. All that has
   * changed is that one of the renderer's inputs can now move without an
   * apply — so a demotion cannot sit unwritten until the next unrelated
   * render, which is what "and traffic moves" would otherwise have meant in
   * practice.
   *
   * Serialised against itself and swallowing every failure, because the
   * caller is a probe result folding into standing: there is nobody to report
   * an error to, nothing to roll back, and two overlapping passes writing the
   * same three connections would be two nmcli commands racing for no gain.
   */
  let remetricing: Promise<void> = Promise.resolve();
  let remetricStopped = false;
  const remetric = (): void => {
    remetricing = remetricing.then(async () => {
      // Same reason the watchdog and the reach watch have stop(): a pass
      // queued behind another one must not reconfigure NetworkManager on
      // behalf of a process that has already let go of its socket.
      if (remetricStopped) return;
      const renderer = built?.renderer;
      // Only when buildRenderers threw — an unreadable secrets.yaml. There is
      // no renderer to write a metric with, and the fallback watchdog is what
      // keeps that board reachable.
      if (renderer === undefined) return;
      try {
        await renderer.remetric(reachConfig());
      } catch (e) {
        warn(`could not move traffic off a path that stopped working: ${(e as Error).message}`);
      }
      // Nothing above can reject, and the chain is guarded anyway: one
      // rejected link would skip every pass queued behind it, which is a
      // demotion that silently never reaches the routing table.
    }).catch(() => {});
  };

  /**
   * R-CEL-09's other half: **a link that has just come up is tested.**
   *
   * The watch is assembled a long way below this point — it needs the monitor,
   * which needs the nmcli client `buildRenderers` returns — so the renderer is
   * handed this indirection rather than the watch itself. Before the watch
   * exists a re-dial is dropped, which is right: nothing has started ticking
   * yet, and the watch's own first tick tests whatever is carrying traffic.
   *
   * Nothing here can throw. `redialled` records one path in a set, the
   * renderer catches anything anyway, and a render that has successfully
   * dialled the operator's corrected APN must not be failed — and rolled
   * back — by the thing that only wanted to be told about it.
   */
  let reachWatch: ReachWatch | undefined;
  const onRedial = (path: PathName): void => { reachWatch?.redialled(path); };

  // Built before the renderers, because the renderer reads it while
  // generating route metrics and a renderer holding a standing that arrived
  // later would generate the first render's metrics from nothing.
  const standing = new Standing({
    clock,
    log: note,
    order: () => reachOrder(reachConfig()),
    onChange: remetric,
  });

  try {
    built = buildRenderers({
      secretsPath: opts.secretsPath ?? "/etc/yonder/secrets.yaml",
      runner: opts.runner,
      clock,
      standing,
      onRedial,
      // The same directory the apply journal already lives in — one state
      // directory for this daemon, not a second one this renderer invented.
      remoteStatePath: join(dirname(opts.journalPath), "remote.json"),
      ...(opts.mediaConfigPath === undefined ? {} : { mediaConfigPath: opts.mediaConfigPath }),
      ...(opts.console === undefined ? {} : { console: opts.console }),
      ...(opts.spawner === undefined ? {} : { spawner: opts.spawner }),
      ...(opts.mavlink === undefined ? {} : { mavlink: opts.mavlink }),
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
    // `trace`, not `note`: an nmcli command line is diagnostic, and the
    // activity pane is where an operator looks for what their Join did.
    ?? new NmcliClient(opts.runner ?? systemRunner, trace);
  // The same one buildRenderers made, so a test injecting a fake runner
  // cannot reach a real mmcli, with the same fallback and for the same
  // reason as the nmcli client above.
  const modemClient = built?.modemClient
    ?? new MmcliClient(opts.runner ?? systemRunner, trace);

  /**
   * Turn on ModemManager's detailed signal reporting, once per modem.
   *
   * R-CEL-10. A modem reports only a coarse quality percentage until this is
   * set, and that percentage read 60 and then 29 on a board whose real
   * numbers moved three dB.
   *
   * Here rather than in NetworkRenderer, deliberately. That class has no
   * modem client and never raises the modem connection itself — the profile
   * carries `connection.autoconnect yes` and NetworkManager brings the link
   * up (R-CEL-06) — so there is no "after the modem came up" moment in the
   * render path to hang this on. Manufacturing one would mean giving an
   * mmcli dependency to the class that decides whether the device is
   * reachable, to arm a page's detail. This is instead the first place that
   * has the modem's ModemManager path in hand at all.
   *
   * **It can only ever log.** Failing to arm it costs detail on a page; the
   * read it sits in front of still answers with whatever the modem does
   * report, and a modem that has just appeared may simply not be ready yet —
   * so a failure is retried on the next read and said once per modem, or a
   * console polling every few seconds would fill the journal with it.
   */
  let armedModem: string | null = null;
  let armFailedFor: string | null = null;
  const armSignal = async (path: string): Promise<void> => {
    if (armedModem === path) return;
    try {
      await modemClient.armSignal(path, SIGNAL_POLL_SECONDS);
      armedModem = path;
      armFailedFor = null;
      note("modem: detailed signal reporting is on");
    } catch (e) {
      if (armFailedFor !== path) {
        armFailedFor = path;
        warn(`modem: could not turn on detailed signal reporting (${(e as Error).message})`);
      }
    }
  };

  // The one poll loop for the mesh's throughput, running on `clock` like
  // every other timer this daemon owns. Started unconditionally — it costs
  // nothing while no interface has been named (`forInterface` is only called
  // from the /remote/state route below, which is itself only wired once
  // `built` exists) — so a secrets.yaml this daemon could not read still
  // leaves the sampler ready the moment a network is joined and the route
  // comes back. On its own timer rather than sampled from inside the route
  // handler (R-NET-10): two pollers share that route at different periods, so
  // sampling "on request" would space the history unevenly, and a graph
  // opened after the daemon had been running a while would have nothing
  // before that first request. This is the only place this daemon samples
  // traffic; readRemoteState only ever reads what the sampler already has.
  const sampler = new TrafficSampler({ clock });
  sampler.start();

  /**
   * The video layer's runtime half: who is watching, and the rate that
   * follows from it (R-VID-07, R-VID-11; spec §8.1, §8.2).
   *
   * **This is the join that was missing.** `video/rate.ts` was built, proved
   * on a board and left with no production caller at all: every link
   * measurement it reasoned about was supplied by hand, so an operator who
   * turned Adaptive on got a switch that changed nothing. Three parts and one
   * seam between them:
   *
   *   - `EncoderChannel` is how a rate reaches an encoder that is already
   *     running, without respawning the pipeline (K-48). Constructed here,
   *     once, because it holds what each camera's encoder last confirmed and
   *     registers a listener on the supervisor that must survive every
   *     restart of every pipeline.
   *   - `Viewers` is who is watching and what it costs. It stamps a browser's
   *     statistic with **this** clock as it arrives and hands it on once,
   *     then. Nothing re-dates it: `rate.ts` refuses to read a stale report as
   *     headroom, and that refusal is only worth anything if what feeds it
   *     cannot manufacture freshness.
   *   - `Adaptation` runs one controller per camera on this daemon's own
   *     clock and carries every decision back to `Viewers`, which is what
   *     puts the reason on the picture.
   *
   * Assembled here rather than in `buildRenderers`, and deliberately: none of
   * it is a renderer — an apply must not wait on it and a rollback must not
   * re-run it — and all three need the applied configuration read fresh,
   * which is what `reachConfig()` above already is. Beside the sampler,
   * because it is the other thing this daemon runs on a timer of its own.
   *
   * Absent when `buildRenderers` threw, which is a `secrets.yaml` this daemon
   * could not read: there is no supervisor to command an encoder through, and
   * `POST …/viewers/:viewer` says so rather than accepting statistics nothing
   * would act on.
   */
  const encoders = built === undefined
    ? undefined
    : new EncoderChannel({ supervisor: built.supervisor, clock });
  let viewers: Viewers | undefined;
  let adaptation: Adaptation | undefined;
  if (encoders !== undefined) {
    const channel = encoders;
    const watching = new Viewers({
      cameras: () => reachConfig().cameras,
      // What the pipeline is running, never what the configuration asks for.
      // The pair that disagrees is K-48, and this is the side of it that is
      // true.
      inForce: (id) => channel.inForce(id),
      clock,
      // Handed on as it arrives, with the stamp it arrived under. `Viewers`
      // has already decided whether this browser is an active video
      // subscriber of that camera, which is the filter §8.2 asks for.
      onReport: (report) => { adaptation?.observe(report); },
    });
    viewers = watching;
    adaptation = new Adaptation({
      channel,
      cameras: () => reachConfig().cameras,
      clock,
      // Before anything is decided, so a Full rate hold nobody renewed is not
      // still being charged to the path when the allowance is worked out.
      onTick: (now) => { watching.sweep(now); },
      onDecisions: (decisions) => { watching.decided(decisions); },
    });
    adaptation.start();
  }
  // The telemetry equivalent, and on its own clock for the same reason
  // (R-NET-10's argument, applied to the router's own counters): the sparkline
  // and the per-station lamps must already be drawn when the Telemetry page is
  // opened, not start flat and fill in while an operator watches. Absent on a
  // device with no serial opener — see BuildRenderersOptions.mavlink.
  built?.mavlinkRenderer?.startSampling();

  // The control plane's own copy of the traffic (R-MAV-05), bound to loopback
  // and nothing else (R-MAV-07). Awaited because binding a socket takes
  // microseconds and a daemon whose state is settled before it serves is one
  // less race — and safe to await because `start()` never rejects: K-19's rule
  // says nothing on this path may be able to take the daemon down, and a port
  // already in use costs a Telemetry page its heartbeat, never a device its
  // console (rule 6). The ground stations are unaffected either way; raw
  // MAVLink never passes through this process (R-MAV-06).
  await built?.mavlinkListener?.start();

  // No secret is ever printed. That mechanism existed to surface a random
  // per-device access-point passphrase and there is no longer one to surface
  // (ADR-0007). What an operator does need telling is that the device is
  // still on the published default — which stays true on every boot until
  // they change it, not just the boot that seeded it.
  if (built?.secrets.get("ap_psk") === DEFAULT_AP_PASSPHRASE) {
    note("access point: using the published default passphrase; change it from the console");
  }

  // The confirmation windows come from the configuration (R-CFG-03). Read
  // here rather than per apply, and defaulted when config.yaml will not load:
  // an unloadable configuration must not also cost the operator the window
  // they are relying on to get back in.
  let windows = DEFAULT_CONFIG.apply;
  try {
    windows = loadConfig(opts.configPath).apply;
  } catch {
    warn("using the default confirmation windows; the configuration could not be read");
  }

  const engine = new ApplyEngine({
    configPath: opts.configPath,
    journalPath: opts.journalPath,
    renderers: [...opts.renderers, ...netRenderers],
    renderTimeoutMs: opts.renderTimeoutMs,
    timeoutMs: windows.timeout * 1000,
    radioTimeoutMs: windows.radioTimeout * 1000,
    clock,
    degraded,
    // R-CFG-11: a join confirms itself, because the operator cannot - the
    // console leaves the air with the access point. `client` is the same
    // NmcliClient the watchdog uses, so this asks the radio directly.
    verifyRadioMove: (target) => joinSucceeded({
      target,
      client,
      runner: opts.runner ?? systemRunner,
      clock,
      log: (line) => process.stdout.write(`${line}\n`),
    }),
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

  // The interface the modem's bytes actually go out of, read from
  // ModemManager because it is the only thing that knows it. Its own unit
  // rather than a closure here, for the reason pathDevices records: this file
  // is wiring, not a second place that decides what a modem is. What may be
  // remembered about a modem and what may not is R-CEL-13, stated there with
  // its tests.
  const modemPort = new ModemNetPort(modemClient, clock);

  // Which way out is working, assembled from the parts in net/reach/.
  //
  // Built here, from the same NmcliClient and the same CommandRunner as
  // everything else, so a test injecting a fake runner cannot reach a real
  // `curl` — and built even when buildRenderers threw, because the watchdog
  // below asks it a question and a board whose secret store is unreadable is
  // exactly the board that must still raise its access point.
  //
  // Every input is read fresh on each call rather than captured — see
  // reachConfig, above, which is where that is done and why.
  const reach = new ReachMonitor({
    standing,
    probe: commandProbe(opts.runner ?? systemRunner),
    ...(opts.counters !== undefined ? { counters: opts.counters } : {}),
    devices: async () => {
      const config = reachConfig();
      const [devices, net] = await Promise.all([client.devices(), modemPort.interfaceFor(config)]);
      return pathDevices(config, devices, net);
    },
    // What NetworkManager says about the interfaces themselves, so a port
    // with no cable in it is reported as down rather than as up and untested
    // (R-NET-14). The control port is passed as the modem's second name for
    // the same reason `holding` passes it: NetworkManager reports a state for
    // `cdc-wdm0` and has no entry at all for the `wwan0` the bytes go out of.
    down: async () => {
      const config = reachConfig();
      const [devices, net] = await Promise.all([client.devices(), modemPort.interfaceFor(config)]);
      return pathsDown(devices, pathDevices(config, devices, net), pathDevices(config, devices));
    },
    order: () => reachOrder(reachConfig()),
    holding: async () => {
      const config = reachConfig();
      const [devices, addresses, net] = await Promise.all([
        client.devices(), client.activeIpv4(), modemPort.interfaceFor(config),
      ]);
      return pathsHolding(
        reachOrder(config),
        pathDevices(config, devices, net),
        addresses,
        config.network.ap.address.split("/")[0] ?? "",
        // The other name the same path answers to, so an address reported
        // against the control port is not read as "the modem is not in use".
        pathDevices(config, devices),
      );
    },
    log: note,
  });

  // What decides when to probe. Without it the monitor above is only ever
  // asked questions and never told anything: nothing would stand down, and
  // `carrying` below would answer true for ever — which is the pre-Task-8
  // behaviour wearing the new mechanism's clothes.
  //
  // The counters are the kernel's own and cost nothing to read, so a device
  // that is working spends nothing on establishing that (R-CEL-09, R-NET-13).
  reachWatch = new ReachWatch({
    monitor: reach, clock, log: note,
    ...(opts.counters !== undefined ? { counters: opts.counters } : {}),
  });

  const watchdog = new FallbackWatchdog({
    client,
    clock,
    config: watchdogConfig,
    since: startedAt,
    // K-42. An address is not a way back: a modem with the wrong APN
    // registers, attaches, takes an address and installs a route while
    // completing no request, and a device configured that way from the boot
    // partition with no other path never raised its access point.
    //
    // The monitor answers true on every doubt — a path nothing has probed
    // yet, an address belonging to no path it knows, a question it could not
    // ask — so wiring this in can only ever make the fallback fire *more*
    // readily than the address check alone, never less. That direction is the
    // one rule 6 allows.
    carrying: () => reach.carrying(),
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
    log: note,
  });
  watchdog.start();
  // Started with the watchdog, because the watchdog's question is the one it
  // exists to be able to answer, and it needs the whole fallback window to
  // gather consecutive evidence before that question is asked (K-42).
  reachWatch.start();

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

  // Undefined only when buildRenderers threw, which is a secrets.yaml this
  // daemon could not read. That is *cannot tell*, not *no password*, and the
  // router treats it as the former: it refuses the configuration routes
  // rather than assuming a device with an unreadable secret store has no
  // lock on it. GET /status is unaffected, so the fault is still visible.
  const credential = built === undefined ? undefined : new AdminCredential(built.secrets);

  // Setting the administrator password changes what the console *is* — an
  // empty flows file and one page become the console proper behind a login —
  // and that shape is decided when settings.js is generated. So the file has
  // to be rewritten and the console restarted, or the operator sets a
  // password and the setup page stays until something else happens to apply.
  //
  // Deferred, and that is the whole point of the timer. Restarting the
  // console is what answers the operator's browser: kill it while it is still
  // writing the "the password is set" page and they get a connection reset
  // instead, on the one interaction every single user has. The delay is
  // generous by the standards of a local socket and costs nothing.
  //
  // Only the console renderer, not engine.renderCurrent(): a password is not
  // a network change, and there is no reason for setting one to issue a
  // single nmcli command.
  let provisionTimer: unknown;
  const consoleRenderer = built?.consoleRenderer;
  const onProvisioned = consoleRenderer === undefined ? undefined : (): void => {
    if (provisionTimer !== undefined) clock.clearTimer(provisionTimer);
    provisionTimer = clock.setTimer(PROVISION_RESTART_DELAY_MS, () => {
      provisionTimer = undefined;
      void (async () => {
        try {
          await consoleRenderer.render(loadConfig(opts.configPath));
        } catch (e) {
          // Never fatal. The password is set either way, and a console that
          // did not restart comes back into the right mode on the next apply
          // or the next boot.
          warn(`could not restart the console after the password was set: ${(e as Error).message}`);
        }
      })();
    });
  };

  // The probes the diagnostics page runs, over the same runner the renderers
  // use. Built here rather than defaulted inside the router so that a test
  // injecting a fake runner cannot reach a real `ping` — see DiagProbes.
  const probeRunner = opts.runner ?? systemRunner;
  const diag: DiagProbes = {
    ping: (host, count) => ping(host, { runner: probeRunner, clock, ...(count === undefined ? {} : { count }) }),
    reachable: () => reachable({ runner: probeRunner, clock }),
  };

  const route = createRouter({
    engine,
    configPath: opts.configPath,
    credential,
    diag,
    // Outside the block below on purpose: reading the supply register needs no
    // secret store, and a board whose secrets.yaml is unreadable is exactly the
    // one whose brownouts an operator wants recorded (R-SYS-09).
    supply: () => readSupply({ runner: probeRunner }),
    // Absent when buildRenderers threw. GET /net/scan then says this device
    // cannot scan, which is true, rather than reporting an empty air; and
    // POST /net/join refuses rather than applying a configuration whose
    // secret reference points at nothing.
    ...(built === undefined ? {} : {
      scan: () => scanForNetworks(client),
      netState: async () => {
        const [devices, addresses] = await Promise.all([client.devices(), client.activeIpv4()]);
        return networkState(loadConfig(opts.configPath), devices, addresses);
      },
      // What the modem says about itself, read from ModemManager and never
      // from the configuration — the APN comes off the connected bearer, so
      // this reports what the link is actually using rather than what was
      // asked for, which is the pair that disagrees exactly when it matters.
      modemState: async () => {
        const config = loadConfig(opts.configPath);
        const paths = await modemClient.modems();
        // No modem is an ordinary answer, not a failure. A board without one
        // is an ordinary board, and an appliance is a named adapter
        // ModemManager will never have heard of — modemState says which of
        // those this is, and the nulls are what "not measured" looks like.
        // Never zeroes: 0 dBm is a real and extraordinary reading.
        if (paths.length === 0) {
          return modemState(config, null, null, { rssi: null, rsrq: null, rsrp: null, snr: null });
        }
        const modem = await modemClient.modem(paths[0]);
        await armSignal(modem.path);
        const bearer = await modemClient.connectedBearer(modem);
        const signal = await modemClient.signal(modem.path);
        return modemState(config, modem, bearer, signal);
      },
      secrets: built.secrets,
      // The interface's kernel byte counters, not ZeroTier's own /metrics —
      // measured empty (0 bytes) on a real board. This is the same call the
      // route already makes; readTraffic only ever runs once readRemoteState
      // has found the configured network's interface, so it costs nothing on
      // every other phase. `throughput` hands the sampler the same interface
      // name so its rate matches the byte counters beside it, and is the only
      // way anything in this daemon reaches into the sampler.
      remoteState: () => readRemoteState(loadConfig(opts.configPath), built.zerotier, {
        readTraffic,
        throughput: (iface) => sampler.forInterface(iface),
      }),
      // The camera layer, over the same runner as everything else — so a test
      // injecting a fake runner gets a fake v4l2-ctl for free, and nothing
      // reaches a real one by omission.
      cameras: {
        detect: () => detectCameras({ runner: probeRunner }),
        probe: (node, card) => probeCamera(node, card, { runner: probeRunner }),
      },
      encoder: () => probeEncoder({ runner: probeRunner }),
      // Over the same runner as everything else in this block, for the same
      // reason: a test that injects a fake runner must get a fake v4l2-ctl
      // for POST …/controls too, not a real one by omission.
      applyControls: (opts) => applyControls({ ...opts, runner: probeRunner }),
      // One supervisor, for the process's lifetime. See buildRenderers.
      supervisor: built.supervisor,
      // The one value this router can reach in the secret store, and the one
      // route that spends it is GET /cameras/:id/stream-address (R-SEC-10).
      // Absent until the media server has been configured once, which the
      // rendering says in words rather than printing a URL that would not work.
      rtspPassword: () => built.secrets.get("rtsp_password") ?? null,
      // Every address this device answers on: what the radio holds, then what
      // the mesh assigned. The stream address names one of these and lists the
      // rest beneath it, because a board on a mesh has several and only one of
      // them is the one the operator is actually reaching it on (R-VID-15).
      addresses: async () => {
        const config = reachConfig();
        const [local, mesh, devices, net] = await Promise.all([
          client.activeIpv4(),
          readRemoteState(config, built.zerotier, { readTraffic }),
          client.devices(),
          modemPort.interfaceFor(config),
        ]);
        /**
         * **Which path a peer would reach each address over** (R-UI-24,
         * `RouterDeps.addresses`). Assembled here because every reading it
         * needs is here, and decided in `net/dial-in.ts`, because that
         * decision is the join the whole of R-UI-24 rests on.
         *
         * **The same pair of device maps `holding` and `down` take**, and for
         * the identical reason: NetworkManager binds the modem's address to
         * the control port `cdc-wdm0` and ModemManager names the net port
         * `wwan0`, so a comparison against one of them alone is trivially
         * true. `pathDevices(config, devices, net)` names the second and
         * `pathDevices(config, devices)` the first. Passing only the first was
         * this join's own defect: it marked the CGNAT address dialable on
         * every board in auto mode, which is the flying case.
         */
        return answerableAddresses({
          local,
          mesh: mesh.addresses,
          devices: pathDevices(config, devices, net),
          alsoKnownAs: pathDevices(config, devices),
          apAddress: config.network.ap.address,
        });
      },
    }),
    // Last, so it wins over the real probes above rather than sitting beside
    // them. Absent in production: main() never sets it (ServerOptions.cameraLayer).
    ...(opts.cameraLayer === undefined ? {} : {
      cameras: opts.cameraLayer.cameras,
      encoder: opts.cameraLayer.encoder,
      rtspPassword: opts.cameraLayer.rtspPassword,
    }),
    // Outside the `built` block above because it is a `let` that block
    // cannot narrow, and the condition is the same one: no supervisor, no
    // register of who is watching.
    ...(viewers === undefined ? {} : { viewers }),
    // Not behind `built`: the reach monitor is assembled from the runner and
    // the nmcli client, neither of which depends on the secret store, so a
    // board whose secrets.yaml is unreadable can still say which way out is
    // working — which is most of what an operator needs to fix it.
    reachState: () => reach.state(),
    testPath: async (path) => reach.test(path),
    // The renderer itself: it already has the shape `MavlinkControl` asks for,
    // and it is the only object that knows both what was measured and whether
    // `mavlink-router` is on the air. Absent on a device with no serial
    // opener, and every /mav/* route then says so.
    ...(built?.mavlinkRenderer === undefined ? {} : { mavlink: built.mavlinkRenderer }),
    ...(onProvisioned === undefined ? {} : { onProvisioned }),
  });

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
      note("network: a wifi radio became usable; rendering again");
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
        // Stopped with it, and for the same reason one step further: a tick
        // loop outliving its daemon would go on running `curl` on somebody's
        // metered link on behalf of a process that has closed its socket.
        reachWatch.stop();
        // And with them, the re-metric the reach watch is the only caller of.
        remetricStopped = true;
        built?.renderer.cancelRadioWait();
        // The third timer this daemon can own. Same reason as the other two:
        // one still armed after close() would restart a console on behalf of
        // a process that has already let go of its socket.
        if (provisionTimer !== undefined) clock.clearTimer(provisionTimer);
        // The fourth, and the newest: a sampler still ticking after close()
        // would go on reading sysfs for an interface this process no longer
        // answers questions about.
        sampler.stop();
        // The fifth. A rate controller still ticking after close() would go
        // on writing bitrates into a running pipeline on behalf of a process
        // that has already let go of its socket — and, unlike the others,
        // it would be commanding hardware while it did it.
        adaptation?.stop();
        // The fifth: the telemetry sampler, and with it any sweep this
        // renderer had scheduled for thirty seconds' time.
        built?.mavlinkRenderer?.close();
        // And the socket it shares a tracker with. A listener outliving its
        // daemon would hold :14559 against the next one to start.
        built?.mavlinkListener?.close();
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
    journalPath: process.env.YONDER_JOURNAL ?? DEFAULT_JOURNAL_PATH,
    secretsPath: process.env.YONDER_SECRETS ?? "/etc/yonder/secrets.yaml",
    renderers: [],
    // The one place production console paths are decided. Everywhere else
    // they are given, so nothing can write to /opt/yonder by default.
    console: consolePathsFromEnv(),
    // The one place the production path is decided, as with the console
    // above, so nothing else can reach a real /etc/mediamtx by default. No
    // environment override, deliberately: mediamtx.service names this path
    // literally, and a daemon writing somewhere else would be a media server
    // whose listeners never change with the configuration.
    mediaConfigPath: MEDIA_CONFIG_PATH,
    /**
     * **The one place a real serial port is opened** (R-MAV-01), and the
     * line that stops the telemetry renderer being inert: without it
     * `buildRenderers` assembles no `MavlinkRenderer` at all, every `/mav/*`
     * route answers 503 and no `mavlink-router` is ever started.
     *
     * Given here rather than defaulted inside `buildRenderers`, for the same
     * reason `console` is: a default that touches hardware is a default a
     * test reaches by forgetting to override it, and this one would open a
     * node under `/dev` and run a real `stty`. Every call to what
     * `openPortWith` returns comes from `MavlinkRenderer` by way of
     * `detect()`, so every `stty` still runs on a renderer's stack and
     * through the injected runner (ADR-0006).
     */
    mavlink: mavlinkFromEnv(systemRunner, process.env, { log: warn }),
  });
  note("yonder-core listening");
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
