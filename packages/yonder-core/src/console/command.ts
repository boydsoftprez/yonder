// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The command-state language, defined once (R-UI-05, R-CMD-09, ADR-0005).
 *
 * ADR-0005 accepted two UI idioms in one product — stock Dashboard widgets for
 * forms, hand-written Vue for the cockpit — and named the consequence: *the
 * command-state language must be built once and shared*, or a control will
 * mean one thing on the network page and another in the cockpit. It also said
 * when: in M1, "before there are many controls to retrofit". This is that
 * module, and it is deliberately the first thing either contrib package
 * imports.
 *
 * R-UI-05 is the requirement underneath: **show the operator when a control
 * has taken effect, not merely that it was sent.** Four states, and the
 * distinctions are the point:
 *
 * - `idle` — nothing has been asked for. Not the same as "it worked".
 * - `pending` — the device has accepted it and it is not yet permanent. On
 *   this device that is a literal state with a deadline: an apply reverts
 *   unless it is confirmed (R-CFG-03), so `expiresAt` travels with it.
 * - `confirmed` — it took effect and it is going to stay.
 * - `rejected` — it did not happen. **Including the case where the console
 *   could not find out**, which is the one that matters: a node whose daemon
 *   call fails must say so rather than emitting nothing, because an operator
 *   looking at a control that did something unknown is worse off than one
 *   looking at a control that says it failed.
 *
 * Everything here is pure. It is data a page renders, not a page.
 */

export type CommandState = "idle" | "pending" | "confirmed" | "rejected";

export interface CommandStatus {
  state: CommandState;
  /** For the operator, in Yonder's own words. Never a subprocess message. */
  message: string;
  /** From the injected clock, so a page can age it and a test can drive it. */
  at: number;
  /** The apply this refers to, when there is one. */
  id?: string;
  /** When a pending change reverts if nobody confirms it. Epoch milliseconds. */
  expiresAt?: number;
  /**
   * Set when this pending change moved the Wi-Fi radio, which is the one that
   * takes the access point away from under the operator. A page has to say so
   * differently, because the operator has to go and find the device again
   * before they can confirm anything.
   */
  movesRadio?: boolean;
}

/** How a state looks. One mapping, so a control reads the same everywhere. */
export interface CommandPresentation {
  /** The word on the control. */
  label: string;
  /**
   * The visual register, not a colour. Pages own colours — a day theme and a
   * night theme have different ones for the same tone (R-UI-07) — and a
   * colour named here would be a colour that could only be right in one of
   * them.
   */
  tone: "neutral" | "waiting" | "good" | "bad";
}

const PRESENTATION: Record<CommandState, CommandPresentation> = {
  idle: { label: "Ready", tone: "neutral" },
  pending: { label: "In progress", tone: "waiting" },
  confirmed: { label: "Confirmed", tone: "good" },
  rejected: { label: "Not applied", tone: "bad" },
};

export function presentation(state: CommandState): CommandPresentation {
  return PRESENTATION[state];
}

export interface CommandOptions {
  at: number;
  id?: string;
  expiresAt?: number;
  movesRadio?: boolean;
}

/** Nothing has been asked for yet. */
export function idle(at: number, message = "Ready"): CommandStatus {
  return { state: "idle", message, at };
}

/** Accepted, not yet permanent, and it will revert on its own if it is not confirmed. */
export function pending(message: string, opts: CommandOptions): CommandStatus {
  return {
    state: "pending",
    message,
    at: opts.at,
    ...(opts.id === undefined ? {} : { id: opts.id }),
    ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
    ...(opts.movesRadio === true ? { movesRadio: true } : {}),
  };
}

/** It took effect and it is staying. */
export function confirmed(message: string, opts: CommandOptions): CommandStatus {
  return {
    state: "confirmed",
    message,
    at: opts.at,
    ...(opts.id === undefined ? {} : { id: opts.id }),
  };
}

/**
 * It did not happen — or the console could not find out whether it did.
 *
 * Those are the same answer to the operator and they must produce the same
 * control state. "The daemon did not reply" is not a reason to show nothing;
 * showing nothing is how a control ends up having done something unknown.
 */
export function rejected(message: string, opts: CommandOptions): CommandStatus {
  return {
    state: "rejected",
    message,
    at: opts.at,
    ...(opts.id === undefined ? {} : { id: opts.id }),
  };
}

/**
 * How long a pending change has left, in whole seconds, or null.
 *
 * Null rather than a negative number for one that has already expired: a page
 * counting down to "-14 s" is a page showing a number that means nothing.
 */
export function secondsRemaining(status: CommandStatus, now: number): number | null {
  if (status.state !== "pending" || status.expiresAt === undefined) return null;
  const left = Math.ceil((status.expiresAt - now) / 1000);
  return left > 0 ? left : null;
}
