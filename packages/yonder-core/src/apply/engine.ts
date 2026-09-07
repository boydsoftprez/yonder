// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { affectsReachability } from "./reachability.js";
import { copyFileSync, existsSync } from "node:fs";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../schema/config.js";
import { withoutRetiredKeys, retirementNotice } from "../schema/retired.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { warn } from "../log.js";
// A pure function of Config, imported for one question this engine cannot
// answer on its own: does this change move the Wi-Fi radio between modes?
// Which mode a configuration puts the radio in is the network layer's
// knowledge, and a second copy of that rule here is a copy that would drift
// from the one the renderer actually acts on.
import { wifiMode } from "../net/profiles.js";
import { Journal } from "./journal.js";
import {
  systemClock,
  type ApplyOutcome,
  type ApplyResult,
  type ApplyStatus,
  type ApplyState,
  type Clock,
  type Renderer,
} from "./types.js";

export interface ApplyEngineOptions {
  configPath: string;
  journalPath: string;
  renderers: Renderer[];
  clock?: Clock;
  timeoutMs?: number;
  /**
   * The window for an apply that moves the Wi-Fi radio between access-point
   * and client mode. Longer than `timeoutMs`, because such an apply takes the
   * access point off the air and the operator has to find the device again on
   * a different network before they can confirm anything — see
   * `config.apply.radioTimeout`.
   */
  radioTimeoutMs?: number;
  /**
   * Asked, after a radio-moving apply, whether the device actually got onto
   * the network (R-CFG-11).
   *
   * Injected so the engine keeps knowing nothing about nmcli or ping, and so
   * a test can answer without either. Absent means the old behaviour: the
   * window runs and only a human confirms.
   */
  verifyRadioMove?: (target: Config) => Promise<{ ok: boolean; reason: string }>;
  renderTimeoutMs?: number;
  /**
   * Set when the caller could not fully assemble `renderers` — daemon/
   * server.ts sets this when buildRenderers threw on a malformed
   * secrets.yaml and it is serving with the network renderer missing. While
   * set, apply() refuses outright: rendering against an incomplete renderer
   * set would report success while doing less than the operator was told.
   * GET /status and GET /config are unaffected, so the device stays
   * diagnosable — see status().degraded.
   */
  degraded?: string;
}

/** States in which a new apply may not start. */
const BUSY: readonly ApplyState[] = ["applying", "pending", "reverting"];

/**
 * Distinguishes a render timeout from any other renderer failure. A renderer
 * that just timed out is presumed still wedged, so apply()'s catch block
 * skips the best-effort rollback re-render rather than immediately spending
 * a second full renderTimeoutMs waiting on the same stuck renderer.
 */
class RenderTimeoutError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "RenderTimeoutError";
  }
}

/**
 * Best-effort forensic copy of a config.yaml that could not be loaded, taken
 * immediately before apply()'s first saveConfig() overwrites it with the
 * operator's posted configuration (K-14). Preserving it is not
 * correctness-critical — the apply must proceed either way — so a failure
 * here (permissions, or nothing to copy because the file never existed) is
 * logged and swallowed rather than allowed to turn a repair into a second
 * failure.
 */
function preserveUnloadable(configPath: string, cause: Error): void {
  if (!existsSync(configPath)) return;
  const dest = `${configPath}.invalid`;
  try {
    copyFileSync(configPath, dest);
    warn(`preserved the configuration this daemon could not load as ${dest} (${cause.message}) before replacing it`);
  } catch (e) {
    warn(`could not preserve the unloadable configuration at ${dest}: ${(e as Error).message}`);
  }
}

/**
 * Whether this apply can take the operator's own connection away.
 *
 * This asked whether the *mode* changed — access point to client, or back.
 * That missed the case a board is most often in: already a client, and the
 * operator changing the passphrase of the very network they are connected
 * through. A wrong key deauthenticates them exactly as a failed join does,
 * and because the mode did not change it got the short window and waited for
 * a confirmation from a console that was no longer reachable. Observed: a
 * passphrase change reverted 120 s later with nobody able to say otherwise.
 *
 * So the question is not "did the mode change" but "could this change the
 * network this device is on" — which is any edit to `network.client`, plus
 * the mode change itself.
 *
 * The device can verify all of them the same way (R-CFG-11): hold an address,
 * reach the gateway. There is no case here where a human is better placed to
 * answer than the board is.
 */
function touchesWifiClient(previous: Config, next: Config): boolean {
  if (wifiMode(previous) !== wifiMode(next)) return true;
  return JSON.stringify(previous.network.client) !== JSON.stringify(next.network.client);
}

export class ApplyEngine {
  private readonly configPath: string;
  private readonly renderers: Renderer[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly radioTimeoutMs: number;
  private readonly verifyRadioMove?: (target: Config) => Promise<{ ok: boolean; reason: string }>;
  private readonly renderTimeoutMs: number;
  private readonly journal: Journal;
  private readonly degraded?: string;

  private state: ApplyState = "idle";
  private id?: string;
  private previous?: Config;
  private timer?: unknown;
  private expiresAt?: number;
  /**
   * The confirmation window this pending apply was given, kept so a rollback
   * that could not be written can re-arm the same one rather than guess. See
   * `revert()`.
   */
  private window?: number;
  /**
   * Whether the pending apply moved the Wi-Fi radio (R-CFG-11).
   *
   * Kept rather than recomputed, so `status()` reports the same answer the
   * apply was measured by. The console decides whether to offer a confirm
   * control from this, and a second reading of `touchesWifiClient` against a
   * configuration that has since been written would be a second opinion on a
   * question that already has one.
   */
  private movesRadio = false;
  private lastResult?: ApplyResult;
  /** An in-flight rollback render. A new apply waits for it rather than racing it. */
  private settling?: Promise<void>;

  constructor(opts: ApplyEngineOptions) {
    this.configPath = opts.configPath;
    this.renderers = opts.renderers;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.radioTimeoutMs = opts.radioTimeoutMs ?? 300_000;
    this.verifyRadioMove = opts.verifyRadioMove;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? 60_000;
    this.journal = new Journal(opts.journalPath);
    this.degraded = opts.degraded;
  }

  status(): ApplyStatus {
    return {
      state: this.state,
      id: this.id,
      expiresAt: this.expiresAt,
      lastResult: this.lastResult,
      degraded: this.degraded,
      // Absent, not `false`, for an ordinary change: the field says only that
      // this one is the radio case, and a console reads its absence as the
      // ordinary one either way.
      ...(this.movesRadio ? { movesRadio: true as const } : {}),
    };
  }

  /**
   * Validate, snapshot, write, render, then start the countdown.
   *
   * The snapshot is what a revert or a crash-restart rolls back to. When
   * config.yaml itself cannot be loaded, the shipped default stands in for
   * it (K-14) rather than refusing the apply outright — see the comment at
   * the loadConfig call below — and `previousIsDefault` is set on both the
   * journal entry and the return value so that substitution is never silent.
   */
  async apply(next: unknown): Promise<{
    id: string;
    /**
     * When the change reverts unless confirmed, or **null when there is
     * nothing to confirm** — an apply that cannot cost reachability is kept
     * the moment it is made. A caller that renders a countdown should render
     * none for null rather than treating it as "expires now".
     */
    expiresAt: number | null;
    /** Set only when true: the rollback target for this apply is the shipped
     *  default, not the operator's actual previous configuration. See the
     *  loadConfig catch below. */
    previousIsDefault?: boolean;
    /** Set only when true: this apply moves the Wi-Fi radio, so it got the
     *  longer confirmation window. The console says so before it happens and
     *  has to be able to say so afterwards. */
    movesRadio?: boolean;
  }> {
    // Checked before anything else: rendering against a renderer set the
    // caller told us is incomplete would write config.yaml, report 200, and
    // issue no commands for whatever renderer is missing — a silent success
    // that is worse than the loud failure it replaced. GET /config and
    // GET /status stay reachable either way, so the device is still
    // diagnosable while this is refused.
    if (this.degraded !== undefined) {
      throw new ConfigError(`cannot apply while degraded: ${this.degraded}`);
    }
    if (BUSY.includes(this.state)) {
      // Named by state, because only one of the three can be confirmed. This
      // used to say *pending; confirm or wait for it to revert* for all three,
      // and an operator who read that during the tail of a revert went to
      // confirm a change that no longer existed — K-50, seen on the board.
      throw new ConfigError(
        this.state === "pending"
          ? `an apply (${String(this.id)}) is pending; confirm it, revert it, or wait for it to revert`
          : this.state === "applying"
            ? "an apply is still being carried out; wait for it to finish"
            : "the previous configuration is being put back; wait for it to finish",
      );
    }

    // Given the same tolerance the loader gives a file on disk (R-CFG-09),
    // and from the same enumerated list: a configuration that loads has to be
    // one that applies. Otherwise an operator on a device seeded by an
    // earlier build could read their configuration back, change one field and
    // be refused when they posted it — and the API is the only repair path a
    // console has. A key nobody retired is still rejected below, unchanged.
    const { doc: posted, dropped } = withoutRetiredKeys(next);
    for (const key of dropped) {
      warn(
        `${retirementNotice("the posted configuration", key)}; `
        + `it is dropped rather than written to ${this.configPath}`,
      );
    }

    const parsed = ConfigSchema.safeParse(posted);
    if (!parsed.success) {
      throw new ConfigError("rejected: not a valid configuration", formatIssues(parsed.error));
    }

    // Take the reservation before anything is written and hold it across the
    // renders. The guard above is otherwise decorative: renderers do real I/O
    // — M1's network apply takes seconds — and a second apply arriving inside
    // that window would journal the first apply's unconfirmed configuration as
    // its rollback target and orphan its timer.
    this.state = "applying";

    let previous: Config;
    let previousIsDefault = false;
    try {
      previous = loadConfig(this.configPath);
    } catch (e) {
      // The rollback target would normally be the operator's own previous
      // configuration. Rethrowing here — as this used to — refuses *every*
      // apply against a device whose config.yaml is unloadable, including a
      // perfectly good one, and the error the operator would see describes
      // the file already on disk, not the body they just posted (K-14).
      //
      // The shipped default is safe to stand in for it: reachable by
      // construction (access point enabled, fallback enabled, a valid
      // address and pool), and its ap.psk is a SecretRef resolved through
      // the SecretStore rather than an inline value, so an operator who has
      // already changed the passphrase keeps it rather than reverting to the
      // published one. This only ever lands on config.yaml on the failure or
      // timeout path below, or via recover() after a crash; a confirmed
      // apply clears the journal, so a healthy device never writes it.
      //
      // Not silent: the unreadable file is preserved for later inspection
      // before it is overwritten, and previousIsDefault travels with both
      // the journal entry and this call's return value so a later revert
      // does not restore something the operator never set with no
      // explanation.
      preserveUnloadable(this.configPath, e as Error);
      previous = structuredClone(DEFAULT_CONFIG);
      previousIsDefault = true;
      warn(
        `${this.configPath} could not be loaded (${(e as Error).message}); `
        + "using the shipped default as this apply's rollback target",
      );
    }

    // Let any rollback still rendering finish first, so renderers never see
    // two configurations at once.
    if (this.settling !== undefined) await this.settling;

    const id = randomUUID();
    this.id = id;
    this.previous = previous;
    this.expiresAt = undefined;

    try {
      this.journal.write({ id, previous, previousIsDefault, startedAt: this.clock.now() });
      saveConfig(this.configPath, parsed.data);
      await this.renderAll(parsed.data);
    } catch (e) {
      // Put everything back before returning the error.
      try {
        saveConfig(this.configPath, previous);
      } catch (restoreError) {
        warn(`could not restore ${this.configPath} after a failed apply: ${(restoreError as Error).message}`);
      }
      // A renderer that just timed out is presumed still wedged: retrying it
      // immediately here would hold the reservation for a second full
      // renderTimeoutMs before giving up again, which is the pinned-engine
      // failure the timeout exists to prevent. The configuration file is
      // already restored above regardless; re-rendering the previous config
      // is only attempted when there is a reasonable chance it can still
      // help. What that costs — the file and the running system able to
      // disagree, because nothing undoes what the renderer managed before it
      // stalled — is K-10, which is also what engine.test.ts cites for this
      // branch.
      if (!(e instanceof RenderTimeoutError)) {
        await this.renderAll(previous).catch(() => { /* best effort */ });
      }
      // finish() must run in a finally: a journal that cannot be cleared
      // (e.g. EIO fsyncing the journal directory) must not leave the
      // reservation held forever, or every later apply is refused with a
      // misleading "an apply is already pending". The original failure `e`
      // is what the caller needs to see, so a clear() failure is logged
      // rather than allowed to replace it.
      try {
        this.journal.clear();
      } catch (clearError) {
        warn(`could not clear the apply journal after a failed apply: ${(clearError as Error).message}`);
      } finally {
        this.finish(id, "failed");
      }
      throw e;
    }

    // The longer window, and only for the apply that needs it.
    //
    // A change that does not touch which mode the radio is in leaves the
    // operator's connection exactly where it was, and they confirm in
    // seconds; giving that five minutes only means a change that broke the
    // device sits there for five minutes. A change that *does* move the radio
    // takes the access point off the air under them, and they have to find
    // the device again on a different network before they can confirm
    // anything. Same requirement (R-CFG-03), two very different amounts of
    // work between the apply and the confirmation.
    //
    // Compared on the mode, not on the client settings: changing the
    // passphrase of a network already configured is not a radio move, and
    // neither is renaming the access point.
    const movesRadio = touchesWifiClient(previous, parsed.data);
    const window = movesRadio ? this.radioTimeoutMs : this.timeoutMs;
    if (movesRadio) {
      warn(
        `this apply moves the wifi radio to ${wifiMode(parsed.data)} mode; `
        + `confirm it within ${Math.round(window / 1000)} s or it reverts`,
      );
    }

    /**
     * An apply that cannot cost reachability does not wait to be confirmed.
     *
     * The confirmation window exists for one reason: a configuration change
     * can take the device off the air, and R-NET-07 and R-CFG-03 say the
     * device must come back by itself when it does. Nothing else about it is
     * a virtue — it is a cost paid to make that guarantee.
     *
     * A change that touches nothing reachable has nothing to guarantee. The
     * palette is the worked example and it was broken: choosing day or night
     * applied, went pending, and reverted two minutes later, because R-CFG-11
     * had removed the only control that could confirm it. An operator picked
     * a theme, watched it take, and watched it undo itself.
     *
     * Compared rather than listed: everything that is *not* the interface's
     * own appearance is treated as reachable until proven otherwise, so a
     * field added to the schema later is safe by default rather than silently
     * exempt.
     */
    if (!affectsReachability(previous, parsed.data)) {
      // Same order as confirm(): the journal is cleared first, because that
      // is what makes the change permanent.
      this.journal.clear();
      this.state = "confirmed";
      this.lastResult = { id, outcome: "confirmed", at: this.clock.now() };
      return {
        id,
        expiresAt: null,
        ...(previousIsDefault ? { previousIsDefault } : {}),
      };
    }

    this.state = "pending";
    this.window = window;
    // The same answer the window above was chosen by, kept so `status()` can
    // report it. R-CFG-11 took the confirmation of this change away from the
    // operator, and until now nothing outside this method knew which change
    // it was — so the console offered a confirm control for every one.
    this.movesRadio = movesRadio;
    this.expiresAt = this.clock.now() + window;
    this.timer = this.clock.setTimer(window, () => { this.revertInBackground("the countdown"); });

    // R-CFG-11. The operator cannot confirm a radio move: the console goes
    // off the air with the access point, which is the whole difficulty. So
    // the device establishes for itself whether the join took — an address on
    // the new network and a gateway that answers — and confirms on that
    // evidence.
    //
    // Deliberately not awaited. `apply()` has to return so the browser gets
    // its answer before the radio moves out from under it, and the window is
    // already armed above: if this never resolves, or resolves false, the
    // timer reverts exactly as it did before.
    if (movesRadio && this.verifyRadioMove !== undefined) {
      const applyId = id;
      void this.verifyRadioMove(parsed.data).then(
        (result) => {
          if (this.state !== "pending" || this.id !== applyId) return;
          if (result.ok) {
            warn(`the device confirmed the change itself: ${result.reason}`);
            this.confirm(applyId);
          } else {
            warn(`the change did not take (${result.reason}); reverting now rather than waiting`);
            this.revertInBackground("the device's own check of the change");
          }
        },
        (e: unknown) => {
          // A verifier that threw proves nothing. Leave the window to run.
          warn(`could not establish whether the change took: ${(e as Error).message}`);
        },
      );
    }

    return {
      id,
      expiresAt: this.expiresAt,
      ...(previousIsDefault ? { previousIsDefault } : {}),
      ...(movesRadio ? { movesRadio } : {}),
    };
  }

  /** Operator saw the device still working. Keep the change. */
  confirm(id: string): void {
    if (this.state !== "pending") throw new ConfigError("nothing is pending confirmation");
    if (id !== this.id) throw new ConfigError(`unknown apply id "${id}"`);
    // Clearing the journal is what makes the change permanent, and it comes
    // before disarming the countdown on purpose: if clear() throws (e.g. EIO
    // fsyncing the journal directory), the timer is left armed rather than
    // cleared, so the change still reverts on schedule instead of being
    // stuck "pending" with no rollback timer left to save it.
    this.journal.clear();
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.state = "confirmed";
    this.timer = undefined;
    this.expiresAt = undefined;
    // With the window, because it describes the window: nothing is pending
    // any more, and a flag left set here would still be set when the next
    // apply is kept outright under R-CFG-12 — which never touches the radio
    // and never reaches finish() either.
    this.movesRadio = false;
    this.lastResult = { id, outcome: "confirmed", at: this.clock.now() };
  }

  /**
   * The operator asking for the change to go back **now** (R-UI-15).
   *
   * The countdown already does this; this is the same rollback taken early.
   * It exists because the window is up to five minutes long and an operator
   * who has already decided the change was wrong should not have to sit and
   * watch a timer to get their device back — which is the one situation where
   * they are most likely to reach for a power cycle instead, and a power
   * cycle during an unconfirmed apply is the case `recover()` has to clean up
   * after.
   *
   * Guarded exactly as `confirm()` is, and for the same reason: an id that is
   * not the pending one is a caller acting on a change that has already
   * ended, and rolling back whatever happens to be pending instead would undo
   * something nobody asked about.
   *
   * The countdown timer is disarmed first. `revert()` is idempotent by way of
   * its own state check, so a timer left armed would be harmless — but a
   * timer nobody cancelled is a timer that fires, and one that fires into a
   * `return` is indistinguishable in a log from one that did the work.
   */
  async revertNow(id: string): Promise<void> {
    if (this.state !== "pending") throw new ConfigError("nothing is pending confirmation");
    if (id !== this.id) throw new ConfigError(`unknown apply id "${id}"`);
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    await this.revert();
  }

  /** Called at start-up. Reverts an apply the previous process never confirmed. */
  async recover(): Promise<void> {
    const entry = this.journal.read();
    if (entry === null) return;
    saveConfig(this.configPath, entry.previous);
    await this.renderAll(entry.previous).catch(() => { /* best effort */ });
    this.journal.clear();
    this.finish(entry.id, "reverted");
  }

  /**
   * Render the configuration exactly as it stands, changing nothing.
   *
   * Called once at start-up. renderAll otherwise runs only from apply() and
   * from the two rollback paths, so a device nobody has ever posted an apply
   * to rendered no network state at all — no access point, and therefore no
   * way for anyone to post the apply that would have created one (R-CFG-08,
   * R-NET-01). Nothing is written and no confirmation timer starts: this is
   * the running system being made to match the file, not a change to it.
   */
  async renderCurrent(): Promise<void> {
    // apply() holds the reservation across its renders precisely so two
    // configurations are never in flight at once. A public entry into
    // renderAll must respect the same rule, or a caller could push a stale
    // configuration through a renderer mid-apply.
    if (BUSY.includes(this.state)) {
      throw new ConfigError("an apply is in flight; the configuration is already being rendered");
    }
    const previousState = this.state;
    this.state = "applying";
    try {
      const config = loadConfig(this.configPath);
      const failures: string[] = [];
      // Boot restores an already saved configuration. A modem that is not
      // ready must not prevent telemetry, media, or the console from being
      // initialized. Normal apply and rollback retain their fail-fast path.
      for (const r of this.renderers) {
        try {
          await this.withTimeout(r.render(config), this.renderTimeoutMs, `renderer "${r.name}"`);
        } catch (e) {
          failures.push(`${r.name}: ${(e as Error).message}`);
        }
      }
      if (failures.length > 0) throw new ConfigError(failures.join("; "));
    } finally {
      this.state = previousState;
    }
  }

  /**
   * Roll back off a timer or a verifier — the two callers that do not await.
   *
   * `revert()` can now throw (see the write guard below), and a rejection
   * nothing catches is an unhandled rejection, which under Node's default
   * takes the process down. That used to be the better of two bad answers,
   * because the alternative was a wedged engine. It is not the better answer
   * any more, and it never was in the case that actually produces it: the
   * write fails because the rootfs went read-only, so a restarted daemon's
   * `recover()` writes the same file with the same result and systemd
   * restarts it in a loop — with the console an operator would use to fix it
   * down the whole time (rule 6). The engine stays up, says what happened,
   * and the re-armed countdown tries again.
   */
  private revertInBackground(who: string): void {
    void this.revert().catch((e: unknown) => {
      warn(`${who} could not put the previous configuration back: ${(e as Error).message}`);
    });
  }

  /**
   * Put the countdown back, for a rollback that could not be completed.
   *
   * The same window this apply was given, measured again from now. A shorter
   * one would be arithmetic about somebody else's disk; a longer one would
   * leave a change nobody confirmed in force for longer than they were told.
   */
  private rearm(): void {
    const window = this.window ?? this.timeoutMs;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.expiresAt = this.clock.now() + window;
    this.timer = this.clock.setTimer(window, () => { this.revertInBackground("the countdown"); });
  }

  private async revert(): Promise<void> {
    if (this.state !== "pending" || this.previous === undefined) return;
    this.state = "reverting";
    const previous = this.previous;
    const id = this.id;
    // Guarded, and it is the one write in this class that must never be
    // allowed to fail silently. `saveConfig` throws when the file cannot be
    // written — the ordinary way a Pi's rootfs fails is the kernel remounting
    // it read-only after an I/O error — and without this the engine was left
    // in `"reverting"`, which is in BUSY: every later apply refused, both
    // `confirm()` and `revertNow()` answering "nothing is pending", and, when
    // this was reached through `revertNow`, the countdown already cleared. An
    // unconfirmed change in force with no rollback armed and no way to ask
    // for one is the exact state R-CFG-03 exists to make impossible.
    //
    // So the engine goes back to where it was: pending, armed, and saying so.
    // Nothing has been rolled back and nothing has been kept, which is the
    // truth. The journal is untouched — `clear()` is below this — so a
    // restart still rolls the change back as well.
    try {
      saveConfig(this.configPath, previous);
    } catch (e) {
      this.state = "pending";
      this.rearm();
      warn(
        `could not put the previous configuration back (${(e as Error).message}); `
        + `the change is still pending and reverts again in ${Math.round((this.window ?? this.timeoutMs) / 1000)} s`,
      );
      throw e;
    }
    // Clear the journal and drop back to idle before the render settles: revert()
    // runs fire-and-forget off the countdown timer (nothing awaits this promise),
    // so anyone calling status() must see the terminal state as soon as the
    // synchronous part of the rollback — the part that matters for correctness —
    // is done. The render is still issued and still awaited here, and a new
    // apply waits on `settling` before touching anything, so it cannot
    // interleave with this one.
    //
    // clear() is guarded: this runs fire-and-forget (`void this.revert()`
    // off the countdown timer), so a throw here would otherwise be an
    // unhandled rejection that takes the whole daemon down. The rollback
    // above already happened, which is the part that matters; a journal
    // that cannot be cleared is logged and left for the next clear() to
    // retry, and finish() still runs so the engine is not left "reverting"
    // forever, refusing every later apply.
    try {
      this.journal.clear();
    } catch (e) {
      warn(`could not clear the apply journal after a revert: ${(e as Error).message}`);
    }
    this.finish(id, "reverted");
    const settling = this.renderAll(previous).catch(() => { /* best effort */ });
    this.settling = settling;
    await settling;
    if (this.settling === settling) this.settling = undefined;
  }

  /**
   * A renderer that throws is a failure we already handle. A renderer that
   * never returns would otherwise hold the reservation for ever, refusing
   * every later apply with "already pending". Time comes from the injected
   * clock so this is testable without waiting.
   */
  private withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimer(ms, () => {
        if (settled) return;
        settled = true;
        reject(new RenderTimeoutError(`${what} timed out after ${ms} ms`));
      });
      work.then(
        (value) => { if (!settled) { settled = true; this.clock.clearTimer(timer); resolve(value); } },
        (err) => { if (!settled) { settled = true; this.clock.clearTimer(timer); reject(err); } },
      );
    });
  }

  private async renderAll(config: Config): Promise<void> {
    for (const r of this.renderers) {
      await this.withTimeout(r.render(config), this.renderTimeoutMs, `renderer "${r.name}"`);
    }
  }

  /** Return to rest, recording how the apply ended. */
  private finish(id: string | undefined, outcome: ApplyOutcome): void {
    if (id !== undefined) this.lastResult = { id, outcome, at: this.clock.now() };
    this.state = "idle";
    this.id = undefined;
    this.previous = undefined;
    this.timer = undefined;
    this.expiresAt = undefined;
    this.window = undefined;
    this.movesRadio = false;
  }
}
