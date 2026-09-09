// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import { NmcliClient, type DeviceInfo } from "./nmcli/client.js";
import { enableWifiRadio, radioWanted } from "./radio.js";
import {
  configuredConnections, desiredProfiles, metricFor, radioPlan, wifiMode,
  AP_CONNECTION, CLIENT_CONNECTION, EGRESS_CONNECTIONS, ETHERNET_CONNECTION, MODEM_CONNECTION,
  type DesiredProfile, type Interfaces,
} from "./profiles.js";
import { bearerChanges, redialSettings } from "./modem/profiles.js";
import { NOTHING_STOOD_DOWN, PATH_WORDS, type PathName, type StandingView } from "./reach/standing.js";

/** The only connection names this renderer will ever create or delete. */
const OWNED = new Set([AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION]);

/**
 * How long to wait, after the first render, for a Wi-Fi radio NetworkManager
 * has not finished bringing up.
 *
 * On a cold boot `yonder-core` can start before NetworkManager has finished
 * with the radio. A real Raspberry Pi 4 printed this moments before the
 * daemon's first render would have run:
 *
 *     lo:loopback:connected (externally):lo
 *     eth0:ethernet:unavailable:
 *     wlan0:wifi:unavailable:
 *
 * A render against that list creates no working access point, and the
 * fallback watchdog's only action is `nmcli connection up yonder-ap` — a
 * profile that a render is the only thing that creates. So a slow radio was a
 * device that came up with no access point and no way to recover it, which is
 * the exact failure R-NET-07 exists to prevent.
 *
 * Bounded, and bounded well short of the 90 s fallback deadline, because
 * waiting is only ever worth doing while the radio might still appear. 30 s
 * is far longer than the few seconds a driver takes and still leaves the
 * watchdog most of its window. It also sits inside the 60 s per-renderer
 * timeout, so a render that waits cannot be the thing that trips it.
 */
export const RADIO_WAIT_MS = 30_000;

/** How often `device status` is re-read while waiting for the radio. */
export const RADIO_POLL_MS = 1_000;

/**
 * States that mean "NetworkManager knows about this device but cannot act on
 * it yet". `unavailable` is the one a real board printed for a radio still
 * coming up; `unknown` is NetworkManager saying it has no idea, which is not
 * something to configure against either.
 *
 * Everything else counts as usable, `disconnected` very much included — that
 * is a radio ready to be given a profile, which is all the access point
 * needs. `unmanaged` counts as usable too, deliberately: it means an operator
 * has told NetworkManager to keep its hands off, and waiting 30 s for that to
 * change would be waiting for a decision, not for hardware.
 */
const RADIO_NOT_READY = new Set(["unavailable", "unknown"]);

/**
 * Whether a device row describes something NetworkManager can act on.
 *
 * Compared on the first whitespace-delimited word, because a state is not
 * always a single one: the same board printed `connected (externally)` for
 * its loopback device, and a NetworkManager that ever appends a parenthesised
 * reason to `unavailable` must still be read as unavailable.
 */
export function deviceIsUsable(state: string): boolean {
  const word = state.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return word !== "" && !RADIO_NOT_READY.has(word);
}

/**
 * What to call a connection in a log line.
 *
 * Names, not identifiers. `docs/hardware/verifying-m1a.md` quotes these lines
 * as what a board prints, and an operator following that procedure on a bench
 * is matching text — so "bringing the access point up" stays exactly what it
 * has always been, rather than becoming `yonder-ap` because the code now
 * loops over a plan instead of branching.
 */
function connectionName(connection: string): string {
  if (connection === AP_CONNECTION) return "the access point";
  if (connection === CLIENT_CONNECTION) return "the wifi client";
  return connection;
}

/** `wlan0=unavailable`, for a log line that says which radio and why. */
function describe(devices: DeviceInfo[]): string {
  return devices.map((d) => `${d.device}=${d.state}`).join(" ") || "no wifi device";
}

/**
 * The modem's device, if this board has one.
 *
 * A named appliance wins outright: the operator has said which adapter it is,
 * and no amount of device-type inspection improves on being told (R-CEL-11).
 * Otherwise it is the `gsm` device, which is NetworkManager's own type for a
 * modem it reaches through ModemManager, and whose name is a control port.
 */
function modemDevice(config: Config, devices: DeviceInfo[]): string | null {
  const modem = config.network.modem;
  if (!modem.enabled) return null;
  if (modem.mode === "appliance") return modem.interface;
  return devices.find((d) => d.type === "gsm")?.device ?? null;
}

export interface NetworkRendererOptions {
  client: NmcliClient;
  secrets: SecretStore;
  log?: (line: string) => void;
  /**
   * Drives waitForRadio's bounded wait. Injected for the same reason as
   * everywhere else in this daemon: no test may wait on the wall clock.
   */
  clock?: Clock;
  /** Overrides RADIO_WAIT_MS. Test-only. */
  radioWaitMs?: number;
  /** Overrides RADIO_POLL_MS. Test-only. */
  radioPollMs?: number;
  /**
   * Which paths have stopped reaching anything (R-NET-13).
   *
   * **An input to generating route metrics, and nothing else.** This
   * renderer stays the only thing that writes a metric; standing only
   * changes what it writes, so `config.yaml` remains the single writer of
   * configuration and health decides participation rather than order.
   *
   * Defaults to a board where nothing has been stood down, so a renderer
   * built without one — every caller before this existed, and every test that
   * is not about failover — writes exactly the metrics `network.priority`
   * alone generates.
   */
  standing?: StandingView;
  /**
   * Called once, after a path has actually been re-dialled (R-CEL-09).
   *
   * A link that has just been dialled again is a link that has *just come
   * up*, and R-CEL-09 says such a link is tested with real traffic. Nothing
   * downstream can work that out for itself: a re-dial keeps the same
   * interface name — `wwan0` before and `wwan0` after — so a watch comparing
   * device names sees no change, and a cellular link that is not the path in
   * use moves no byte counters either. Between the two, a modem re-dialled
   * onto a wrong APN sits looking healthy for ever. This renderer is the one
   * component that *knows* a re-dial happened, so it says so rather than
   * leaving it to be inferred from something that did not change.
   *
   * **Narrow, and deliberately so.** It is a notification, not a hook: it
   * returns nothing, it cannot refuse a re-dial, and it cannot fail one — a
   * throw out of it is caught and logged, because a render that has otherwise
   * succeeded must not be turned into a failure by whoever wanted to be told
   * about it. It fires only on a real re-dial, never on the many other
   * reasons a render happens.
   */
  onRedial?: (path: PathName) => void;
}

export class NetworkRenderer implements Renderer {
  readonly name = "network";
  private readonly client: NmcliClient;
  private readonly secrets: SecretStore;
  private readonly log: (line: string) => void;
  private readonly clock: Clock;
  private readonly radioWaitMs: number;
  private readonly radioPollMs: number;
  private readonly standing: StandingView;
  private readonly onRedial: (path: PathName) => void;
  private waitTimer: unknown;
  private wakeWait: (() => void) | undefined;
  private waitCancelled = false;

  constructor(opts: NetworkRendererOptions) {
    this.client = opts.client;
    this.secrets = opts.secrets;
    this.log = opts.log ?? (() => {});
    this.clock = opts.clock ?? systemClock;
    this.radioWaitMs = opts.radioWaitMs ?? RADIO_WAIT_MS;
    this.radioPollMs = opts.radioPollMs ?? RADIO_POLL_MS;
    this.standing = opts.standing ?? NOTHING_STOOD_DOWN;
    this.onRedial = opts.onRedial ?? (() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Cancelled while the last poll was still in flight. Parking on a timer
      // now would mean waiting a full interval — or, on a clock a test drives
      // by hand, for ever — to notice something already decided.
      if (this.waitCancelled) { resolve(); return; }
      this.wakeWait = resolve;
      this.waitTimer = this.clock.setTimer(ms, () => {
        this.waitTimer = undefined;
        this.wakeWait = undefined;
        resolve();
      });
    });
  }

  /**
   * Abandon a wait in progress, and refuse to start another.
   *
   * The same reason FallbackWatchdog has stop(): a poll loop that outlives
   * the daemon it belongs to is a timer still asking NetworkManager questions
   * on behalf of a process that has closed its socket, and — if it were ever
   * to reach a render — reconfiguring a radio nobody is managing any more.
   * Idempotent, and safe to call when no wait is running.
   */
  cancelRadioWait(): void {
    this.waitCancelled = true;
    if (this.waitTimer !== undefined) {
      this.clock.clearTimer(this.waitTimer);
      this.waitTimer = undefined;
    }
    // Let a loop parked on sleep() run one more step and see the flag, rather
    // than leaving its promise pending for ever.
    const wake = this.wakeWait;
    this.wakeWait = undefined;
    wake?.();
  }

  /**
   * Wait for a Wi-Fi radio NetworkManager has not finished bringing up, and
   * say whether anything has changed enough to be worth rendering again.
   *
   * Returns **true** only when this call actually waited and a usable radio
   * then appeared — i.e. the caller's last render ran against a device list
   * that has since improved, so rendering again will do something the earlier
   * render could not. Returns **false** when there was nothing to wait for,
   * or when the bound ran out with no usable radio.
   *
   * Three ways to have no usable radio, told apart in the log because they
   * mean different things to whoever reads it, but all three waited on:
   *
   * - **A Wi-Fi device present but not usable** — `wlan0:wifi:unavailable:`,
   *   which is exactly what a real cold boot printed. NetworkManager knows
   *   about the radio and has not finished with it.
   * - **No Wi-Fi device at all yet.** Earlier in the same sequence:
   *   NetworkManager has not registered the device. This is the shape that
   *   costs an access-point *profile* rather than just an activation, because
   *   a render with no wifi interface writes no `yonder-ap` at all, and
   *   `up yonder-ap` is the fallback watchdog's only move.
   * - **`device status` failed outright.** The same race one layer down:
   *   NetworkManager itself not up yet. Kept waiting on rather than read as
   *   "this board has no radio", which is a conclusion drawn from a question
   *   that could not be asked.
   *
   * The bound is what makes a board with genuinely no radio legitimate rather
   * than a special case. Such a board waits once, at boot, in the background,
   * behind an already-bound socket, logs that it is running without one, and
   * never pays again. Distinguishing "absent because slow" from "absent
   * because there is none" is not possible from one reading of the list, and
   * guessing wrong in the other direction is a device nobody can reach.
   *
   * What the bound costs is a radio that appears just after it: nothing
   * renders, so no `yonder-ap` profile is ever written, and the fallback's
   * one action has nothing to raise. K-16 records that, and why re-arming
   * the watchdog is not the fix it looks like.
   */
  async waitForRadio(): Promise<boolean> {
    const deadline = this.clock.now() + this.radioWaitMs;
    let waited = false;

    for (;;) {
      if (this.waitCancelled) return false;
      let wifi: DeviceInfo[] | undefined;
      try {
        wifi = (await this.client.devices()).filter((d) => d.type === "wifi");
      } catch (e) {
        this.log(`network: cannot read device status yet (${(e as Error).message})`);
      }

      if (wifi !== undefined && wifi.some((d) => deviceIsUsable(d.state))) {
        if (waited) this.log(`network: wifi radio is usable now (${describe(wifi)})`);
        return waited;
      }

      const why = wifi === undefined ? "NetworkManager is not answering"
        : wifi.length === 0 ? "no wifi device is present"
        : describe(wifi);

      if (this.clock.now() >= deadline) {
        this.log(
          `network: no usable wifi radio after ${Math.round(this.radioWaitMs / 1000)} s (${why}); `
          + "carrying on without one",
        );
        return false;
      }

      if (!waited) {
        this.log(`network: no usable wifi radio yet (${why}); waiting for NetworkManager`);
        waited = true;
      }
      await this.sleep(this.radioPollMs);
    }
  }

  async render(config: Config): Promise<void> {
    // Before the device list is read, not after it.
    //
    // A Raspberry Pi ships its Wi-Fi radio behind two independent locks — the
    // kernel's rfkill soft block and NetworkManager's own persistent
    // `WirelessEnabled` flag — and a board carrying either of them reports
    // `wlan0:wifi:unavailable:`, which is the same shape as the cold-boot
    // race waitForRadio exists for and is not the same problem at all: a
    // block does not clear on its own, so waiting out the full RADIO_WAIT_MS
    // achieves nothing and the access point never comes up. On a freshly
    // flashed board that is R-CFG-08 broken outright (see radio.ts).
    //
    // Reading the device list first and clearing the locks only for a board
    // that listed a radio would look tidier and is a trap: whether a device
    // NetworkManager has been told to keep the radio off for appears in
    // `device status` at all is NetworkManager's business, not ours, and a
    // gate that depends on it deadlocks the moment it does not — no radio
    // listed, so no unblock, so no radio listed. Two commands that are
    // no-ops on hardware that does not need them are the cheaper side of
    // that trade, and neither can fail a render (enableWifiRadio never
    // throws).
    //
    // Every render, not once at install: a block is persistent state that a
    // board can acquire at any time, and the installer's own run happens in a
    // chroot during an image build, where `rfkill` would act on the build
    // host and `nmcli` has no NetworkManager to talk to. Gated on the
    // configuration wanting a radio at all, so an operator who has turned
    // Wi-Fi off is not overruled on every apply — see radioWanted.
    if (radioWanted(config)) {
      await enableWifiRadio(this.client.runner, this.log);
    }

    const devices = await this.client.devices();
    const ifaces: Interfaces = {
      wifi: devices.find((d) => d.type === "wifi")?.device ?? null,
      ethernet: devices.find((d) => d.type === "ethernet")?.device ?? null,
      modem: modemDevice(config, devices),
    };
    this.log(`network: wifi=${ifaces.wifi ?? "none"} ethernet=${ifaces.ethernet ?? "none"}`);

    // The standing is read here, at the moment the profiles are generated, so
    // a render never reinstates a metric that a demotion has already
    // superseded — which is what "a full render does not undo a demotion"
    // means (R-NET-13).
    const desired = desiredProfiles(config, this.secrets, ifaces, this.standing);

    // What is *wanted*, for the removal loop below, is deliberately not read
    // off `desired`. `desired` answers "what can be generated for the
    // interfaces this render can see", and a modem a second from finishing
    // enumeration answers that question "no" — correctly, there being
    // nothing to write yet — but that is not the same as the operator having
    // turned cellular off. Removal is decided from the configuration alone,
    // with no device list in the sentence at all (R-NET-16).
    const wanted = configuredConnections(config);

    const connections = await this.client.connections();

    // Remove only what we own and no longer want. A connection created by
    // someone else is never touched.
    for (const existing of connections) {
      if (OWNED.has(existing.name) && !wanted.has(existing.name)) {
        this.log(`network: removing ${existing.name}`);
        await this.client.remove(existing.name);
      }
    }

    // Asked **before** the profiles are written, and it can only be asked
    // then: once addOrModify has run, the stored profile already says what
    // was wanted and there is nothing left to compare against. This is the
    // one moment at which what the modem is actually dialled on is knowable.
    const redial = connections.some((c) => c.name === MODEM_CONNECTION)
      ? await this.modemChangesNeedingRedial(desired)
      : [];

    for (const profile of desired) {
      // A profile whose *type* has changed cannot be modified into the new
      // one — both modem modes write a connection called `yonder-modem`, and
      // an operator moving between them used to have ethernet properties
      // written onto a profile that stayed `gsm` and went on dialling as it
      // had. `addOrModify` replaces it, and says so here rather than only in
      // the journal: an operator who has just changed what kind of modem this
      // board has should see that the profile was made again (R-CFG-13).
      const wrote = await this.client.addOrModify(profile.name, profile);
      if (wrote === "replaced") {
        this.log(
          `network: ${profile.name} was a different kind of connection and has been `
          + `created again as a ${profile.type} one`,
        );
      }
    }

    // Stored metrics do not update an already active connection. Reapply
    // only a present, connected profile we just wrote, never a missing
    // modem or its in-progress boot dial. No second profile write is needed.
    for (const profile of desired) {
      if (!EGRESS_CONNECTIONS.some(([name]) => name === profile.name)) continue;
      if (profile.name === MODEM_CONNECTION && redial.length > 0) continue;
      const active = devices.find(d => d.connection === profile.name && d.state === "connected");
      if (active) await this.client.reapply(active.device);
    }

    // The radio, arbitrated (K-13). One radio can be an access point or a
    // client, not both, so `radioPlan` decides which and in what order and
    // this loop carries it out. Nothing here is left to NetworkManager's
    // activation rules, which is the whole of the defect K-13 recorded.
    //
    // Its failure is held rather than thrown, and thrown at the end of the
    // render instead. The ordering below is why it has to run first; sharing
    // a failure path with the re-dial was never part of that reasoning, and
    // on a board whose configured network is simply out of range it made the
    // one recovery action M3a exists for unreachable — see K-37.
    let radioFailure: { error: unknown } | undefined;
    if (ifaces.wifi !== null) {
      try {
        await this.settleRadio(config, devices);
      } catch (e) {
        radioFailure = { error: e };
      }
    }

    // Last, and after the radio has been arbitrated. A modem that will not
    // dial must not be able to skip the step that keeps the access point on
    // the air — that step is what R-NET-07 rests on, and this one can throw.
    //
    // *After*, and not *only if it succeeded*. These are two independent
    // subsystems: a Wi-Fi client that cannot associate is a fact about what
    // is in range, and it says nothing about whether the modem should be
    // dialled on the APN the operator has just corrected (R-CEL-09). A board
    // with an out-of-range network configured fails settleRadio on every
    // single render, so a re-dial gated on its success is a re-dial that
    // never happens.
    if (redial.length > 0) {
      try {
        await this.redialModem(redial, devices);
      } catch (e) {
        // The radio's failure is the one that bears on whether this device
        // can still be reached, so it is the one the caller gets. Losing it
        // behind a modem that would not come back up would report the lesser
        // problem and hide the greater.
        if (radioFailure === undefined) throw e;
        this.log(`network: the modem did not come back up either (${(e as Error).message})`);
      }
    }

    // A render that failed still fails. The apply engine's confirmation timer
    // rolls the configuration back on exactly this rejection (R-CFG-03), and
    // a render that returned quietly after the radio would not settle would
    // leave the operator's changes standing on a device that could not carry
    // them.
    if (radioFailure !== undefined) throw radioFailure.error;
  }

  /**
   * Which of the modem's bearer settings NetworkManager reports differently
   * from what the configuration now asks for.
   *
   * Read with `exec` rather than a method of `NmcliClient`, for the reason
   * that method exists: this is one caller wanting a field set nothing else
   * asks for, and the properties differ from render to render.
   *
   * Nothing is asked at all unless the profile has bearer settings — an
   * `appliance` modem has none, and neither does a board with no modem — so
   * this costs nothing on a board it cannot apply to.
   *
   * A read that fails is **not** a difference. It is a question that could
   * not be asked, and answering "changed" to it would cycle a working
   * cellular link on the strength of nothing.
   */
  private async modemChangesNeedingRedial(desired: DesiredProfile[]): Promise<string[]> {
    const profile = desired.find((p) => p.name === MODEM_CONNECTION);
    if (profile === undefined) return [];
    const wanted = redialSettings(profile.settings, profile.clear ?? []);
    if (wanted.length === 0) return [];

    try {
      const out = await this.client.exec([
        "nmcli", "-t", "-f", wanted.map(([name]) => name).join(","),
        "connection", "show", MODEM_CONNECTION,
      ]);
      return bearerChanges(wanted, out);
    } catch (e) {
      this.log(
        `network: could not read what the modem is dialled on (${(e as Error).message}); `
        + "leaving the link alone",
      );
      return [];
    }
  }

  /**
   * Make a changed APN — or username, password or dial string — actually take
   * effect (R-CEL-09).
   *
   * NetworkManager does not re-dial a bearer that is already up because the
   * profile behind it changed. Measured on the board: the APN was changed in
   * `config.yaml`, the profile was rewritten, and the modem stayed on the old
   * bearer with the old address. Correcting a wrong APN is the recovery
   * action the whole of M3a is built around, so a rewrite that changes
   * nothing is the defect and not a nicety.
   *
   * **Only on a real difference, and only while the connection is up.** A
   * render happens for many reasons and reactivating a working cellular link
   * on every one of them is unacceptable on an aircraft; a connection that is
   * not up has nothing to cycle and will read the new settings when
   * `connection.autoconnect` next dials it.
   *
   * The property names are logged and never their values — one of them is
   * `gsm.password`.
   *
   * A failure to come back up is thrown, not swallowed. A modem configuration
   * change is reachability-affecting, so it is already behind the
   * confirmation timer and the rollback engine (R-CFG-03): a failed apply
   * reverts to the settings that were dialling, and this same comparison then
   * sees that difference and dials them again.
   */
  private async redialModem(changed: string[], devices: DeviceInfo[]): Promise<void> {
    if (!devices.some((d) => d.connection === MODEM_CONNECTION)) {
      this.log(
        `network: the modem's ${changed.join(", ")} changed; it will be dialled with the new `
        + "settings when the link next comes up",
      );
      return;
    }
    this.log(
      `network: the modem's ${changed.join(", ")} changed; re-dialling so the new settings `
      + "take effect",
    );
    await this.client.down(MODEM_CONNECTION);
    await this.client.up(MODEM_CONNECTION);
    this.announceRedial("modem");
  }

  /**
   * Say that a path has just been re-dialled, without letting that end a render.
   *
   * Only after the link is back up, so what is announced is a link that has
   * come up rather than one that was asked to. A listener that throws gets a
   * line and nothing more: the re-dial itself succeeded, and reporting it as
   * a failed render would put the operator's corrected APN in front of the
   * confirmation timer and roll it straight back out again (R-CFG-03).
   */
  private announceRedial(path: PathName): void {
    try {
      this.onRedial(path);
    } catch (e) {
      this.log(`network: could not pass on that ${PATH_WORDS[path]} was re-dialled (${(e as Error).message})`);
    }
  }

  /**
   * Rewrite the route metrics for the egress connections this renderer owns,
   * and nothing else.
   *
   * This is R-NET-13's second half — *and traffic moves to the next path that
   * works* — and it is the whole of it. A path that has been stood down gets
   * a metric so high nothing will pick it (`STOOD_DOWN_METRIC`), a path that
   * has recovered gets its configured one back, and the kernel moves the
   * default route accordingly. The daemon calls this on a change of standing
   * and never on a probe, because writing the metric into `desiredProfiles`
   * alone would leave a demotion waiting for the next unrelated render.
   *
   * **Deliberately narrow, and each exclusion is load-bearing.**
   *
   * - **Nothing is created and nothing is deleted.** Only connections
   *   NetworkManager already holds are touched, so this can never be the
   *   thing that removes the profile the fallback watchdog raises (K-16).
   * - **The radio is not touched and `radioPlan` does not run.** A path
   *   stopping working is not a reason to re-arbitrate what the one radio is
   *   doing, and re-issuing `up` on a live access point drops every station
   *   joined to it — including the operator.
   * - **The access point gets no metric.** It is not an egress path; see
   *   `EGRESS_CONNECTIONS`.
   * - **Nothing is taken down.** A stood-down ethernet keeps its carrier,
   *   its address and its on-link route, because an operator may be sitting
   *   on that very cable. `device reapply` re-applies a connection in place
   *   rather than cycling it, which is why it is the mechanism here.
   *
   * Every failure is logged and stepped over rather than thrown. The caller
   * is a probe result folding into standing, not an apply: there is no
   * rollback to trigger and no operator waiting on an answer, and a modem
   * whose metric could not be rewritten must not stop the ethernet's from
   * being.
   */
  async remetric(config: Config): Promise<void> {
    const [connections, devices] = await Promise.all([
      this.client.connections(),
      this.client.devices(),
    ]);
    const present = new Set(connections.map((c) => c.name));

    for (const [name, path] of EGRESS_CONNECTIONS) {
      if (!present.has(name)) continue;
      const metric = metricFor(config, path, this.standing);
      try {
        await this.client.setRouteMetric(name, metric);
      } catch (e) {
        this.log(`network: could not set the route metric on ${name} (${(e as Error).message})`);
        continue;
      }
      // The stored profile now says one thing and the running device another.
      // A device with no active connection has nothing to reapply — it will
      // pick the new metric up when it next comes up — and a reapply that
      // fails is a metric that takes effect later rather than a reason to
      // stop.
      const device = devices.find((d) => d.connection === name)?.device;
      if (device === undefined) continue;
      try {
        await this.client.reapply(device);
      } catch (e) {
        this.log(
          `network: ${name} has a new route metric that ${device} has not taken up yet `
          + `(${(e as Error).message})`,
        );
      }
    }
  }

  /**
   * Carry out the radio plan, and never end a failed move with nothing up.
   *
   * The step that can fail is raising the client, and it is the one an
   * operator is standing in: they submitted these credentials over the access
   * point, and the access point is on the radio being retuned. Two things
   * protect them, in this order.
   *
   * **The client is raised before the access point is taken down.** So a
   * board that never associates has not already thrown away the thing the
   * operator is talking through — the access point is still up, and the
   * failed apply reverts under them rather than stranding them.
   *
   * **And if raising the client fails, the access point is raised again
   * before the failure is reported.** Not because the configuration asks for
   * it — in the case that matters `ap.enabled` is false and it explicitly
   * does not — but because R-NET-07 says the access point comes up regardless
   * of configuration when nothing else carries traffic, and a radio that has
   * just refused to associate is that. Doing it here rather than leaving it
   * to the fallback watchdog is deliberate: the watchdog fires once per
   * daemon start and may have spent its one shot hours ago (K-11), so relying
   * on it would make reachability depend on how long the device had been up.
   *
   * **Measured on a board: `network.client.ssid` named a network that had
   * moved out of range, every apply failed, and the access point came back up
   * exactly as R-NET-07 requires — the device was reachable the entire time.**
   * The apply had, in fact, worked: every profile was written, including a
   * corrected APN. What did not happen is a network appearing that is not on
   * the air, which is a fact about the world and not about the device. The
   * confirmation window exists to catch a change that leaves nothing
   * reachable (`packages/yonder-core/src/apply/reachability.ts`); with the
   * access point up there is nothing for it to catch, and rolling back
   * anyway only destroyed the operator's settings. They read the loss as a
   * power cycle fault, because from the console nothing else had changed
   * (K-37). So once the access point is confirmed up, the failure is logged
   * rather than rethrown: the render completes, the apply stands, and the
   * operator's change is kept (R-NET-15). Only when reachability is *not*
   * established — the access point was down and did not come back up either
   * — is the failure still a failure, and it is rethrown exactly as before.
   */
  private async settleRadio(config: Config, devices: DeviceInfo[]): Promise<void> {
    const active = new Set(devices.map((d) => d.connection).filter((c) => c !== ""));
    const plan = radioPlan(config);
    const movingToClient = wifiMode(config) === "client";

    try {
      for (const step of plan) {
        if (step.action === "up") {
          if (active.has(step.connection)) continue;
          this.log(`network: bringing ${connectionName(step.connection)} up`);
          await this.client.up(step.connection);
          active.add(step.connection);
        } else {
          if (!active.has(step.connection)) continue;
          this.log(`network: taking ${connectionName(step.connection)} down`);
          await this.client.down(step.connection);
          active.delete(step.connection);
        }
      }
    } catch (e) {
      // The ordinary shape of this failure, now that the access point comes
      // down first: the radio has been freed, the client did not associate,
      // and nothing is on the air. What this decides on is reachability, not
      // the shape of nmcli's error — a wrong pre-shared key lands here
      // exactly like an out-of-range SSID, and both get the same treatment
      // (R-NET-15). Nothing below reads `e`'s message.
      if (movingToClient) {
        // The access point was never taken down, so nothing needs rescuing —
        // and it is deliberately not re-`up`ped: re-issuing `up` on a live
        // access point drops every joined station and brings it back,
        // including the operator watching this apply.
        let reachable = active.has(AP_CONNECTION);
        if (!reachable) {
          this.log(
            "network: the wifi client did not come up; raising the access point so the device "
            + "stays reachable",
          );
          try {
            await this.client.up(AP_CONNECTION);
            reachable = true;
          } catch {
            // Nothing further this renderer can do. The original failure —
            // not this one — is what the operator needs to see, so it falls
            // through to the `throw e` below rather than being reported here.
          }
        }
        if (reachable) {
          this.log(
            "network: the wifi client did not come up, but the access point is on the air; "
            + "the device is reachable, so the change has been kept",
          );
          return;
        }
      }
      throw e;
    }
  }
}
