// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { Journal } from "./journal.js";
import { systemClock, type ApplyStatus, type ApplyState, type Clock, type Renderer } from "./types.js";

export interface ApplyEngineOptions {
  configPath: string;
  journalPath: string;
  renderers: Renderer[];
  clock?: Clock;
  timeoutMs?: number;
}

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

  constructor(opts: ApplyEngineOptions) {
    this.configPath = opts.configPath;
    this.renderers = opts.renderers;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.journal = new Journal(opts.journalPath);
  }

  status(): ApplyStatus {
    return { state: this.state, id: this.id, expiresAt: this.expiresAt };
  }

  /** Validate, snapshot, write, render, then start the countdown. */
  async apply(next: unknown): Promise<{ id: string; expiresAt: number }> {
    if (this.state === "pending") {
      throw new ConfigError("an apply is already pending; confirm or wait for it to revert");
    }

    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success) {
      throw new ConfigError("rejected: not a valid configuration", formatIssues(parsed.error));
    }

    const previous = loadConfig(this.configPath);
    const id = randomUUID();

    this.journal.write({ id, previous, startedAt: this.clock.now() });
    saveConfig(this.configPath, parsed.data);

    try {
      await this.renderAll(parsed.data);
    } catch (e) {
      // A renderer failed. Put everything back before returning the error.
      saveConfig(this.configPath, previous);
      await this.renderAll(previous).catch(() => { /* best effort */ });
      this.journal.clear();
      this.reset();
      throw e;
    }

    this.state = "pending";
    this.id = id;
    this.previous = previous;
    this.expiresAt = this.clock.now() + this.timeoutMs;
    this.timer = this.clock.setTimer(this.timeoutMs, () => { void this.revert(); });

    return { id, expiresAt: this.expiresAt };
  }

  /** Operator saw the device still working. Keep the change. */
  confirm(id: string): void {
    if (this.state !== "pending") throw new ConfigError("nothing is pending confirmation");
    if (id !== this.id) throw new ConfigError(`unknown apply id "${id}"`);
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.journal.clear();
    this.state = "confirmed";
    this.timer = undefined;
    this.expiresAt = undefined;
  }

  /** Called at start-up. Reverts an apply the previous process never confirmed. */
  async recover(): Promise<void> {
    const entry = this.journal.read();
    if (entry === null) return;
    saveConfig(this.configPath, entry.previous);
    await this.renderAll(entry.previous).catch(() => { /* best effort */ });
    this.journal.clear();
    this.reset();
  }

  private async revert(): Promise<void> {
    if (this.state !== "pending" || this.previous === undefined) return;
    this.state = "reverting";
    const previous = this.previous;
    saveConfig(this.configPath, previous);
    // Clear the journal and drop back to idle before the render settles: revert()
    // runs fire-and-forget off the countdown timer (nothing awaits this promise),
    // so anyone calling status() must see "idle" as soon as the synchronous part
    // of the rollback — the part that matters for correctness — is done. The
    // render is still issued and still awaited here so callers that DO await
    // revert() (there are none yet, but recover()'s sibling logic sets the
    // precedent) see it complete; it just no longer gates the state machine.
    this.journal.clear();
    this.reset();
    await this.renderAll(previous).catch(() => { /* best effort */ });
  }

  private async renderAll(config: Config): Promise<void> {
    for (const r of this.renderers) await r.render(config);
  }

  private reset(): void {
    this.state = "idle";
    this.id = undefined;
    this.previous = undefined;
    this.timer = undefined;
    this.expiresAt = undefined;
  }
}
