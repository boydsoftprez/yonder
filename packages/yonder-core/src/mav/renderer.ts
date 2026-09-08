// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import { writeFileDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import type { Config } from "../schema/config.js";
import { SweepInProgressError, detect, type DetectOutcome, type OpenPort } from "./detect.js";
import { forgetHint, readHint, writeHint } from "./hint.js";
import { LinkTracker, type LinkState } from "./link.js";
import { AUTOPILOT_ENDPOINT_NAME, routerConfig } from "./router/config.js";
import { parseStats } from "./router/stats.js";

/** The service that owns the serial port and fans MAVLink out (§4). */
export const ROUTER_UNIT = "mavlink-router";

/**
 * The one generated file. Rewritten from scratch on every apply that changes
 * it and never hand-edited (§4, R-CFG-13).
 *
 * Exported so `installer.test.ts` can assert it is inside `yonder-core`'s own
 * `ReadWritePaths`, the way it already asserts it for everything the console
 * renderer writes. A renderer whose write is denied by the sandbox is a
 * failure that appears only on a board.
 */
export const ROUTER_CONF_PATH = "/etc/mavlink-router/main.conf";

/**
 * What `device: auto` sweeps, in order: the header UARTs of both board
 * families, then a USB CDC-ACM device.
 *
 * §2 of the telemetry-plumbing design puts the autopilot on the same three
 * header pins on both families — UART0 on pins 8 and 10 of a Pi, UART2 on the
 * same pins of a Rockchip board. The Pi's is `/dev/ttyAMA0`. The Rockchip
 * board's is **`/dev/ttyS2`** on Armbian — `serial2` in the device tree's
 * aliases, the 8250 driver's `ttyS` — once the `uart2-m0` overlay has taken
 * it back from the boot console (40-uart.sh). `R-MAV-02` requires a USB
 * CDC-ACM device to work too, and `docs/configuration.md` documents exactly
 * these three as the values `device` takes besides `auto`, so this list is
 * that documentation and not a wider guess: `/dev/ttyUSB*` is an FTDI or
 * CP210x bridge, which is neither a hardware UART nor CDC-ACM, and nothing
 * in this repository asks for one.
 *
 * A node that is not there is not an error — it is silence, which is what
 * Task 15's post-condition says an un-rebooted UART overlay must look like.
 */
export const MAVLINK_DEVICES = ["/dev/ttyAMA0", "/dev/ttyS2", "/dev/ttyACM0"] as const;

/**
 * How long after a sweep that found nothing before another one is tried.
 *
 * §3: a board is routinely powered before the aircraft it is wired to, so a
 * detection that ran once at boot and gave up would need a reboot to notice
 * an autopilot plugged in afterwards. This costs nothing, because the router
 * is not running while nothing has been found — there is no traffic to
 * interrupt and no port being held.
 */
export const DETECT_RETRY_MS = 30_000;

/**
 * How often the router's own statistics are read out of the journal.
 *
 * The router prints a block per endpoint once a second (`ReportStats = true`,
 * measured on a board), so anything faster than that re-reads the same
 * numbers and produces a rate of zero between real movements. Two seconds
 * matches `TrafficSampler`'s own interval, for the same reason it has one:
 * the rate belongs to a cadence of its own, not to whenever a console
 * happens to ask.
 */
export const STATS_INTERVAL_MS = 2_000;

/**
 * How much of the journal one reading takes.
 *
 * A block is eleven lines and the most endpoints this configuration can
 * produce is six — the UART, the loopback copy, three ground stations and
 * ingest — so a full dump is at most 66 lines and 200 covers three of them.
 * `parseStats` keeps every complete block it finds and `LinkTracker.sampled`
 * takes the last reading of each name, so more than one dump in the window is
 * harmless; a partial block at either end is dropped rather than defaulted.
 */
export const STATS_LINES = 200;

/** The port and speed the router is to use. `DetectOutcome`'s two useful fields. */
interface SerialLink {
  device: string;
  baud: number;
}

/**
 * A sweep that ended without a link — R-MAV-13's two kinds of nothing. Named
 * so `moreTelling` below states in its own signature that it is only ever
 * asked to choose between failures, never to weigh one against a success.
 */
type NothingFound = Exclude<DetectOutcome, { kind: "found" }>;

export interface MavlinkRendererOptions {
  run: CommandRunner;
  /**
   * Opens a serial port at a speed. Injected, because **no test may open a
   * real one**; `openPortWith` in `mav/serial.ts` is the production one.
   */
  open: OpenPort;
  /** `/etc/mavlink-router/main.conf`. Given, never defaulted. */
  confPath: string;
  /** `/var/lib/yonder/mavlink-link.json`. Given, never defaulted. */
  hintPath: string;
  /**
   * The one `LinkTracker` for this device.
   *
   * **Injected, because two things write to it.** This renderer supplies the
   * sweep's outcome and the router's own counters; Task 11's loopback
   * listener supplies heartbeats off `127.0.0.1:14559`. Handing both the same
   * instance is what keeps `GET /mav/state` one answer rather than two halves
   * that have to be stitched together — and it keeps the listener depending
   * on `LinkTracker` rather than on this renderer. Defaulted to a fresh one
   * so the renderer stands alone in a test.
   */
  tracker?: LinkTracker;
  clock?: Clock;
  log?: (line: string) => void;
  /** Overrides DETECT_RETRY_MS. Test-only. */
  retryMs?: number;
  /** Overrides STATS_INTERVAL_MS. Test-only. */
  statsIntervalMs?: number;
}

/**
 * Decides when to detect, what to write, and when — rarely — to restart
 * `mavlink-router`. The only part of the telemetry path that shells out
 * ([ADR-0006](../../../../docs/adr/0006-nmcli-not-dbus.md)).
 *
 * **Adopt, then act only on difference.** The apply engine calls every
 * renderer on every apply and again when the daemon starts, so a `render()`
 * that detected and restarted unconditionally would seize the serial port
 * from a router that is already using it, or bounce a healthy telemetry link
 * because an unrelated setting changed. Either one drops the ground station
 * mid-flight, on an aircraft, for a change that had nothing to do with
 * telemetry. So a running router is evidence of a working link and is never
 * re-probed to confirm it: the port and speed it is using are read back out
 * of the file it was started with. Re-detection is an explicit operator
 * action arriving on its own route (`detectNow`), never a side effect of an
 * apply.
 *
 * **Nothing here throws.** `K-19`: renderers run in sequence and one that
 * throws stops the ones behind it. Beyond that, a failed apply reverts the
 * whole configuration and — for a change that moves the radio — reboots, on
 * an aircraft, which §5 makes the argument against at length. A router that
 * will not start is a telemetry fault and is reported as one: in the activity
 * log an operator reads, and in `state()`. It is also the ordinary state of
 * every board built before the offline payload carried `mavlink-router` at
 * all, and a renderer that failed those applies would leave those devices
 * unconfigurable.
 *
 * **This class opens no serial port itself.** `open` is injected: the sweep
 * `detect()` performs needs a `SerialPort`, and `mav/serial.ts` is the one
 * implementation of one against real hardware — `stty` through the same
 * injected runner, then `fs`. `buildRenderers` still assembles this renderer
 * only when a caller supplies an opener, exactly as it assembles the console
 * renderer only when a caller says where the console is, so that no test
 * reaches a real `/dev` by forgetting to override a default. `main()` is the
 * one caller that supplies the real one.
 */
export class MavlinkRenderer implements Renderer {
  readonly name = "mavlink";

  private readonly run: CommandRunner;
  private readonly open: OpenPort;
  private readonly confPath: string;
  private readonly hintPath: string;
  private readonly tracker: LinkTracker;
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly statsIntervalMs: number;

  /**
   * The last configuration rendered, so an operator action arriving on its
   * own route has something to render against. Set on every `render()`, and
   * the daemon renders the current configuration before it serves anything.
   */
  private lastConfig: Config | null = null;

  /**
   * The port and speed the router is running on, when it is running.
   *
   * Not a measurement, which is why it is here rather than in `LinkTracker`:
   * a probe found it at some point and the router has been using it ever
   * since. It is what lets `state()` report a link on the ordinary boot — a
   * daemon restarting under a router that has been carrying telemetry for
   * hours (R-MAV-06) — instead of reporting a search that is not happening.
   */
  private adopted: SerialLink | null = null;
  /** Whether the unit was active the last time anything asked systemd. */
  private running = false;

  /**
   * The operator pressed Stop (R-MAV-09), and no apply may undo that.
   *
   * Without it, `settle()` consulted only `autocast`: an operator stopped
   * telemetry, somebody changed the palette, and the next render probed the
   * now-free port and started the router again on its own.
   *
   * **Held here, and nowhere else.** `LinkTracker` carried a `stopped()` of
   * its own for a while, with no production caller: two places holding one
   * fact is how they stop agreeing, and the tracker had no way back out of it
   * except `observed()`, which only a sweep produces — so a pinned or adopted
   * link, which never sweeps, would have been stuck stopped for ever after one
   * stop. It was withdrawn rather than left dead, because a dead setter for a
   * flag this class already owns is an invitation to wire it back in. This is
   * the only owner, and `state()` below is the only thing that reports it.
   *
   * **And deliberately not persisted.** `autocast` is the answer to "should
   * telemetry be on after a boot" (R-MAV-08); a runtime stop that outlived a
   * reboot would quietly override it, and an operator who wants telemetry off
   * across boots has a setting that says exactly that.
   */
  private stoppedByOperator = false;

  /**
   * Held while something has the serial port, so two sweeps can never run at
   * once.
   *
   * **termios is per-tty, not per-descriptor.** Two sweeps overlapping set the
   * baud rate out from under each other and split one line discipline's byte
   * stream between them, so one of them can see a checksum-valid frame at a
   * speed the port is no longer running at — `found` at the wrong baud, which
   * is the single failure this whole module exists to prevent. It is also the
   * one `settleAndFlush` cannot defend against, because the corruption is in
   * the line settings and not in the buffer.
   *
   * The window is narrow and it is exactly where it hurts: the 30-second
   * retry is armed only while nothing has been found, so reaching it takes an
   * operator pressing *Detect again* while a board waits for an autopilot to
   * finish powering up — which is precisely when they would press it.
   */
  private holdingPort: Promise<void> | null = null;

  private retryTimer: unknown;
  private statsTimer: unknown;
  /** Set once a statistics read has failed, so the failure is said once. */
  private statsQuiet = false;

  constructor(opts: MavlinkRendererOptions) {
    this.run = opts.run;
    this.open = opts.open;
    this.confPath = opts.confPath;
    this.hintPath = opts.hintPath;
    this.clock = opts.clock ?? systemClock;
    this.tracker = opts.tracker ?? new LinkTracker({ clock: this.clock });
    this.log = opts.log ?? (() => {});
    this.retryMs = opts.retryMs ?? DETECT_RETRY_MS;
    this.statsIntervalMs = opts.statsIntervalMs ?? STATS_INTERVAL_MS;
  }

  /**
   * What the console's Telemetry page reads (R-MAV-10).
   *
   * Almost entirely the tracker's own answer. The one thing added is the
   * adopted link, and only the two fields adoption genuinely establishes: a
   * vehicle name and a system id come from a heartbeat and nothing here has
   * read one, so they stay null until the loopback feed supplies one.
   */
  state(): LinkState {
    const measured = this.tracker.state();
    // A probe in this process has spoken (`device` is set by every outcome,
    // found or not), or there is no router running to have adopted anything
    // from. In both the tracker's answer is the whole answer. There is no
    // case here for a stopped tracker: `stopped` is this class's own overlay
    // below, and `LinkTracker` has no way to produce it.
    const seen = this.adopted === null || !this.running || measured.device !== null
      ? measured
      : { ...measured, phase: "linked" as const, device: this.adopted.device, baud: this.adopted.baud };
    // R-MAV-09, last and over everything else — and **after** the adopted link
    // is merged rather than instead of it. A stop no longer takes the router
    // down (`stopTelemetry`), so the flight controller link and the loopback
    // copy are still up and the page goes on showing the port, the speed and
    // the heartbeat while saying that nothing is being sent on. Returning
    // early here would have thrown the port and speed away at exactly the
    // moment the operator still wants to see them.
    return this.stoppedByOperator ? { ...seen, phase: "stopped" } : seen;
  }

  /**
   * **Whether anything is being sent to the ground stations.**
   *
   * Not the same question as "is the process alive", and the two came apart
   * the moment a stop stopped meaning `systemctl stop`: while telemetry is
   * stopped `mavlink-router` is *running*, carrying the flight controller link
   * and the loopback copy, and sending to nobody. This is the one that answers
   * R-MAV-09 and drives the page's Start/Stop key; `routerRunning` below is
   * the other one. **They must not be reunified** — a reader who folds them
   * back together gets a page that says telemetry is flowing whenever the
   * service happens to be up.
   *
   * `LinkState` has no field for either, deliberately: every field there is a
   * measurement about the *autopilot*, and both of these are facts about this
   * device. But the page needs them — a link that was found while telemetry is
   * deliberately off, or while the generated file could not be written, reads
   * `linked` and is not flowing — and this is the only object that knows.
   * Exposed rather than re-asked, because ADR-0006 puts every `systemctl`
   * behind a renderer and the routes are not one.
   */
  get telemetryRunning(): boolean {
    return this.running && !this.stoppedByOperator;
  }

  /**
   * Whether `mavlink-router` is on the air at all, as of the last time systemd
   * was asked.
   *
   * The question the *path check* needs and `telemetryRunning` no longer
   * answers: the loopback copy this device hears the autopilot on is carried
   * by the router whether or not the ground stations are being sent to, so
   * "can anything arrive on `:14559`" and "is telemetry flowing" are now two
   * facts. Under a stop they differ, which is the entire point of the stop.
   */
  get routerRunning(): boolean {
    return this.running;
  }

  /**
   * Begin reading the router's own statistics on this renderer's own clock.
   *
   * Idempotent, and named apart from telemetry's own start and stop
   * (R-MAV-09) so the two can never be confused: this arms a poll, it does
   * not put a link on the air.
   */
  startSampling(): void {
    if (this.statsTimer !== undefined) return;
    this.scheduleStats();
  }

  /** Cancel every timer this renderer owns. The daemon calls it on shutdown. */
  close(): void {
    if (this.statsTimer !== undefined) {
      this.clock.clearTimer(this.statsTimer);
      this.statsTimer = undefined;
    }
    this.cancelRetry();
  }

  async render(config: Config): Promise<void> {
    this.lastConfig = config;
    // A fresh render supersedes a retry that was waiting to run: this render
    // is about to do the same work with a newer configuration.
    this.cancelRetry();
    try {
      // Queued rather than refused: an apply that changed the ground stations
      // still has to be written, and K-19 says this may not throw either. The
      // wait is bounded by one sweep — about 5.5 s — against the apply
      // engine's 60 s.
      await this.withPort(() => this.settle(config));
    } catch (error) {
      // Belt and braces over the per-step guards below. K-19, and §5: no
      // telemetry fault is worth reverting an operator's whole configuration
      // for, let alone rebooting an aircraft over.
      this.log(`mavlink: telemetry could not be brought up: ${(error as Error).message}`);
    }
  }

  /**
   * Stop the router, sweep the port it was holding, and start it again.
   *
   * The one route by which a working router loses its port, and an operator
   * asks for it explicitly with the interruption stated first (§4, and
   * R-NET-12's instinct). Task 11's `POST /mav/detect` is the only caller.
   *
   * **Refuses rather than queues** when something already has the port — see
   * `holdingPort`. This is the one entry point where waiting would be wrong:
   * it stops the router before it sweeps, so a queued second press means a
   * second interruption of every ground station to answer a question already
   * being answered. `SweepInProgressError` is `POST /mav/detect`'s 409.
   */
  async detectNow(): Promise<DetectOutcome> {
    const config = this.lastConfig;
    if (config === null) {
      throw new Error("no configuration has been rendered yet, so there is nothing to detect against");
    }
    if (this.holdingPort !== null) throw new SweepInProgressError();
    this.cancelRetry();
    return this.withPort(() => this.detecting(config));
  }

  /** `detectNow`'s body, run with the port to itself. */
  private async detecting(config: Config): Promise<DetectOutcome> {
    if (await this.isActive()) {
      // **The only `systemctl stop` left in this class.** Re-detection needs
      // the serial port and the router is holding it, which is why this one
      // survives — a stop of telemetry no longer does (`stopTelemetry`).
      this.log(
        `mavlink: stopping ${ROUTER_UNIT} to look for the autopilot again — `
          + (this.stoppedByOperator
            ? "telemetry is already stopped, so nothing is interrupted, but this device stops hearing "
              + "the aircraft until it comes back"
            : "every ground station receiving now is interrupted until it comes back"),
      );
      await this.systemctl("stop");
      this.running = false;
    }
    this.adopted = null;

    const outcome = await this.probe(config.mavlink);
    this.tracker.observed(outcome);
    if (outcome.kind !== "found") {
      // The hint that led here has just been disproved (R-MAV-13), and there
      // is no link for `routerConfig` to render, so the router stays down and
      // the ordinary cadence takes over.
      forgetHint(this.hintPath);
      this.log(`mavlink: nothing answered on ${outcome.device}; looking again in ${Math.round(this.retryMs / 1000)} s`);
      this.scheduleRetry();
      return outcome;
    }

    const link = { device: outcome.device, baud: outcome.baud };
    this.remember(link);
    // Through `toRender`, like every other write. Rendering `config.mavlink`
    // here would put the ground stations — and the TCP server — back on the
    // air on an operator who had switched them off, from a button that only
    // asked to look for the flight controller again.
    const wanted = this.toRender(config.mavlink);
    if (this.write(wanted, link)) {
      this.adopted = link;
      await this.startRouter(wanted, "start");
    }
    return outcome;
  }

  /**
   * Stop *sending*, and keep it stopped until someone says otherwise
   * (R-MAV-09).
   *
   * **This does not stop `mavlink-router`.** An operator stops telemetry to
   * stop broadcasting, not to blind themselves: killing the service would take
   * the flight controller link and the loopback copy down with the ground
   * stations, so the console would lose all sight of whether the aircraft is
   * even alive, and coming back would cost a full port-and-speed re-detection.
   * Instead the *configuration* changes — the ground-station endpoints come
   * out and the TCP server they connect to goes off — and the router is
   * restarted onto it. The UART endpoint and the `yonder` loopback copy stay,
   * so `heard()` goes on being called and the Autopilot row of the page stays
   * lit beside a Ground stations row that reads *stopped by you*.
   *
   * Both directions are now a configuration change plus a restart, which is
   * the mechanism every other change in this class already uses — `settle()`
   * does the whole of it, and `toRender` is the one place that knows a stop
   * is in force.
   *
   * The flag is set **before** the render, deliberately: a stop that failed
   * still means the operator asked for one, and the next apply must not read a
   * still-broadcasting router as consent to go on broadcasting.
   */
  async stopTelemetry(): Promise<void> {
    const config = this.lastConfig;
    if (config === null) {
      throw new Error("no configuration has been rendered yet, so there is nothing to stop telemetry from");
    }
    this.stoppedByOperator = true;
    // A sweep waiting to run would render against the configuration as
    // written; it is re-armed by settle() below if there is still nothing to
    // find, and will then render the stopped configuration instead.
    this.cancelRetry();
    this.log(
      "mavlink: stopping telemetry — every ground station receiving now stops receiving; "
        + "the flight controller link stays up, so this device goes on hearing the aircraft",
    );
    // **R-MAV-07 is not part of this decision, and silence about that would be
    // its own hazard.** Ingest is a command path the operator opened
    // deliberately, behind its own warning, and it is not a ground-station
    // path — so stopping the broadcast does not retract it. Said at the moment
    // of the stop rather than left for the operator to infer, because
    // "telemetry is off" and "nothing can command the vehicle" are exactly the
    // two things that would otherwise be confused.
    if (!config.mavlink.ingest.loopback_only) {
      this.log(
        "mavlink: MAVLink ingest is still open on every interface — stopping telemetry does not close it, "
          + "and anything that can reach this device can still command the vehicle (R-MAV-07)",
      );
    }
    try {
      // Queued behind a sweep, never run beside one: `settle` can reach the
      // serial port itself, and two things driving one tty is `holdingPort`'s
      // whole subject.
      await this.withPort(() => this.settle(config, { force: true }));
    } catch (error) {
      // Same reason render() cannot throw: this arrives on a route, and a
      // telemetry fault is worth a line, never an exception nobody catches.
      this.log(`mavlink: telemetry could not be stopped: ${(error as Error).message}`);
    }
  }

  /**
   * Put it back, whatever `autocast` says (R-MAV-09).
   *
   * `autocast` answers "should telemetry be on after a boot" (R-MAV-08); this
   * is an operator answering for now, so it outranks it. Reports through
   * `telemetryRunning` rather than by throwing, exactly as `render()` does and
   * for the same reasons.
   */
  async startTelemetry(): Promise<void> {
    const config = this.lastConfig;
    if (config === null) {
      throw new Error("no configuration has been rendered yet, so there is nothing to start telemetry from");
    }
    this.stoppedByOperator = false;
    this.cancelRetry();
    this.log("mavlink: starting telemetry — the configured ground stations begin receiving again");
    try {
      // The mirror image of stopTelemetry: the operator's own configuration is
      // rendered again, verbatim, and the router restarted onto it. Nothing was
      // edited in config.yaml by the stop, so nothing has to be recovered — and
      // `startRouter` re-announces an open ingest path at the moment it is bound
      // again (R-MAV-07), rather than leaving the log's last word on the subject
      // to be the stop's.
      await this.withPort(() => this.settle(config, { force: true }));
    } catch (error) {
      this.log(`mavlink: telemetry could not be brought up: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Run `work` with the serial port to itself.
   *
   * A plain promise chain rather than a library: one `await` and one
   * assignment, with no interleaving point between the two, is the whole of
   * the mutual exclusion needed on a single-threaded runtime. Every waiter
   * re-checks the loop condition after it wakes, so several queued at once
   * still go through one at a time.
   *
   * The lock is released on the failing path as well — the `finally` — and a
   * waiter is never rejected by the holder's failure: it simply gets the port
   * next. See `holdingPort` for what overlapping would cost.
   */
  private async withPort<T>(work: () => Promise<T>): Promise<T> {
    while (this.holdingPort !== null) await this.holdingPort;
    let release!: () => void;
    this.holdingPort = new Promise<void>((resolve) => { release = resolve; });
    try {
      return await work();
    } finally {
      this.holdingPort = null;
      release();
    }
  }

  /**
   * The `mavlink` section to *render*, which is not always the one the
   * operator wrote.
   *
   * R-MAV-09's stop is a change to what is sent, not a service that is killed
   * (see `stopTelemetry`), and this is the one place that knows it. The three
   * ground-station endpoints come out and the TCP server goes off — R-MAV-04
   * calls that server a way for ground stations that prefer TCP to connect, so
   * it is one of their paths and it goes with them. What stays is everything
   * the console needs to keep watching: the `[UartEndpoint autopilot]` block
   * and, by R-MAV-05, the `yonder` loopback copy, which `routerConfig` emits
   * unconditionally and gives no setting that could remove.
   *
   * **`ingest` is deliberately untouched.** It is not a ground-station path —
   * it is a listening socket an operator opened on purpose, having read a
   * warning band that says every device on every network can then command the
   * aircraft (R-MAV-07). Reversing that from a different control would mean one
   * switch silently overriding another's explicit security decision, and would
   * leave the page's "Accepting from" readout disagreeing with `config.yaml`.
   * `stopTelemetry` says out loud that the path is still open instead. Note
   * that removing the endpoints *does* close every command path that existed
   * because telemetry was being sent: a `Mode = Normal` UDP peer is
   * bidirectional, and the TCP server is gone with it.
   *
   * No new parameter on `routerConfig`: the shape wanted is exactly what that
   * pure function already produces from a section with no endpoints and no TCP
   * server, so this asks for it in its own vocabulary rather than teaching it a
   * second one.
   */
  private toRender(mavlink: Config["mavlink"]): Config["mavlink"] {
    if (!this.stoppedByOperator) return mavlink;
    return {
      ...mavlink,
      endpoints: [],
      // Redundant today — `routerConfig` already writes `TcpServerPort = 0`
      // whenever ingest is closed — and stated anyway, because this says what
      // a stop means rather than relying on how that function happens to gate
      // two switches together.
      tcp_server: { ...mavlink.tcp_server, enabled: false },
    };
  }

  private async settle(config: Config, opts: { force?: boolean } = {}): Promise<void> {
    const mavlink = config.mavlink;
    // What is actually rendered. Everything below reads this rather than
    // `mavlink`, deliberately: a single miss would put the ground stations
    // back on the air behind an operator who had switched them off.
    const wanted = this.toRender(mavlink);
    this.running = await this.isActive();

    // Whether a router that is *not* running may be started by this pass.
    //
    // `autocast` is the boot-time answer (R-MAV-08) and `force` is an operator
    // pressing Start or Stop (R-MAV-09). **No longer gated on
    // `stoppedByOperator`:** what that flag now controls is *what is rendered*,
    // and the configuration rendered under a stop sends to nobody — so starting
    // it cannot put telemetry back on the air, and refusing to start it would
    // only cost the operator the sight of their own aircraft. The flag still
    // outranks `autocast` in the sense that matters: no apply can make this
    // device broadcast again while it is set.
    const mayStart = opts.force === true || mavlink.autocast;

    const link = await this.resolve(mavlink);
    if (link === null) return;
    const reportSelected = (): void => {
      if (this.running && mavlink.serial.device !== "auto" && mavlink.serial.baud !== "auto") {
        this.tracker.selected(link);
      }
    };

    const desired = routerConfig(wanted, link);
    const current = this.read();
    if (desired === current) {
      this.adopted = link;
      // Nothing about the router's configuration changed.
      if (!this.running && mayStart) await this.startRouter(wanted, "start");
      reportSelected();
      return;
    }

    if (!this.write(wanted, link)) {
      // Nothing is flowing and nothing holds the port, so trying again costs
      // exactly what §3 says a retry costs. A full disk that empties, or a
      // directory an installer creates a minute later, both heal here.
      this.scheduleRetry();
      return;
    }
    this.adopted = link;

    if (this.running) {
      // The only restart this class performs on an apply, and only because
      // the file the router is running under is no longer the file the
      // configuration asks for. A stop and a start are both that same case.
      await this.startRouter(wanted, "restart");
    } else if (mayStart) {
      await this.startRouter(wanted, "start");
    }
    reportSelected();
  }

  /**
   * The port and speed to render, without touching the port where possible.
   *
   * `null` means there is nothing to render: either a sweep found nothing —
   * in which case the hint is discarded, the tracker is told, and another
   * sweep is scheduled — or a running router's own file names a link this
   * cannot read, where probing would seize a port from a router that is
   * working.
   */
  private async resolve(mavlink: Config["mavlink"]): Promise<SerialLink | null> {
    // Pinned wins outright: the operator has said what the link is, and
    // there is nothing for a sweep to discover.
    if (mavlink.serial.device !== "auto" && mavlink.serial.baud !== "auto") {
      return { device: mavlink.serial.device, baud: mavlink.serial.baud };
    }

    if (this.running) {
      // Adopt. A running router is evidence of a working link, and the file
      // it was started with names the port and speed it is holding.
      const adopted = linkFromConf(this.read());
      if (adopted === null) {
        this.log(
          `mavlink: ${ROUTER_UNIT} is running but ${this.confPath} names no link that can be read; `
            + "leaving it alone rather than taking the port off it",
        );
        return null;
      }

      // **A pinned field the router is not honouring is a real difference.**
      //
      // `device` and `baud` are independent, and half-pinning is the natural
      // way to say "I know the port, find the speed" — the values
      // docs/configuration.md documents for `device` are exactly that case.
      // Adopting the running link outright made `desired === current`, so an
      // operator who moved their flight controller to USB and pinned it got a
      // successful apply, no restart, nothing in the log, and a page still
      // reporting the dead UART as linked. That is the mirror image of the
      // bug adoption exists to prevent, and it had to be measured against
      // this class rather than reasoned about.
      const pinnedDevice = mavlink.serial.device === "auto" ? null : mavlink.serial.device;
      const pinnedBaud = mavlink.serial.baud === "auto" ? null : mavlink.serial.baud;

      if (pinnedDevice !== null && pinnedDevice !== adopted.device) {
        // The speed on the pinned port is unknown and only a sweep can supply
        // it — but the router is holding a *different* port (that is what this
        // branch means), so the pinned one is free and the sweep costs the
        // running link nothing. Telemetry is interrupted only if the sweep
        // finds something to switch to, which is R-MAV-16 exactly.
        this.log(
          `mavlink: the configuration pins ${pinnedDevice} and ${ROUTER_UNIT} is holding ${adopted.device}; `
            + `looking for the autopilot on ${pinnedDevice} while the current link keeps running`,
        );
        const found = await this.probed(mavlink);
        if (found === null) {
          // Nothing on the port they pinned. The working link is left exactly
          // as it is — taking it down would answer a question nobody asked —
          // and the ordinary cadence keeps looking at the pinned port.
          // `probed` cleared the adopted link on the way out, which is right
          // when a sweep is the only thing that knew about it and wrong here:
          // the router did not stop, and is still on it.
          this.adopted = adopted;
          this.log(
            `mavlink: nothing answered on ${pinnedDevice}, so ${adopted.device} is still carrying telemetry`,
          );
          return null;
        }
        return found;
      }

      if (pinnedBaud !== null && pinnedBaud !== adopted.baud) {
        // Both halves are known without opening anything: the port the router
        // is already on, at the speed the operator pinned. A sweep here would
        // seize a port to rediscover a number that was just handed to us.
        this.log(
          `mavlink: the configuration pins ${pinnedBaud} baud and ${ROUTER_UNIT} is running at ${adopted.baud}`,
        );
        return { device: adopted.device, baud: pinnedBaud };
      }

      return adopted;
    }

    return this.probed(mavlink);
  }

  /**
   * Sweep, tell the tracker, and keep or discard the hint accordingly.
   *
   * `null` for either kind of nothing (R-MAV-13), with another sweep armed —
   * §3's cadence, which costs nothing because the router is not running on
   * the port that was swept.
   */
  private async probed(mavlink: Config["mavlink"]): Promise<SerialLink | null> {
    const outcome = await this.probe(mavlink);
    this.tracker.observed(outcome);
    if (outcome.kind !== "found") {
      this.adopted = null;
      forgetHint(this.hintPath);
      this.log(
        `mavlink: nothing answered on ${outcome.device}; looking again in ${Math.round(this.retryMs / 1000)} s`,
      );
      this.scheduleRetry();
      return null;
    }
    const link = { device: outcome.device, baud: outcome.baud };
    this.remember(link);
    return link;
  }

  /**
   * The sweep, across every device this configuration allows.
   *
   * `detect()` handles one device; `device: auto` is the shipped default and
   * R-MAV-02 asks for two kinds of them, so the loop is here. It never
   * throws: a device node that will not open is R-MAV-13's silence for that
   * device (Task 15's post-condition says so in as many words), and the whole
   * point of `silent` and `noise` is that nothing found is not a failure.
   */
  private async probe(mavlink: Config["mavlink"]): Promise<DetectOutcome> {
    const hint = readHint(this.hintPath);
    const devices = mavlink.serial.device === "auto"
      ? hintFirst(MAVLINK_DEVICES, hint?.device)
      : [mavlink.serial.device];
    const bauds = mavlink.serial.baud === "auto" ? undefined : [mavlink.serial.baud];

    let best: NothingFound | null = null;
    for (const device of devices) {
      let outcome: DetectOutcome;
      try {
        outcome = await detect({
          device,
          open: this.open,
          clock: this.clock,
          // The journal this class writes to, with this class's prefix on it.
          // `detect()` has neither, and should not learn either.
          log: (line) => { this.log(`mavlink: ${line}`); },
          ...(bauds === undefined ? {} : { bauds }),
          // Only for the device the hint actually names, and only when the
          // speed is still being searched for: `first` is a remembered answer,
          // not a preference to apply to a port it was never measured on.
          ...(hint !== undefined && hint.device === device && bauds === undefined ? { first: hint.baud } : {}),
        });
      } catch (error) {
        // A node that is not there, or one that will not open. Reported as
        // silence with nothing tried, because nothing was: an empty
        // `triedBauds` is the honest difference between "swept and heard
        // nothing" and "there was nothing here to sweep".
        this.log(`mavlink: ${device} could not be opened (${(error as Error).message})`);
        outcome = { kind: "silent", device, triedBauds: [] };
      }
      if (outcome.kind === "found") return outcome;
      best = moreTelling(best, outcome);
    }
    // `devices` is never empty — the schema gives `device` a minimum length of
    // one — but the fallback keeps this total rather than resting on that.
    return best ?? { kind: "silent", device: devices[0] ?? "auto", triedBauds: [] };
  }

  /** Record a found link as the hint to try first next time (R-MAV-13). */
  private remember(link: SerialLink): void {
    try {
      writeHint(this.hintPath, link);
    } catch (error) {
      // A hint is an optimisation on the path to telemetry starting at all
      // (R-MAV-08). Losing one costs a sweep, never a link.
      this.log(`mavlink: the link that was found could not be remembered: ${(error as Error).message}`);
    }
  }

  /** The generated file as it stands, or null when it is absent or unreadable. */
  private read(): string | null {
    try {
      return readFileSync(this.confPath, "utf8");
    } catch {
      return null;
    }
  }

  /** Write the generated file. False when it could not be written. */
  private write(mavlink: Config["mavlink"], link: SerialLink): boolean {
    const text = routerConfig(mavlink, link);
    try {
      // The installer's own role creates this directory (and the unit's
      // ReadWritePaths names it), so this is a no-op on a board built for
      // telemetry and the whole of it on one that was not.
      mkdirSync(dirname(this.confPath), { recursive: true });
      writeFileDurable(this.confPath, text, 0o644);
      return true;
    } catch (error) {
      this.log(`mavlink: ${this.confPath} could not be written: ${(error as Error).message}`);
      return false;
    }
  }

  private async isActive(): Promise<boolean> {
    // `is-active` exits 0 only while the unit is running; every other state,
    // and a unit systemd has never heard of, is a non-zero code with a word
    // for it on stdout. Nothing here needs to tell those apart — the question
    // is only whether there is a router holding the port.
    const { code } = await this.run(["systemctl", "is-active", ROUTER_UNIT]);
    return code === 0;
  }

  private async systemctl(verb: "start" | "stop" | "restart"): Promise<boolean> {
    // No SYSTEMCTL_SKIP_SYSV here, unlike `remote/renderer.ts`. That variable
    // exists for the client-side SysV compatibility step, which systemctl runs
    // only for `enable` and `disable` — the two verbs this renderer never uses.
    // `start`, `stop` and `restart` go straight to PID 1 over D-Bus and touch
    // nothing under /etc, so there is nothing for the read-only mount to
    // refuse (K-34).
    const { code, stdout, stderr } = await this.run(["systemctl", verb, ROUTER_UNIT]);
    if (code === 0) return true;
    this.log(`mavlink: systemctl ${verb} ${ROUTER_UNIT} failed: ${said(stderr, stdout, code)}`);
    return false;
  }

  private async startRouter(mavlink: Config["mavlink"], verb: "start" | "restart"): Promise<void> {
    if (verb === "restart") {
      // `mavlink` here is always the *rendered* section, so an empty endpoint
      // list is the honest test for "nobody is receiving": it covers a stop
      // (`toRender` empties it) and a device that has none configured, and in
      // both "interrupted while it comes back" would promise a return that is
      // not coming.
      this.log(
        mavlink.endpoints.length === 0
          ? `mavlink: restarting ${ROUTER_UNIT} — the flight controller link stays up and nothing is sent on`
          : `mavlink: restarting ${ROUTER_UNIT} because its configuration changed — `
            + "every ground station receiving now is interrupted while it comes back",
      );
    }
    const ok = await this.systemctl(verb);
    this.running = ok;
    if (!ok) {
      // A failed *sweep* is retried because retrying costs nothing; a failed
      // *start* has exactly the same property — nothing is flowing and
      // nothing holds the port — and R-MAV-08 is a P1 that a single missed
      // `systemctl` should not be able to defeat until the next apply.
      this.scheduleRetry();
      return;
    }
    // R-MAV-07: said at the moment the socket is actually bound, which is
    // this one, and not on every apply that leaves it as it was.
    if (!mavlink.ingest.loopback_only) {
      this.log(
        "mavlink: MAVLink ingest is now open on every interface, not only loopback — "
          + "anything that can reach this device can command the vehicle (R-MAV-07)",
      );
    }
  }

  // -------------------------------------------------------- the two cadences

  private cancelRetry(): void {
    if (this.retryTimer === undefined) return;
    this.clock.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    this.retryTimer = this.clock.setTimer(this.retryMs, () => {
      this.retryTimer = undefined;
      const config = this.lastConfig;
      if (config === null) return;
      // Not awaited by anyone, so it must not be able to reject: an unhandled
      // rejection takes the daemon down under Node's default, and this is a
      // background retry, not an apply.
      void this.render(config);
    });
  }

  private scheduleStats(): void {
    this.statsTimer = this.clock.setTimer(this.statsIntervalMs, () => {
      void this.sample()
        // Nobody awaits this, so it must not be able to reject: an unhandled
        // rejection takes the daemon down under Node's default. `systemRunner`
        // never rejects, but `buildRenderers` accepts any runner a caller
        // hands it and `log` is caller-supplied, so the hazard is latent
        // rather than absent — and it is the same one `scheduleRetry` already
        // guards against two methods above.
        .catch((error: unknown) => { this.quietly((error as Error).message); })
        .finally(() => {
          // Re-armed only while the timer still belongs to this renderer:
          // close() clears it, and a tick already in flight must not put it
          // back.
          if (this.statsTimer !== undefined) this.scheduleStats();
        });
    });
  }

  /**
   * Say a sampling failure once, not every two seconds.
   *
   * A poll that repeats itself buries the activity pane, which is the defect
   * `trace` was split out of `note` for. Reset by the next reading that works,
   * so a failure that comes back is said again.
   */
  private quietly(reason: string): void {
    if (this.statsQuiet) return;
    this.statsQuiet = true;
    this.log(`mavlink: the router's statistics could not be read: ${reason}`);
  }

  /**
   * One reading of the router's own per-endpoint counters.
   *
   * `ReportStats = true` makes `mavlink-router` print a block per endpoint to
   * stdout once a second, and systemd puts stdout in the journal — so the
   * journal is where `LinkState.groundStations` and `.traffic` come from. It
   * is fetched through the injected `CommandRunner` like every other command
   * in this daemon, on this renderer's own cadence rather than when a console
   * happens to ask, exactly as `TrafficSampler` samples `/sys/class/net`.
   *
   * The names come from `config.mavlink.endpoints`, never from the block's
   * kind: `yonder` (R-MAV-05) and `inbound` (R-MAV-07) are `UdpEndpoint`s
   * exactly like a real ground station, and the loopback copy's counter moves
   * whenever telemetry flows at all — so a filter by kind would report
   * Yonder's own feed as a permanently-answering ground station on every
   * device.
   */
  private async sample(): Promise<void> {
    const config = this.lastConfig;
    if (config === null) return;

    // Re-asked here, not carried from the last apply. `running` was refreshed
    // only by `render()` and `detectNow()`, so a router that died between two
    // applies left the page reporting a link that was not flowing —
    // indefinitely, while this method went on differencing a journal tail that
    // had stopped growing. R-MAV-10 names telemetry-running as a thing to
    // report, so it is worth one `systemctl is-active` per sample.
    this.running = await this.isActive();

    // Nothing to read while no router is running: the journal still holds the
    // last blocks it printed, and differencing those against themselves is
    // exactly what `LinkTracker` already reports honestly — but spending a
    // subprocess every couple of seconds to learn nothing is not.
    if (!this.running) return;

    const { code, stdout, stderr } = await this.run([
      "journalctl",
      "-u",
      ROUTER_UNIT,
      "-n",
      String(STATS_LINES),
      "--no-pager",
      // Without this every line carries a syslog prefix and no block header
      // matches, so `parseStats` returns nothing at all.
      "-o",
      "cat",
    ]);
    if (code !== 0) {
      this.quietly(said(stderr, stdout, code));
      return;
    }
    this.statsQuiet = false;
    this.tracker.sampled(parseStats(stdout), config.mavlink.endpoints.map((endpoint) => endpoint.name));
  }
}

/**
 * The port and speed a running router is using, read back out of the file it
 * was started with.
 *
 * This is what makes adoption possible: the alternative to reading it here is
 * opening the port to ask, and the router is holding it. Parsed line by line
 * against the section name `router/config.ts` exports rather than by a regex
 * over the whole file, so a `Device` line under some other endpoint can never
 * be mistaken for the autopilot's.
 */
export function linkFromConf(text: string | null): SerialLink | null {
  if (text === null) return null;
  let inside = false;
  let device: string | null = null;
  let baud: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = line === `[UartEndpoint ${AUTOPILOT_ENDPOINT_NAME}]`;
      continue;
    }
    if (!inside) continue;
    const named = /^Device\s*=\s*(\S+)$/.exec(line);
    if (named !== null) {
      device = named[1];
      continue;
    }
    const speed = /^Baud\s*=\s*(\d+)$/.exec(line);
    if (speed !== null) baud = Number(speed[1]);
  }
  // Both, or neither: half a link is not one, and rendering against a
  // half-read file would restart the router onto a configuration nothing
  // asked for.
  return device !== null && baud !== null ? { device, baud } : null;
}

/** The hint's device first, and still swept in its turn if it fails. */
function hintFirst(devices: readonly string[], hinted: string | undefined): string[] {
  if (hinted === undefined) return [...devices];
  return [hinted, ...devices.filter((device) => device !== hinted)];
}

/**
 * Which of two failed sweeps says more.
 *
 * `noise` beats `silent` — bytes reaching a pin rules the wiring out and
 * points at the autopilot's own protocol and baud settings (R-MAV-13), which
 * is a different errand for the operator. Between two of a kind, the one that
 * actually swept speeds beats one that could not open the node at all.
 */
function moreTelling(best: NothingFound | null, next: NothingFound): NothingFound {
  if (best === null) return next;
  if (next.kind === "noise" && best.kind === "silent") return next;
  if (best.kind === "noise" && next.kind === "silent") return best;
  return next.triedBauds.length > best.triedBauds.length ? next : best;
}

/**
 * Everything a command said about itself, or its exit status.
 *
 * All of it, joined, in the order it was said — `remote/renderer.ts` records
 * what taking only the first line cost (K-34): systemd's opening line is a
 * banner it prints on success too.
 */
function said(stderr: string, stdout: string, code: number): string {
  const lines = (stderr || stdout).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length === 0 ? `exited ${code}` : lines.join("; ");
}
