// SPDX-License-Identifier: GPL-3.0-or-later
import { DaemonClient, type DaemonReply } from "./client.js";
import {
  countdown, idle, rejected, pending, confirmed, type CommandStatus,
} from "./command.js";

/**
 * Everything a Node-RED node in this project is allowed to decide.
 *
 * Which is to say: nothing, once this module exists. CLAUDE.md rule 2 keeps
 * logic out of `flows.json`, and the same argument applies one layer up — a
 * `.js` file inside a contrib package is reviewable, but it is exercised only
 * through `node-red-node-test-helper` and a running runtime, which is a
 * slower and coarser test than a function. So the contrib nodes are adapters:
 * they take a message in, call one of these, and send what comes back.
 *
 * Everything here is pure or takes an injected client and an injected `now`.
 */

/** How often a page may poll (R-UI-06). */
export const MIN_POLL_MS = 2_000;
export const DEFAULT_POLL_MS = 5_000;

/**
 * A poll interval, floored.
 *
 * R-UI-06 says the console has to work on a link with hundreds of
 * milliseconds of latency. A one-second poll on such a link is a request
 * still in flight when the next one is issued, and the floor is enforced here
 * rather than trusted to whoever edits `flows.json` — the flows are wiring,
 * and a rule that only exists in wiring is a rule an operator can turn off in
 * the flow editor without knowing they have.
 */
export function pollIntervalMs(seconds: unknown): number {
  const value = typeof seconds === "string" ? Number(seconds) : seconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.round(value * 1000));
}

/** The default the console is installed with. Overridden by `settings.js`. */
export const DEFAULT_SOCKET_PATH = "/run/yonder/core.sock";

/**
 * Where the daemon is, from Node-RED's settings.
 *
 * `settings.js` is generated from the configuration and carries the socket
 * path, so no node holds one and `flows.json` carries no deployment detail at
 * all. A settings object without it falls back to the installed default
 * rather than throwing: a node that cannot construct itself takes the whole
 * flow down, and the console is what an operator would be using to fix it.
 */
export function socketPathFrom(settings: unknown): string {
  const yonder = (settings as { yonder?: unknown } | null | undefined)?.yonder;
  const path = (yonder as { socketPath?: unknown } | null | undefined)?.socketPath;
  return typeof path === "string" && path !== "" ? path : DEFAULT_SOCKET_PATH;
}

/** A client for the socket named in these settings. */
export function clientFor(settings: unknown): DaemonClient {
  return new DaemonClient({ socketPath: socketPathFrom(settings) });
}

/** What a read produced, or Yonder's own words about why it did not. */
export type Fetched<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * The daemon's answer to a read, as either a value or a message.
 *
 * The message is either the daemon's own `error` field — which is written for
 * an operator and never carries a subprocess's output, because
 * `daemon/routes.ts` catches that case into a generic 500 — or this module's
 * wording for a daemon that did not answer at all. Nothing from a transport
 * exception reaches it: `(e as Error).message` there is a socket path and an
 * errno, which is detail for a journal and not for a page.
 */
export function fetched(reply: DaemonReply): Fetched {
  if (!reply.ok) {
    return {
      ok: false,
      message: "the device's configuration service is not answering; try again in a moment",
    };
  }
  if (reply.status === 200) return { ok: true, value: reply.body };
  if (reply.status === 403) {
    return { ok: false, message: "this device has no administrator password set yet" };
  }
  const error = (reply.body as { error?: unknown } | undefined)?.error;
  return {
    ok: false,
    message: typeof error === "string" && error !== ""
      ? error
      : `the device refused the request (${reply.status})`,
  };
}

/**
 * `POST /apply`'s answer, in the command-state language.
 *
 * A successful apply is **pending**, never confirmed: the change is in force
 * and will be undone unless something confirms it. What differs is *who*.
 *
 * A change that moves the Wi-Fi client is confirmed by the device itself
 * (R-CFG-11) — it waits for an address and pings the gateway — so the
 * operator is told what is happening and asked for nothing. Anything else is
 * still theirs to confirm.
 *
 * And a change that cannot cost reachability is not pending at all: R-CFG-12
 * keeps it rather than holding it, so the daemon answers `expiresAt: null`,
 * having already confirmed it. Telling that operator it reverts on its own is
 * the same defect from the other side — a mesh join is exempt (R-VPN-07), the
 * ZeroTier tab has no confirm control because none is needed, and an operator
 * sent looking for one reasonably concludes the join did not take.
 *
 * Saying "confirm it to keep it" for a change nobody can confirm, from a
 * console that is about to go off the air, is worse than saying nothing: it
 * leaves an operator hunting for a button that is not there.
 */
export function applyStatus(reply: DaemonReply, now: number): CommandStatus {
  const result = fetched(reply);
  if (!result.ok) return rejected(result.message, { at: now });

  const body = result.value as {
    id?: unknown; expiresAt?: unknown; movesRadio?: unknown;
  } | undefined;
  const id = typeof body?.id === "string" ? body.id : undefined;
  if (id === undefined) {
    // A 200 from something that is not this daemon. Reporting it as pending
    // would leave a control waiting to confirm an apply that does not exist.
    return rejected(
      "the device answered with something this console did not understand; "
      + "the change may not have been applied",
      { at: now },
    );
  }
  // `null`, not merely absent: the daemon says so explicitly for an apply it
  // has already confirmed, and an answer that simply omits the field is one
  // this console does not understand well enough to call finished.
  if (body?.expiresAt === null) {
    return confirmed("Applied, and kept. There is nothing to confirm.", { at: now, id });
  }

  const movesRadio = body?.movesRadio === true;
  return pending(
    movesRadio
      ? "Joining. This page is about to go away. The device checks the network itself and "
        + "keeps the change if it works — find it again at yonder.local:3000 or in your "
        + "router's client list. If it does not work, the access point comes back."
      : "Applied. Confirm it to keep it, or it reverts on its own.",
    {
      at: now,
      id,
      ...(typeof body?.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}),
      ...(movesRadio ? { movesRadio: true } : {}),
    },
  );
}

/** `POST /confirm`'s answer. This one really is done. */
export function confirmStatus(reply: DaemonReply, now: number, id: string): CommandStatus {
  const result = fetched(reply);
  if (!result.ok) return rejected(result.message, { at: now, id });
  return confirmed("Confirmed. The change is permanent.", { at: now, id });
}

/**
 * A read that failed, as a command status.
 *
 * A node whose daemon call fails emits this rather than nothing. An operator
 * looking at a panel that is simply blank cannot tell "there is nothing to
 * show" from "this never loaded", and the second is the one they need to act
 * on (R-UI-05).
 */
export function readFailure(message: string, now: number): CommandStatus {
  return rejected(message, { at: now });
}

/**
 * What a page needs to draw a change that has not been confirmed (R-UI-15).
 *
 * Everything here is a string a widget binds directly. In particular the
 * countdown is **already words**: a clock ticking inside `flows.json` would be
 * arithmetic in wiring, which is the thing CLAUDE.md rule 2 exists to stop,
 * and it would be arithmetic on the one number that decides whether an
 * operator still has a device.
 */
export interface PendingChange {
  /** Authoritative engine phase, including work before the confirmation window. */
  engineState?: string;
  observedAt?: number;
  /**
   * Whether a change is in force and unconfirmed.
   *
   * The banner is present only while this is true. A panel that is always
   * there saying "nothing pending" is noise on a page an operator glances at,
   * and noise on that page is what makes the one time it matters invisible.
   */
  pending: boolean;
  /** The apply to confirm or revert. Empty when there is nothing pending. */
  id: string;
  /** The line that names the change. Empty when there is nothing pending. */
  what: string;
  /** Why the revert is on the operator's side. Empty when nothing is pending. */
  why: string;
  /**
   * The keys the rail offers for **this** change, in order.
   *
   * A soft-key rail's own configuration is static, and for most of this
   * console that is right — a page's actions do not depend on what the device
   * is doing. This one does: R-CFG-11 takes the confirmation of a radio move
   * away from the operator, so the banner over that change must not offer a
   * control to do it. The decision is made here, where it can be tested and
   * where the words beside it are written, and never in the flows.
   *
   * A rail handed no list falls back to the one in its own configuration,
   * which offers both keys. That is the direction to fail in: an operator who
   * cannot confirm an ordinary change loses a working configuration to a
   * timer.
   */
  keys: readonly PendingKey[];
}

/**
 * One key of the banner's rail.
 *
 * The same three fields `ui-yonder-softkeys` reads out of its editor form,
 * because it is the same rail — this is that configuration for a state the
 * editor cannot know about, not a second kind of key.
 */
export interface PendingKey {
  label: string;
  action: string;
  /**
   * `warn` is the irreversible tone, and CONFIRM wears it while REVERT NOW
   * does not. That is the opposite of most interfaces and it is deliberate:
   * confirming keeps a change nothing will take back, and reverting is the
   * direction that gets an operator back in.
   */
  tone: "plain" | "act" | "warn";
}

/**
 * Keep the change. Absent for a radio move — the device does it (R-CFG-11).
 *
 * Frozen, as every list below is: these are module constants that travel into
 * a payload on every poll, and one caller mutating what it was handed would
 * change what every surface of the console offers, for ever, silently.
 */
export const CONFIRM_KEY: PendingKey = Object.freeze({ label: "KEEP", action: "confirm", tone: "warn" });

/**
 * Put the previous configuration back now.
 *
 * On every pending change, including the one nobody can confirm. Deciding
 * that a change is not wanted is still a real thing to want, and for a radio
 * move this is the operator's only control over the apply — so it is the last
 * key that may ever be taken away.
 */
export const REVERT_KEY: PendingKey = Object.freeze({ label: "REVERT", action: "revert", tone: "act" });

/** An ordinary change: the operator's to keep or to undo. */
export const PENDING_KEYS: readonly PendingKey[] = Object.freeze([CONFIRM_KEY, REVERT_KEY]);

/** A change that moved the radio: the device confirms, the operator may revert. */
export const PENDING_KEYS_RADIO: readonly PendingKey[] = Object.freeze([REVERT_KEY]);

/**
 * The sentence under the countdown, and the reason this task exists.
 *
 * It does **not** threaten the operator with the revert. The revert is the
 * thing that rescues them — it is the whole of what makes this device
 * unbrickable (R-CFG-03) — and an interface that presents it as a punishment
 * for inaction teaches an operator to confirm reflexively, which is exactly
 * the habit that turns a wrong change into a device nobody can reach.
 */
export const PENDING_WHY =
  "Choose Keep to save these settings or Revert to restore the previous settings. "
  + "If you do neither, the device restores the previous settings automatically.";

/** What the banner says a change is, when the daemon has not said which. */
export const PENDING_WHAT =
  "A configuration change is in force on this device and has not been confirmed.";

/**
 * The same line for a change that moved the Wi-Fi radio (R-CFG-11).
 *
 * It says who is confirming, because that is the fact that explains the
 * missing key. A countdown with nothing to press and no explanation reads as
 * a console that has lost a control, which is worse than the control being
 * there.
 */
export const PENDING_WHAT_RADIO =
  "A change that moved the Wi-Fi radio is in force on this device, and the "
  + "device is confirming it for itself.";

/**
 * And the sentence under it (R-CFG-11).
 *
 * Reassuring rather than alarming, because the behaviour it describes is the
 * one that protects the operator: the device holds an address on the new
 * network and reaches its gateway, or it puts the previous configuration back
 * without being asked. What is left for the operator is the decision that
 * they do not want the change — so the revert is named, and nothing sends
 * them looking for a confirm control that is deliberately not there.
 */
export const PENDING_WHY_RADIO =
  "There is nothing for you to confirm: the device keeps the change once it "
  + "holds an address on the new network, and puts the previous configuration "
  + "back by itself if it does not. Revert it now if you have decided against it.";

/**
 * `GET /status`, as the banner on every page reads it (R-UI-15).
 *
 * The apply engine has tracked the pending change and its deadline all along.
 * What was missing was anywhere to see it except the page the change was made
 * on: make a change on the Network page, walk to Status, and nothing said the
 * configuration reverts in ninety seconds unless somebody confirms it.
 *
 * **A change that moved the Wi-Fi radio is not the operator's to confirm**
 * (R-CFG-11). The banner is the same banner — it appears, it counts down, and
 * it offers `REVERT NOW` — but the rail carries no `CONFIRM`, and both lines
 * of prose say instead that the device is establishing for itself whether the
 * change worked. An operator pressing CONFIRM there is on a network that only
 * exists because the change already took, so the press is either pointless or
 * made by somebody who cannot see that the device is already fine; and it
 * ends the device's own verification early, which is the judgement R-CFG-11
 * took away. The daemon says which kind of change it is holding — it is the
 * only thing that knows — and this reads it rather than working it out again.
 *
 * **A read that fails leaves the banner down.** That is the one place this
 * module departs from "never a silent nothing", and deliberately: every field
 * the banner draws — the countdown, the id both of its keys need — is
 * unknown when the daemon does not answer, so what it could raise is an alarm
 * with no time on it and two controls that would fail. The failure still
 * travels on `msg.yonder`, so the node says so in its own status, and the
 * panels beside it on that page already report a daemon that has gone quiet.
 */
export function pendingChange(
  reply: DaemonReply,
  now: number,
): { payload: PendingChange; yonder: CommandStatus } {
  // The keys of a banner that is not up are the ordinary pair, not none: the
  // rail keeps whatever it was last given, and "nothing pending" is not a
  // reason to have taken a control off it.
  const nothing: PendingChange = {
    pending: false, id: "", what: "", why: "", keys: PENDING_KEYS,
  };
  const result = fetched(reply);
  if (!result.ok) return { payload: nothing, yonder: readFailure(result.message, now) };

  const body = result.value as {
    state?: unknown; id?: unknown; expiresAt?: unknown; movesRadio?: unknown;
  } | undefined;
  if (body?.state !== "pending") return { payload: { ...nothing, engineState: typeof body?.state === 'string' ? body.state : 'unknown', observedAt: now }, yonder: idle(now) };

  // `=== true`, so anything else is an ordinary change: a daemon too old to
  // report the field, or one that reported something this console does not
  // understand, leaves CONFIRM on the rail. Taking an operator's confirmation
  // away on a guess costs them a working configuration to a timer; leaving it
  // there when it was not needed costs a key that does nothing.
  const movesRadio = body.movesRadio === true;
  const status = pending("", {
    at: now,
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    ...(typeof body.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}),
    ...(movesRadio ? { movesRadio: true } : {}),
  });
  const left = countdown(status, now);
  return {
    payload: {
      pending: true,
      engineState: 'pending', observedAt: now,
      id: typeof body.id === "string" ? body.id : "",
      // What the daemon knows, and no more. `GET /status` carries an apply
      // state, an id, a deadline and whether the change moved the radio; it
      // does not say which settings moved, and a line inventing one would be
      // the console's only sentence about this that nothing on the device
      // could check.
      what: movesRadio ? PENDING_WHAT_RADIO : PENDING_WHAT,
      why: movesRadio ? PENDING_WHY_RADIO : PENDING_WHY,
      // **The decision R-CFG-11 makes, made once, here.** The rail draws what
      // it is given; a `switch` in the flows choosing between two rails would
      // be the same judgement written where it cannot be tested.
      keys: movesRadio ? PENDING_KEYS_RADIO : PENDING_KEYS,
    },
    // The lamp's caption. `Reverting now` rather than `0:00` for a window that
    // has run out: the rollback is already happening, and a countdown frozen
    // at zero reads as a page that has stopped updating.
    yonder: { ...status, message: left === null ? "Reverting now" : `Reverts in ${left}` },
  };
}

/**
 * What the `PASSPHRASE` cell says once the operator has set their own.
 *
 * Words, not the em dash a data bar draws for a key it has not been given.
 * The em dash means *not known*, and this device knows perfectly well what
 * its access-point passphrase is — it is declining to print it (R-SEC-10).
 * Those are different answers and only one of them is honest.
 *
 * It also does not send anybody looking. There is nowhere to look:
 * `secrets.yaml` is `0600 root` and the console runs unprivileged, so it
 * could not read the value even if this said to (ADR-0008).
 */
export const AP_PASSPHRASE_CHANGED = "changed — the one you set";

/**
 * What the `PASSPHRASE` cell says when this device cannot tell (R-UI-18).
 *
 * The daemon answers with no passphrase at all when its secret store could
 * not be read, which is a malformed or unreadable `secrets.yaml` — and that
 * is exactly the sort of device this panel is on the page for. Neither of the
 * other two answers is honest there: the published default is a passphrase
 * that will not work on any device whose operator changed it, and "changed"
 * asserts a thing nothing has established.
 *
 * So the cell says what is true, and the note below carries the part that is
 * still useful. Nothing here sends anybody looking for the value: there is
 * nowhere to look (ADR-0008).
 */
export const AP_PASSPHRASE_UNKNOWN = "not known — this device cannot read it";

/**
 * The sentence added to the note in that one state, and only in it.
 *
 * A panel that says "not known" and stops is honest and useless. The
 * published default is a fact about this project rather than a claim about
 * this device, so it can be said without asserting anything the device has
 * not established — and it is what gets an operator who never changed it back
 * in. The value itself is not repeated here; the README is where it is
 * published, and a second copy in a string is a second copy to go stale.
 */
export const AP_PASSPHRASE_UNKNOWN_NOTE =
  " This device cannot read its own secrets, so it cannot say which "
  + "passphrase its access point is on. If you have never changed it, it is "
  + "the published default this project ships with.";

/**
 * The line under the bar.
 *
 * No scheme, no port and no URL in it, deliberately. The console's port is
 * configuration (`ui.port`), so a sentence with `:3000` in it is wrong on any
 * device somebody has moved it on — and the operator reading this is looking
 * at the console right now, with its address in front of them. What they do
 * not have is the two names that still work once the network they are on has
 * gone, which is what the bar above carries.
 */
export const WAY_BACK_IN_NOTE =
  "Join that network from a phone or a laptop and open this console at either "
  + "address above, on the port you are using now. Worth photographing before "
  + "you change anything: it is what gets you back in when this page stops "
  + "answering.";

/** The four cells of the way back in, plus the line beneath them. */
export interface WayBackInView {
  /** The access point to join. */
  join: string;
  /**
   * The published passphrase, `AP_PASSPHRASE_CHANGED`, or
   * `AP_PASSPHRASE_UNKNOWN`. Never the operator's.
   */
  passphrase: string;
  /** The access point's address. */
  at: string;
  /** The name the device answers to. */
  or: string;
  /**
   * WAY_BACK_IN_NOTE, so the flow binds a value rather than carrying prose —
   * plus `AP_PASSPHRASE_UNKNOWN_NOTE` in the one state that needs it.
   */
  note: string;
}

/**
 * `GET /status`'s `wayBackIn`, as the panel at the bottom of Status reads it
 * (R-UI-18).
 *
 * **The decision about the passphrase is not made here.** The daemon has
 * already made it — `publishableApPassphrase` in `net/profiles.ts` — and what
 * arrives is the published value, `null`, or nothing at all. This turns the
 * second and third into words. A console that compared anything itself would
 * be a second place the rule lives, and the second copy is the one that stops
 * matching.
 *
 * **A failed read sends nothing, and that is deliberate.** Every other node
 * in this console raises a rejected state on a failed read, because a stale
 * *reading* is a lie. There is no reading here. Which network to join and
 * what address to open does not stop being true because the daemon missed a
 * poll — and this is the one panel on the page whose whole purpose is to
 * still be useful when things have gone wrong, so blanking it at the first
 * sign of trouble would be exactly backwards. The failure still travels on
 * `msg.yonder`, so the node says so in its own status and the panels beside
 * it already report a daemon that has gone quiet.
 */
export function wayBackInView(
  reply: DaemonReply,
  now: number,
): { payload: WayBackInView | undefined; yonder: CommandStatus } {
  const result = fetched(reply);
  if (!result.ok) return { payload: undefined, yonder: readFailure(result.message, now) };

  const back = (result.value as { wayBackIn?: unknown } | undefined)?.wayBackIn as {
    ssid?: unknown; address?: unknown; hostname?: unknown; passphrase?: unknown;
  } | undefined | null;
  // A daemon older than this panel has no `wayBackIn`. Not a failure, and not
  // something to draw a half-empty bar from: leave what is on screen alone.
  if (
    back === null || typeof back !== "object"
    || typeof back.ssid !== "string"
    || typeof back.address !== "string"
    || typeof back.hostname !== "string"
  ) {
    return { payload: undefined, yonder: idle(now) };
  }

  // Three answers, kept apart. `null` is "the operator set their own"; an
  // absent key is "this device cannot tell", which is what a daemon serving
  // without a secret store says. Collapsing the two would put one of the two
  // wrong sentences on the panel that exists for a device in that state.
  const known = typeof back.passphrase === "string" && back.passphrase !== "";
  const cannotTell = !known && back.passphrase !== null;

  return {
    // Field by field, never spread: a key added to the daemon's answer later
    // cannot reach a page by being carried along. This is the panel that
    // would carry a credential if anything did.
    payload: {
      join: back.ssid,
      passphrase: known
        ? back.passphrase as string
        : cannotTell ? AP_PASSPHRASE_UNKNOWN : AP_PASSPHRASE_CHANGED,
      at: back.address,
      or: back.hostname,
      note: cannotTell ? WAY_BACK_IN_NOTE + AP_PASSPHRASE_UNKNOWN_NOTE : WAY_BACK_IN_NOTE,
    },
    yonder: idle(now),
  };
}

/**
 * `POST /revert`'s answer.
 *
 * `confirmed`, not `rejected`, and the distinction is worth stating: this is
 * the state of the *command the operator gave*, which was "put it back". That
 * command took effect and is staying. Reporting the change's own fate here
 * would light a red lamp on a control that did exactly what it was asked.
 */
export function revertStatus(reply: DaemonReply, now: number, id: string): CommandStatus {
  const result = fetched(reply);
  if (!result.ok) return rejected(result.message, { at: now, id });
  return confirmed("Put back. The device is running the previous configuration.", { at: now, id });
}
