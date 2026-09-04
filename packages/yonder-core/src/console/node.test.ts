// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLL_MS,
  DEFAULT_SOCKET_PATH,
  MIN_POLL_MS,
  PENDING_WHY,
  applyStatus,
  confirmStatus,
  fetched,
  pendingChange,
  pollIntervalMs,
  revertStatus,
  socketPathFrom,
} from "./node.js";
import type { DaemonReply } from "./client.js";

const unreachable: DaemonReply = { ok: false, reason: "unreachable", message: "connect ENOENT /run/yonder/core.sock" };
const malformed: DaemonReply = { ok: false, reason: "malformed", message: "the reply was not valid JSON" };

describe("pollIntervalMs", () => {
  /**
   * R-UI-06. A one-second poll on a link with hundreds of milliseconds of
   * latency is a request still in flight when the next one is issued. The
   * floor is here rather than in `flows.json`, which is wiring an operator
   * can edit in the flow editor.
   */
  it("never goes below the floor, whatever it is asked for", () => {
    for (const asked of [0.1, 1, 1.999, 0.001]) {
      expect(pollIntervalMs(asked), String(asked)).toBe(MIN_POLL_MS);
    }
  });

  it("honours an interval that is slower than the floor", () => {
    expect(pollIntervalMs(5)).toBe(5_000);
    expect(pollIntervalMs(60)).toBe(60_000);
  });

  it("takes a string, because that is what an editor form produces", () => {
    expect(pollIntervalMs("10")).toBe(10_000);
  });

  it("falls back rather than producing a timer that fires continuously", () => {
    for (const asked of [undefined, null, "", "soon", Number.NaN, -5, 0, {}]) {
      expect(pollIntervalMs(asked), JSON.stringify(asked)).toBe(DEFAULT_POLL_MS);
    }
  });
});

describe("socketPathFrom", () => {
  it("reads the path the generated settings.js carries", () => {
    expect(socketPathFrom({ yonder: { socketPath: "/tmp/core.sock" } })).toBe("/tmp/core.sock");
  });

  /**
   * A node that cannot construct itself takes the flow down with it, and the
   * console is what an operator would be using to fix that.
   */
  it("falls back to the installed default rather than throwing", () => {
    for (const settings of [undefined, null, {}, { yonder: null }, { yonder: {} }, { yonder: { socketPath: "" } }, { yonder: { socketPath: 7 } }]) {
      expect(socketPathFrom(settings), JSON.stringify(settings)).toBe(DEFAULT_SOCKET_PATH);
    }
  });
});

describe("fetched", () => {
  it("hands back the body of a 200", () => {
    expect(fetched({ ok: true, status: 200, body: { model: "a board" } }))
      .toEqual({ ok: true, value: { model: "a board" } });
  });

  it("relays the daemon's own wording for a refusal", () => {
    const reply: DaemonReply = { ok: true, status: 400, body: { error: "host must be a host name or an IPv4 address" } };
    expect(fetched(reply)).toEqual({
      ok: false, message: "host must be a host name or an IPv4 address",
    });
  });

  it("says something useful about a gate rather than repeating a number", () => {
    const result = fetched({ ok: true, status: 403, body: { error: "..." } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("administrator password");
  });

  /**
   * A transport failure's message is a socket path and an errno. That is
   * detail for a journal, not for a page — and a page is where this goes.
   */
  it("never puts a transport error into what an operator reads", () => {
    for (const reply of [unreachable, malformed]) {
      const result = fetched(reply);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).not.toContain("ENOENT");
      expect(result.ok === false && result.message).not.toContain("core.sock");
      expect(result.ok === false && result.message).toContain("not answering");
    }
  });

  it("still says something when the daemon refused with no wording at all", () => {
    const result = fetched({ ok: true, status: 500, body: undefined });
    expect(result.ok === false && result.message).toContain("500");
  });
});

describe("applyStatus", () => {
  /**
   * The thing a console most easily gets wrong. A successful apply is
   * **pending**: the change is in force and will be undone unless the operator
   * says from the other side that they can still reach the device (R-CFG-03).
   * A control showing "done" here tells them the opposite of what is about to
   * happen.
   */
  it("is pending on success, never confirmed", () => {
    const status = applyStatus(
      { ok: true, status: 200, body: { id: "abc", expiresAt: 120_000 } },
      1_000,
    );
    expect(status.state).toBe("pending");
    expect(status.id).toBe("abc");
    expect(status.expiresAt).toBe(120_000);
    expect(status.movesRadio).toBeUndefined();
  });

  it("says the access point is going away when the apply moves the radio", () => {
    const status = applyStatus(
      { ok: true, status: 200, body: { id: "abc", expiresAt: 300_000, movesRadio: true } },
      0,
    );
    expect(status.movesRadio).toBe(true);
    // What it must convey, not the sentence it uses.
    expect(status.message).toMatch(/page is about to go|lose this page/i);
    expect(status.message).toMatch(/comes back/i);
    expect(status.expiresAt).toBe(300_000);
  });

  /**
   * The other half of the same mistake. R-CFG-12 keeps a change that cannot
   * cost reachability rather than holding it, and the daemon says so with
   * `expiresAt: null` on an apply it has already confirmed. A mesh join is
   * one (R-VPN-07) and so is a change of palette. Telling that operator the
   * change reverts on its own sends them looking for a confirm control that
   * does not exist, and reasonably concluding the change did not take.
   */
  it("is confirmed, not pending, for an apply the device already kept", () => {
    const status = applyStatus(
      { ok: true, status: 200, body: { id: "abc", expiresAt: null } },
      1_000,
    );
    expect(status.state).toBe("confirmed");
    expect(status.id).toBe("abc");
    expect(status.expiresAt).toBeUndefined();
    expect(status.message).not.toMatch(/revert|confirm it/i);
  });

  /**
   * Absent is not the same as null. A 200 that simply omits the field is an
   * answer this console does not understand well enough to call finished, so
   * it stays pending and the operator is still asked to confirm.
   */
  it("stays pending when the answer carries no expiry at all", () => {
    const status = applyStatus({ ok: true, status: 200, body: { id: "abc" } }, 0);
    expect(status.state).toBe("pending");
  });

  it("is rejected when the daemon refused", () => {
    const status = applyStatus(
      { ok: true, status: 400, body: { error: "rejected: not a valid configuration" } },
      0,
    );
    expect(status.state).toBe("rejected");
    expect(status.message).toContain("not a valid configuration");
  });

  /**
   * A control that did something unknown is worse than one that says it
   * failed. "The daemon did not answer" is a rejection, not a silence.
   */
  it("is rejected when the daemon could not be reached at all", () => {
    expect(applyStatus(unreachable, 0).state).toBe("rejected");
    expect(applyStatus(malformed, 0).state).toBe("rejected");
  });

  /**
   * A 200 with no id would otherwise leave a control waiting to confirm an
   * apply that does not exist — and then reverting under the operator with no
   * explanation.
   */
  it("is rejected for a 200 that carries no apply id", () => {
    const status = applyStatus({ ok: true, status: 200, body: { ok: true } }, 0);
    expect(status.state).toBe("rejected");
    expect(status.message).toContain("did not understand");
  });
});

describe("confirmStatus", () => {
  it("is confirmed on success", () => {
    const status = confirmStatus({ ok: true, status: 200, body: { state: "confirmed" } }, 5, "abc");
    expect(status.state).toBe("confirmed");
    expect(status.id).toBe("abc");
  });

  it("is rejected on anything else, and keeps the id so a page knows which", () => {
    const status = confirmStatus({ ok: true, status: 400, body: { error: "nothing is pending confirmation" } }, 5, "abc");
    expect(status.state).toBe("rejected");
    expect(status.id).toBe("abc");
    expect(status.message).toContain("nothing is pending");
  });

  it("is rejected when the daemon is not answering", () => {
    expect(confirmStatus(unreachable, 0, "abc").state).toBe("rejected");
  });
});

/**
 * The page that joins a network carries no prose, so everything an operator
 * needs before the console disappears travels on this message.
 */
describe("what a radio move tells the operator", () => {
  const moving = { ok: true, status: 200, body: { id: "a1", expiresAt: 1, movesRadio: true } };

  it("says the page is going", () => {
    expect(applyStatus(moving as never, 0).message).toMatch(/about to go|lose this page/i);
  });

  it("says where to find the device, and a way that needs no name to resolve", () => {
    const m = applyStatus(moving as never, 0).message;
    expect(m).toMatch(/yonder\.local/i);
    expect(m).toMatch(/router|client list/i);
  });

  it("says a failure costs nothing", () => {
    expect(applyStatus(moving as never, 0).message).toMatch(/access point comes back|comes back/i);
  });

  /**
   * And asks for nothing. The words used to say "confirm it to keep it" for a
   * change nobody can confirm from a console that is about to go off the air,
   * which sends an operator hunting for a button that is not there.
   */
  it("asks the operator for nothing", () => {
    const m = applyStatus(moving as never, 0).message;
    expect(m).not.toMatch(/confirm/i);
  });
});

/**
 * **R-UI-15.** A change that will revert is visible wherever the operator is,
 * not only where it was made. Everything the banner draws comes from here, in
 * words, because a clock ticking inside `flows.json` would be arithmetic in
 * wiring on the one number that decides whether an operator still has a
 * device (CLAUDE.md rule 2).
 */
describe("pendingChange", () => {
  const answering = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });

  it("says nothing is pending when the engine is at rest", () => {
    const shaped = pendingChange(answering({ state: "idle" }), 1_000);
    expect(shaped.payload).toEqual({ pending: false, id: "", what: "", why: "" });
    expect(shaped.yonder.state).toBe("idle");
  });

  /**
   * Every state that is not `pending` is nothing to confirm. `applying` and
   * `reverting` are in flight and neither offers the operator a decision;
   * `confirmed` is over.
   */
  it("raises nothing for a state that is not pending", () => {
    for (const state of ["applying", "confirmed", "reverting"]) {
      expect(pendingChange(answering({ state, id: "a1" }), 0).payload.pending, state).toBe(false);
    }
  });

  it("carries the countdown, the id and both lines while one is pending", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 212_000 }),
      120_000,
    );
    expect(shaped.payload.pending).toBe(true);
    expect(shaped.payload.id).toBe("a1");
    expect(shaped.payload.what).not.toBe("");
    expect(shaped.payload.why).toBe(PENDING_WHY);
    // The lamp's caption, already words and in the waiting tone.
    expect(shaped.yonder.state).toBe("pending");
    expect(shaped.yonder.message).toBe("Reverts in 1:32");
    expect(shaped.yonder.id).toBe("a1");
  });

  /**
   * The sentence does not threaten the operator with the revert. The revert
   * is what rescues them, and an interface that presents it as a punishment
   * for inaction teaches confirming by reflex — which is the habit that turns
   * a wrong change into a device nobody can reach.
   */
  it("states the revert as the thing that recovers them", () => {
    expect(PENDING_WHY).toMatch(/gets you back in/);
    expect(PENDING_WHY).not.toMatch(/lose|warning|danger|will be lost/i);
  });

  /** A countdown frozen at 0:00 reads as a page that has stopped updating. */
  it("says the rollback is happening once the window has run out", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 100 }),
      5_000,
    );
    expect(shaped.payload.pending).toBe(true);
    expect(shaped.yonder.message).toBe("Reverting now");
  });

  /**
   * **The one place this module leaves a panel down rather than shouting.**
   *
   * Every field the banner draws — the countdown, the id both of its keys
   * need — is unknown when the daemon does not answer, so what it could raise
   * is an alarm with no time on it and two controls that would fail. The
   * failure still travels on `msg.yonder`, so the node says so in its own
   * status and the panels beside it on that page report the same silence.
   */
  it("leaves the banner down when it cannot find out, and says why on yonder", () => {
    const shaped = pendingChange(unreachable, 1_000);
    expect(shaped.payload.pending).toBe(false);
    expect(shaped.yonder.state).toBe("rejected");
    expect(shaped.yonder.message).toMatch(/not answering/);
  });

  it("does not fall over on an answer that is not this daemon's", () => {
    for (const body of [undefined, null, "ok", { state: "pending" }]) {
      const shaped = pendingChange(answering(body), 0);
      expect(typeof shaped.payload.id).toBe("string");
      expect(typeof shaped.payload.pending).toBe("boolean");
    }
    // Pending with no deadline: still pending, and it says so without a clock.
    expect(pendingChange(answering({ state: "pending" }), 0).yonder.message).toBe("Reverting now");
  });
});

describe("revertStatus", () => {
  /**
   * `confirmed`, not `rejected`. This is the state of the *command the
   * operator gave*, which was "put it back": it took effect and it is
   * staying. Reporting the change's own fate here would light a red lamp on a
   * control that did exactly what it was asked.
   */
  it("reports the operator's own command as done", () => {
    const status = revertStatus({ ok: true, status: 200, body: { state: "idle" } }, 5, "a1");
    expect(status.state).toBe("confirmed");
    expect(status.id).toBe("a1");
    expect(status.message).toMatch(/previous configuration/);
  });

  it("says so when the device refused, and keeps the id", () => {
    const status = revertStatus(
      { ok: true, status: 400, body: { error: "nothing is pending confirmation" } },
      5,
      "a1",
    );
    expect(status.state).toBe("rejected");
    expect(status.message).toBe("nothing is pending confirmation");
    expect(status.id).toBe("a1");
  });

  it("says so when the daemon did not answer at all", () => {
    expect(revertStatus(malformed, 5, "a1").state).toBe("rejected");
  });
});
