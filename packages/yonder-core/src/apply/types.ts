// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/** Turns config into system state. M1 supplies the network renderer. */
export interface Renderer {
  readonly name: string;
  render(config: Config): Promise<void>;
}

/** Injected so tests drive time by hand and never wait on the wall clock. */
export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * `applying` is the reservation held from the moment the journal is written
 * until the confirmation timer starts. It exists so a second apply arriving
 * while renderers are still working is refused rather than interleaved.
 */
export type ApplyState = "idle" | "applying" | "pending" | "confirmed" | "reverting";

export type ApplyOutcome = "confirmed" | "reverted" | "failed";

/**
 * How the last apply ended. Without it an operator whose change was rolled
 * back sees the same `idle` as an operator whose change never happened — and
 * the rollback is precisely the case they need to be told about, because it
 * may have happened while they were locked out.
 */
export interface ApplyResult {
  id: string;
  outcome: ApplyOutcome;
  at: number;
}

export interface ApplyStatus {
  state: ApplyState;
  id?: string;
  expiresAt?: number;
  lastResult?: ApplyResult;
}
