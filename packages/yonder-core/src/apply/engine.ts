// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { ConfigSchema, type Config } from "../schema/config.js";
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
}

/** States in which a new apply may not start. */
const BUSY: readonly ApplyState[] = ["applying", "pending", "reverting"];

export class ApplyEngine {
  private readonly configPath: string;
  private readonly renderers: Renderer[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly journal: Journal;

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
    this.journal = new Journal(opts.journalPath);
  }

  status(): ApplyStatus {
    return { state: this.state, id: this.id, expiresAt: this.expiresAt, lastResult: this.lastResult };
  }

  /** Validate, snapshot, write, render, then start the countdown. */
  async apply(next: unknown): Promise<{ id: string; expiresAt: number }> {
    if (BUSY.includes(this.state)) {
      throw new ConfigError("an apply is already pending; confirm or wait for it to revert");
    }

    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success) {
      throw new ConfigError("rejected: not a valid configuration", formatIssues(parsed.error));
    }

    // Take the reservation before anything is written and hold it across the
    // renders. The guard above is otherwise decorative: renderers do real I/O
    // — M1's network apply takes seconds — and a second apply arriving inside
    // that window would journal the first apply's unconfirmed configuration as
    // its rollback target and orphan its timer.
    const resume = this.state;
    this.state = "applying";

    let previous: Config;
    try {
      previous = loadConfig(this.configPath);
    } catch (e) {
      this.state = resume;
      throw e;
    }

    // Let any rollback still rendering finish first, so renderers never see
    // two configurations at once.
    if (this.settling !== undefined) await this.settling;

    const id = randomUUID();
    this.id = id;
    this.previous = previous;
    this.expiresAt = undefined;

    try {
      this.journal.write({ id, previous, startedAt: this.clock.now() });
      saveConfig(this.configPath, parsed.data);
      await this.renderAll(parsed.data);
    } catch (e) {
      // Put everything back before returning the error.
      try {
        saveConfig(this.configPath, previous);
      } catch (restoreError) {
        warn(`could not restore ${this.configPath} after a failed apply: ${(restoreError as Error).message}`);
      }
      await this.renderAll(previous).catch(() => { /* best effort */ });
      this.journal.clear();
      this.finish(id, "failed");
      throw e;
    }

    this.state = "pending";
    this.expiresAt = this.clock.now() + this.timeoutMs;
    this.timer = this.clock.setTimer(this.timeoutMs, () => { void this.revert(); });

    return { id, expiresAt: this.expiresAt };
  }

  /** Operator saw the device still working. Keep the change. */
  confirm(id: string): void {
    if (this.state !== "pending") throw new ConfigError("nothing is pending confirmation");
    if (id !== this.id) throw new ConfigError(`unknown apply id "${id}"`);
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    // Clearing the journal is what makes the change permanent. Leave it and
    // the next start reverts a change the operator explicitly kept.
    this.journal.clear();
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
    this.journal.clear();
    this.finish(id, "reverted");
    const settling = this.renderAll(previous).catch(() => { /* best effort */ });
    this.settling = settling;
    await settling;
    if (this.settling === settling) this.settling = undefined;
  }

  private async renderAll(config: Config): Promise<void> {
    for (const r of this.renderers) await r.render(config);
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
