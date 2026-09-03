// SPDX-License-Identifier: GPL-3.0-or-later
import { DaemonClient, type DaemonReply } from "./client.js";
import { rejected, pending, confirmed, type CommandStatus } from "./command.js";

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
