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

export type ApplyState = "idle" | "pending" | "confirmed" | "reverting";

export interface ApplyStatus {
  state: ApplyState;
  id?: string;
  expiresAt?: number;
}
