// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../schema/config.js";
import { withoutRetiredKeys, retirementNotice } from "../schema/retired.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { warn } from "../log.js";
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

export class ApplyEngine {
  private readonly configPath: string;
  private readonly renderers: Renderer[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly journal: Journal;
  private readonly degraded?: string;

  private state: ApplyState = "idle";
  private id?: string;
  private previous?: Config;
  private timer?: unknown;
  private expiresAt?: number;
  private lastResult?: ApplyResult;
  /** An in-flight rollback render. A new apply waits for it rather than racing it. */
  private settling?: Promise<void>;

  constructor(opts: ApplyEngineOptions) {
    this.configPath = opts.configPath;
    this.renderers = opts.renderers;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
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
    expiresAt: number;
    /** Set only when true: the rollback target for this apply is the shipped
     *  default, not the operator's actual previous configuration. See the
     *  loadConfig catch below. */
    previousIsDefault?: boolean;
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
      throw new ConfigError("an apply is already pending; confirm or wait for it to revert");
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
      // renderTimeoutMs before giving up again, which is exactly what K-02
      // needs to not happen. The configuration file is already restored
      // above regardless; re-rendering the previous config is only
      // attempted when there is a reasonable chance it can still help.
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

    this.state = "pending";
    this.expiresAt = this.clock.now() + this.timeoutMs;
    this.timer = this.clock.setTimer(this.timeoutMs, () => { void this.revert(); });

    return { id, expiresAt: this.expiresAt, ...(previousIsDefault ? { previousIsDefault } : {}) };
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
    this.lastResult = { id, outcome: "confirmed", at: this.clock.now() };
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
    await this.renderAll(loadConfig(this.configPath));
  }

  private async revert(): Promise<void> {
    if (this.state !== "pending" || this.previous === undefined) return;
    this.state = "reverting";
    const previous = this.previous;
    const id = this.id;
    saveConfig(this.configPath, previous);
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
  }
}
