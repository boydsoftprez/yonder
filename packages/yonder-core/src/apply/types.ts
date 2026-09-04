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
  /**
   * Set, and only ever `true`, while a change that moved the Wi-Fi radio is
   * pending — the change R-CFG-11 says the **device** confirms, not the
   * operator. It describes the window, so it goes when the window does.
   *
   * It is here because a console cannot tell the difference otherwise, and
   * the difference decides whether it offers a confirm control at all. The
   * value is not recomputed from the configuration on the way out: it is the
   * same `touchesWifiClient` answer the apply itself was measured by, so the
   * window that was armed, the verifier that was started and the control the
   * banner offers can never disagree about what kind of change this is.
   *
   * **Absent means an ordinary change**, deliberately, and that is the safe
   * direction: a daemon too old to report it, or a path that forgot to set
   * it, leaves the operator able to confirm. Removing that from an ordinary
   * change would cost them a working configuration to a timer.
   */
  movesRadio?: boolean;
  /**
   * Set, with the reason, when the renderer set could not be fully assembled
   * — e.g. daemon/server.ts caught a malformed secrets.yaml out of
   * buildRenderers and is serving with the network renderer missing. Absent
   * when the renderer set is complete. See ApplyEngineOptions.degraded: while
   * this is set, apply() refuses every request rather than "succeeding"
   * against a renderer set that would silently do less than it claims.
   */
  degraded?: string;
}
