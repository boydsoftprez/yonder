// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLL_MS,
  DEFAULT_SOCKET_PATH,
  MIN_POLL_MS,
  PENDING_WHY,
  PENDING_WHAT,
  PENDING_WHY_RADIO,
  PENDING_WHAT_RADIO,
  PENDING_KEYS,
  PENDING_KEYS_RADIO,
  applyStatus,
  confirmStatus,
  fetched,
  pendingChange,
  pollIntervalMs,
  revertStatus,
  socketPathFrom,
  wayBackInView,
  AP_PASSPHRASE_CHANGED,
  AP_PASSPHRASE_UNKNOWN,
  AP_PASSPHRASE_UNKNOWN_NOTE,
  WAY_BACK_IN_NOTE,
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
    // `keys` is in the payload even here, and it is the ordinary pair. The
    // rail draws the last list it was given, so a banner that is down must
    // not leave a control removed behind it — and the pair is the safe answer
    // in any case.
    expect(shaped.payload).toEqual({
      pending: false, id: "", what: "", why: "", keys: PENDING_KEYS, engineState: "idle", observedAt: 1000,
    });
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
    expect(shaped.payload.what).toBe(PENDING_WHAT);
    expect(shaped.payload.why).toBe(PENDING_WHY);
    expect(shaped.payload.keys).toEqual([
      { label: "KEEP", action: "confirm", tone: "warn" },
      { label: "REVERT", action: "revert", tone: "act" },
    ]);
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
    expect(PENDING_WHY).toMatch(/Revert/);
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

  /**
   * **R-CFG-11: a change that moved the radio is not the operator's to
   * confirm, and the banner stops offering it.**
   *
   * The console cannot work this out for itself — `GET /status` carries an
   * apply state, an id and a deadline, and which settings moved is not among
   * them — so the daemon says, and this reads what it said. Before it did,
   * `CONFIRM` was offered for every pending apply including a Wi-Fi join, and
   * pressing it moved the engine to `confirmed`, which makes the device's own
   * verification return early: an operator reachable over Ethernet or
   * cellular could keep a join the device never confirmed.
   */
  it("offers no CONFIRM for a change that moved the radio", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 212_000, movesRadio: true }),
      120_000,
    );
    expect(shaped.payload.pending).toBe(true);
    expect(shaped.payload.keys).toEqual([{ label: "REVERT", action: "revert", tone: "act" }]);
    expect(shaped.payload.keys.map((k) => k.action)).not.toContain("confirm");
    // The countdown is unchanged: the change still reverts if it does not
    // take, and the operator still has to be able to see how long is left.
    expect(shaped.yonder.message).toBe("Reverts in 1:32");
    expect(shaped.yonder.movesRadio).toBe(true);
  });

  /**
   * **`REVERT NOW` survives, and it is the whole of what is left.**
   *
   * Deciding you do not want the change is still a real thing to want, and
   * for this apply it is the operator's only control over it. Losing it would
   * be worse than the problem this fixes.
   */
  it("keeps REVERT NOW on the rail for a radio move", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 1_000, movesRadio: true }),
      0,
    );
    expect(shaped.payload.keys).toHaveLength(1);
    expect(shaped.payload.keys[0]).toEqual(PENDING_KEYS_RADIO[0]);
    expect(shaped.payload.id).toBe("a1");
  });

  /**
   * **An ordinary change still offers both.** The other half of the same
   * assertion: this is not a control that quietly went away for everyone.
   */
  it("still offers CONFIRM for a change that did not move the radio", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 1_000, movesRadio: false }),
      0,
    );
    expect(shaped.payload.keys).toEqual(PENDING_KEYS);
    expect(shaped.payload.what).toBe(PENDING_WHAT);
    expect(shaped.payload.why).toBe(PENDING_WHY);
  });

  /**
   * **Absent means an ordinary change, never a radio move.**
   *
   * A daemon that does not report the flag — an older one, or a path that
   * forgot to set it — must leave `CONFIRM` offered. Removing an operator's
   * ability to confirm an ordinary change costs them a working configuration
   * to a timer; offering it where it was not needed costs a key that does
   * nothing. Fail toward offering it, including for a value that is not a
   * boolean at all.
   */
  it("leaves CONFIRM offered when the daemon says nothing about the radio", () => {
    for (const body of [
      { state: "pending", id: "a1", expiresAt: 1_000 },
      { state: "pending", id: "a1", expiresAt: 1_000, movesRadio: "true" },
      { state: "pending", id: "a1", expiresAt: 1_000, movesRadio: 1 },
      { state: "pending", id: "a1", expiresAt: 1_000, movesRadio: null },
    ]) {
      const shaped = pendingChange(answering(body), 0);
      expect(shaped.payload.keys, JSON.stringify(body)).toEqual(PENDING_KEYS);
      expect(shaped.payload.why, JSON.stringify(body)).toBe(PENDING_WHY);
    }
  });

  /**
   * **The words change with the keys.** A countdown with nothing to press and
   * no explanation is worse than the control being there: it reads as a
   * console that has lost one. Both lines say instead that the device is
   * confirming for itself, which is R-CFG-11's actual behaviour and is
   * reassuring rather than alarming.
   */
  it("says the device is confirming for itself, and names the revert", () => {
    const shaped = pendingChange(
      answering({ state: "pending", id: "a1", expiresAt: 1_000, movesRadio: true }),
      0,
    );
    expect(shaped.payload.what).toBe(PENDING_WHAT_RADIO);
    expect(shaped.payload.why).toBe(PENDING_WHY_RADIO);
    expect(shaped.payload.what).toMatch(/device is confirming it for itself/);
    // It does not send an operator looking for a control that is not there.
    expect(shaped.payload.why).not.toMatch(/\bConfirm it\b/);
    expect(shaped.payload.why).toMatch(/nothing for you to confirm/i);
    // And it still names the one key that is there.
    expect(shaped.payload.why).toMatch(/[Rr]evert it now/);
    // Not a threat, the same rule the ordinary sentence is held to.
    expect(shaped.payload.why).not.toMatch(/lose|warning|danger|will be lost/i);
  });

  it("does not fall over on an answer that is not this daemon's", () => {
    for (const body of [undefined, null, "ok", { state: "pending" }]) {
      const shaped = pendingChange(answering(body), 0);
      expect(typeof shaped.payload.id).toBe("string");
      expect(typeof shaped.payload.pending).toBe("boolean");
    }
    // Pending with no deadline: still pending, and it says so without a clock.
    expect(pendingChange(answering({ state: "pending" }), 0).yonder.message).toBe("Reverting now");
    // And a rail always has something on it, whatever arrived.
    for (const body of [undefined, null, "ok", { state: "pending" }]) {
      expect(pendingChange(answering(body), 0).payload.keys.length).toBeGreaterThan(0);
    }
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

/**
 * `IF YOU LOSE THIS CONSOLE` — the panel an operator reads when nothing else
 * on the page is true any more (R-UI-18).
 */
describe("wayBackInView", () => {
  const answering = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
  const published = {
    ssid: "yonder", address: "192.168.77.1", hostname: "yonder.local",
    passphrase: "yonder1234",
  };

  it("names the network, the passphrase and both ways to reach the device", () => {
    const shaped = wayBackInView(answering({ state: "idle", wayBackIn: published }), 0);
    expect(shaped.payload).toEqual({
      join: "yonder",
      passphrase: "yonder1234",
      at: "192.168.77.1",
      or: "yonder.local",
      note: WAY_BACK_IN_NOTE,
    });
    expect(shaped.yonder.state).toBe("idle");
  });

  /**
   * R-SEC-10, on the console's side of the socket. The daemon answers `null`
   * once the operator has set their own, and the cell says so in words rather
   * than drawing the em dash that means *not known*: the device knows
   * perfectly well what the passphrase is, and is declining to print it.
   */
  it("says the passphrase has been changed rather than printing one", () => {
    const shaped = wayBackInView(
      answering({ state: "idle", wayBackIn: { ...published, passphrase: null } }), 0,
    );
    expect(shaped.payload?.passphrase).toBe(AP_PASSPHRASE_CHANGED);
    expect(shaped.payload?.join).toBe("yonder");
  });

  /**
   * The wording never invites a reader to look the value up somewhere on the
   * device. There is nowhere to look: `secrets.yaml` is `0600 root` and the
   * console cannot read it (ADR-0008).
   */
  it("does not tell an operator to go and find it", () => {
    expect(AP_PASSPHRASE_CHANGED).not.toMatch(/secret|file|journal|log/i);
  });

  /**
   * **The third answer, and the one the panel exists for.** A device whose
   * `secrets.yaml` cannot be read does not know which passphrase its own
   * access point is on — so it says that, rather than naming the published
   * default at an operator who set their own and would be typing a
   * passphrase that cannot work.
   *
   * "Changed" would be just as wrong in the other direction: this device has
   * not established that anything changed.
   */
  it.each([
    ["absent", { ...published, passphrase: undefined }],
    ["not a string or null", { ...published, passphrase: 42 }],
  ])("says the device cannot tell when the passphrase is %s", (_case, back) => {
    const shaped = wayBackInView(answering({ state: "idle", wayBackIn: back }), 0);
    expect(shaped.payload?.passphrase).toBe(AP_PASSPHRASE_UNKNOWN);
    expect(shaped.payload?.passphrase).not.toBe(AP_PASSPHRASE_CHANGED);
    // The rest of the panel is still true and still drawn: the SSID is
    // beaconed and the address is what DHCP hands out, whatever the secret
    // store is doing.
    expect(shaped.payload?.join).toBe("yonder");
    expect(shaped.payload?.at).toBe("192.168.77.1");
  });

  /**
   * And it does not leave the operator with nothing. The published default is
   * still the answer for anybody who never changed it — that is a fact about
   * the project, not a claim about this device — so the note says so in the
   * one state where the device cannot say it about itself.
   */
  it("points at the published default without claiming this device is on it", () => {
    const shaped = wayBackInView(
      answering({ state: "idle", wayBackIn: { ...published, passphrase: undefined } }), 0,
    );
    expect(shaped.payload?.note).toContain(WAY_BACK_IN_NOTE);
    expect(shaped.payload?.note).toContain(AP_PASSPHRASE_UNKNOWN_NOTE);
    // Never the value itself, in either half.
    expect(shaped.payload?.note).not.toContain("yonder1234");
  });

  /** The ordinary states carry the ordinary note and nothing more. */
  it.each([
    ["published", "yonder1234"],
    ["changed", null],
  ])("adds nothing to the note when the passphrase is %s", (_case, passphrase) => {
    const shaped = wayBackInView(
      answering({ state: "idle", wayBackIn: { ...published, passphrase } }), 0,
    );
    expect(shaped.payload?.note).toBe(WAY_BACK_IN_NOTE);
  });

  /**
   * **A read that fails leaves the panel exactly as it was**, and this is the
   * one node in the console that does that deliberately.
   *
   * Everywhere else a failed read raises a rejected state, because a stale
   * reading is a lie — `pendingChange` takes its banner down for precisely
   * that reason. Here there is no reading. Which network to join and what
   * address to open does not stop being true because the daemon missed a
   * poll, and blanking the panel would remove the one thing on the page that
   * still helps at the moment the daemon has gone quiet. The failure still
   * travels on `msg.yonder`, so the node says so in its own status.
   */
  it("sends nothing at all when the daemon does not answer", () => {
    for (const reply of [unreachable, malformed]) {
      const shaped = wayBackInView(reply, 5_000);
      expect(shaped.payload).toBeUndefined();
      expect(shaped.yonder.state).toBe("rejected");
    }
  });

  /**
   * An older daemon has no `wayBackIn` in its `/status`. That is a reply this
   * console cannot draw a panel from, and it is not a failure either — so it
   * takes the same road as a failed read: send nothing, leave what is on
   * screen alone.
   */
  it("sends nothing when the answer does not carry a way back in", () => {
    expect(wayBackInView(answering({ state: "idle" }), 0).payload).toBeUndefined();
    expect(wayBackInView(answering({ state: "idle", wayBackIn: null }), 0).payload).toBeUndefined();
    expect(wayBackInView(answering({ state: "idle", wayBackIn: { ssid: 7 } }), 0).payload)
      .toBeUndefined();
  });

  /**
   * Field by field out of the reply, never spread from it. A key added to
   * `WayBackIn` later cannot reach a page by being carried along — which is
   * the rule `modemForm` was written to after R-UI-17, applied to the panel
   * that would carry a credential if anything did.
   */
  it("carries nothing the panel does not draw", () => {
    const shaped = wayBackInView(
      answering({ state: "idle", wayBackIn: { ...published, somethingNew: "hunter2" } }), 0,
    );
    expect(JSON.stringify(shaped.payload)).not.toMatch(/hunter2/);
    expect(Object.keys(shaped.payload ?? {}).sort())
      .toEqual(["at", "join", "note", "or", "passphrase"]);
  });

  /** The line under the bar says what to do with it, and stays true whatever
   *  port and palette the console is on. */
  it("explains what the panel is for without inventing a URL", () => {
    expect(WAY_BACK_IN_NOTE).toMatch(/photograph/i);
    expect(WAY_BACK_IN_NOTE).not.toMatch(/http|:\d{2,5}/);
  });
});
