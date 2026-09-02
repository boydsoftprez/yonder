// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLL_MS,
  DEFAULT_SOCKET_PATH,
  MIN_POLL_MS,
  applyStatus,
  confirmStatus,
  fetched,
  pollIntervalMs,
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
