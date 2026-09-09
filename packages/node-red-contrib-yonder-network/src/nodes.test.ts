// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import helper from "node-red-node-test-helper";
import type { DaemonClient, DaemonReply, DaemonRequest } from "yonder-core";

/**
 * The network nodes, in a real Node-RED.
 *
 * **No test opens a socket.** `clientFor` is mocked so the node gets a client
 * that answers from a script. What is under test is the adapter: the route it
 * calls, the message it emits, and — the part that matters most — that a
 * successful apply is reported as *pending* rather than as done.
 */

const replies: DaemonReply[] = [];
const asked: DaemonRequest[] = [];

vi.mock("yonder-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yonder-core")>();
  return {
    ...actual,
    clientFor: (): DaemonClient => ({
      request: (req: DaemonRequest): Promise<DaemonReply> => {
        asked.push(req);
        return Promise.resolve(
          replies.shift() ?? { ok: false, reason: "unreachable", message: "no reply scripted" },
        );
      },
    } as unknown as DaemonClient),
  };
});

const configNode = (await import("./config.js")).default ?? await import("./config.js");
const scanNode = (await import("./scan.js")).default ?? await import("./scan.js");
const applyNode = (await import("./apply.js")).default ?? await import("./apply.js");
const confirmNode = (await import("./confirm.js")).default ?? await import("./confirm.js");
const revertNode = (await import("./revert.js")).default ?? await import("./revert.js");
const pendingNode = (await import("./pending.js")).default ?? await import("./pending.js");
const waybackNode = (await import("./wayback.js")).default ?? await import("./wayback.js");
const joinNode = (await import("./join.js")).default ?? await import("./join.js");
const watchNode = (await import("./watch.js")).default ?? await import("./watch.js");

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
const unreachable: DaemonReply = {
  ok: false, reason: "unreachable", message: "connect ENOENT /run/yonder/core.sock",
};

interface Received {
  payload?: unknown;
  topic?: unknown;
  yonder?: { state?: string; message?: string; id?: string; expiresAt?: number; movesRadio?: boolean };
}

function send(node: unknown, type: string, message: Record<string, unknown> = {}): Promise<Received> {
  const flow = [
    { id: "n1", type, wires: [["n2"]] },
    { id: "n2", type: "helper" },
  ];
  return new Promise((resolve, reject) => {
    void helper.load(node, flow, () => {
      const sink = helper.getNode("n2") as unknown as {
        on(event: string, fn: (msg: Received) => void): void;
      };
      sink.on("input", (msg) => { resolve(msg); });
      (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive(message);
      setTimeout(() => { reject(new Error(`no message from ${type}`)); }, 4_000);
    });
  });
}

beforeAll((): Promise<void> => new Promise((resolve) => { void helper.startServer(resolve); }));
afterAll((): Promise<void> => new Promise((resolve) => { void helper.stopServer(resolve); }));
afterEach(async () => {
  await helper.unload();
  replies.length = 0;
  asked.length = 0;
});

describe("yonder-config", () => {
  it("reads the configuration when a message arrives", async () => {
    replies.push(ok({ version: 1, network: {} }));
    const msg = await send(configNode, "yonder-config");
    expect(msg.payload).toEqual({ version: 1, network: {} });
    expect(asked).toEqual([{ method: "GET", path: "/config" }]);
  });

  it("emits a rejected state rather than nothing when the daemon is down", async () => {
    replies.push(unreachable);
    const msg = await send(configNode, "yonder-config");
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.payload).toBeNull();
    expect(JSON.stringify(msg)).not.toContain("ENOENT");
  });
});

describe("yonder-scan", () => {
  it("emits what is in the air", async () => {
    const result = {
      interface: "wlan0",
      networks: [{ ssid: "HomeNetwork", signal: 78, security: "WPA2" }],
    };
    replies.push(ok(result));
    const msg = await send(scanNode, "yonder-scan");
    expect(msg.payload).toEqual(result);
    expect(asked).toEqual([{ method: "GET", path: "/net/scan" }]);
  });

  it("emits a rejected state when the scan could not be run", async () => {
    replies.push({ ok: true, status: 500, body: { error: "the request failed; see the device journal for the reason" } });
    const msg = await send(scanNode, "yonder-scan");
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("device journal");
  });

  /** A scan is a list of what is broadcasting. It never carries a key. */
  it("does not invent a credential the route could not have returned", async () => {
    replies.push(ok({ interface: "wlan0", networks: [{ ssid: "HomeNetwork", signal: 78, security: "WPA2" }] }));
    const msg = await send(scanNode, "yonder-scan");
    expect(JSON.stringify(msg.payload)).not.toMatch(/psk|password|passphrase/i);
  });
});

describe("yonder-apply", () => {
  /**
   * The thing this milestone most easily gets wrong. A successful apply is
   * **pending**: the change is in force and reverts unless the operator
   * confirms it from the other side (R-CFG-03). A control showing "done" here
   * tells them the opposite of what is about to happen.
   */
  it("reports a successful apply as pending, not as done", async () => {
    replies.push(ok({ id: "abc", expiresAt: 120_000 }));
    const msg = await send(applyNode, "yonder-apply", { payload: { version: 1 } });
    expect(msg.yonder?.state).toBe("pending");
    expect(msg.yonder?.id).toBe("abc");
    expect(msg.yonder?.expiresAt).toBe(120_000);
    expect(asked[0]).toMatchObject({ method: "POST", path: "/apply", body: { version: 1 } });
  });

  /**
   * The single most important piece of copy in the product, carried on the
   * message so a page can say it. The operator is about to lose the access
   * point they are reading this over.
   */
  it("says the access point is going away when the apply moves the radio", async () => {
    replies.push(ok({ id: "abc", expiresAt: 300_000, movesRadio: true }));
    const msg = await send(applyNode, "yonder-apply", { payload: { version: 1 } });
    expect(msg.yonder?.movesRadio).toBe(true);
    // Asserted on what it must convey, not on a phrase: that the page is
    // about to go, and that a failure puts the access point back. The words
    // changed once already when the confirmation was removed, and a test
    // pinned to a sentence broke without anything being wrong.
    expect(String(msg.yonder?.message)).toMatch(/page is about to go|lose this page/i);
    expect(String(msg.yonder?.message)).toMatch(/access point comes back|comes back/i);
    expect(msg.yonder?.expiresAt).toBe(300_000);
  });

  it("reports a refusal with the daemon's own wording", async () => {
    replies.push({ ok: true, status: 400, body: { error: "rejected: not a valid configuration" } });
    const msg = await send(applyNode, "yonder-apply", { payload: {} });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("not a valid configuration");
  });

  it("reports a daemon that never answered as rejected, never as silence", async () => {
    replies.push(unreachable);
    const msg = await send(applyNode, "yonder-apply", { payload: {} });
    expect(msg.yonder?.state).toBe("rejected");
  });
});

describe("yonder-confirm", () => {
  it("confirms the apply the message names", async () => {
    replies.push(ok({ state: "confirmed" }));
    const msg = await send(confirmNode, "yonder-confirm", { yonder: { id: "abc" } });
    expect(msg.yonder?.state).toBe("confirmed");
    expect(asked).toEqual([{ method: "POST", path: "/confirm", body: { id: "abc" } }]);
  });

  it("takes the id from the payload as well, because a flow may carry it there", async () => {
    replies.push(ok({ state: "confirmed" }));
    await send(confirmNode, "yonder-confirm", { payload: { id: "def" } });
    expect(asked[0]?.body).toEqual({ id: "def" });
  });

  /**
   * With no id there is nothing to confirm, and saying so is better than a
   * request the daemon refuses for its own reasons a page cannot explain.
   */
  it("refuses with a reason when there is nothing to confirm, and calls nothing", async () => {
    const msg = await send(confirmNode, "yonder-confirm", { payload: undefined });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("no change waiting");
    expect(asked).toEqual([]);
  });

  it("reports a daemon that never answered as rejected", async () => {
    replies.push(unreachable);
    const msg = await send(confirmNode, "yonder-confirm", { yonder: { id: "abc" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.id).toBe("abc");
  });
});

describe("yonder-join", () => {
  /**
   * Three widgets, one join. `ui-form` renders nothing masked — its types are
   * text, email, number, multiline, checkbox, switch, date, time and dropdown
   * — so a passphrase typed into one would be on screen in clear. The masked
   * widget, `ui-text-input` with `mode: "password"`, is separate, so the
   * network, the passphrase and the button arrive as three messages and this
   * node is what holds them together.
   */
  /**
   * Load the node once and hand it several messages in order.
   *
   * `send` above loads a fresh flow per call, which is right for a node that
   * answers each message on its own. This one deliberately holds state across
   * messages — the network and the passphrase, until the button — so a helper
   * that reloaded between them would be testing a node that had forgotten
   * everything, and passing.
   *
   * Resolves with the last message the node emitted, or `{}` if it emitted
   * none, which is itself the assertion for "this input produces no output".
   */
  function feed(node: unknown, msgs: { topic: string; payload: unknown }[]): Promise<Received> {
    const flow = [
      { id: "n1", type: "yonder-join", wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    return new Promise((resolve, reject) => {
      void helper.load(node, flow, () => {
        let last: Received = {};
        const sink = helper.getNode("n2") as unknown as {
          on(event: string, fn: (msg: Received) => void): void;
        };
        sink.on("input", (msg) => { last = msg; });
        const n1 = helper.getNode("n1") as unknown as { receive(m: unknown): void };
        for (const m of msgs) n1.receive(m);
        // Long enough for the awaited request inside the node to settle, and
        // short enough that a hang is a failure rather than a wait.
        setTimeout(() => { resolve(last); }, 300);
        setTimeout(() => { reject(new Error("feed never settled")); }, 4_000);
      });
    });
  }

  it("joins with the network chosen and the passphrase typed", async () => {
    replies.push(ok({ id: "abc", expiresAt: 300_000, movesRadio: true }));
    const msg = await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "psk", payload: "a-passphrase" },
      { topic: "join", payload: "" },
    ]);
    expect(asked).toEqual([{
      method: "POST", path: "/net/join", body: { ssid: "HomeNetwork", psk: "a-passphrase" },
    }]);
    expect(msg.yonder?.state).toBe("pending");
    expect(msg.yonder?.movesRadio).toBe(true);
  });

  it("asks nothing of the daemon until the button is pressed", async () => {
    await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "psk", payload: "a-passphrase" },
    ]);
    expect(asked).toHaveLength(0);
  });

  it("refuses before spending a confirmation window on a join with no network", async () => {
    const msg = await feed(joinNode, [{ topic: "join", payload: "" }]);
    expect(asked).toHaveLength(0);
    expect(msg.yonder?.state).toBe("rejected");
    expect(String(msg.yonder?.message)).toMatch(/choose a network/i);
  });

  it("joins an open network, where there is no passphrase to give", async () => {
    replies.push(ok({ id: "abc", expiresAt: 300_000 }));
    await feed(joinNode, [
      { topic: "ssid", payload: "OpenNetwork" },
      { topic: "join", payload: "" },
    ]);
    expect(asked[0]).toMatchObject({ body: { ssid: "OpenNetwork", psk: null } });
  });

  /** A sent passphrase has no reason to still be in this process. */
  it("forgets the passphrase once it has been sent", async () => {
    replies.push(ok({ id: "a", expiresAt: 1 }), ok({ id: "b", expiresAt: 1 }));
    await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "psk", payload: "a-passphrase" },
      { topic: "join", payload: "" },
      { topic: "join", payload: "" },
    ]);
    expect(asked[1]).toMatchObject({ body: { ssid: "HomeNetwork", psk: null } });
  });

  it("never puts the passphrase on an outgoing message", async () => {
    replies.push(ok({ id: "abc", expiresAt: 300_000 }));
    const msg = await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "psk", payload: "hunter2-and-then-some" },
      { topic: "join", payload: "" },
    ]);
    expect(JSON.stringify(msg)).not.toContain("hunter2");
  });

  /**
   * The single most important piece of copy in the product reaches the page on
   * this message. The operator is about to lose the access point they are
   * reading it over.
   */
  it("carries the words that say the access point is going away", async () => {
    replies.push(ok({ id: "abc", expiresAt: 300_000, movesRadio: true }));
    const msg = await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "join", payload: "" },
    ]);
    // Asserted on what it must convey, not on a phrase: that the page is
    // about to go, and that a failure puts the access point back. The words
    // changed once already when the confirmation was removed, and a test
    // pinned to a sentence broke without anything being wrong.
    expect(String(msg.yonder?.message)).toMatch(/page is about to go|lose this page/i);
    expect(String(msg.yonder?.message)).toMatch(/access point comes back|comes back/i);
  });

  it("relays the daemon's refusal rather than validating twice", async () => {
    replies.push({
      ok: true,
      status: 400,
      body: { error: "the passphrase must be between 8 and 63 characters; that is what WPA2 accepts" },
    });
    const msg = await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "psk", payload: "short" },
      { topic: "join", payload: "" },
    ]);
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("WPA2");
    expect(asked).toHaveLength(1);
  });

  it("reports a daemon that never answered as rejected", async () => {
    replies.push(unreachable);
    const msg = await feed(joinNode, [
      { topic: "ssid", payload: "HomeNetwork" },
      { topic: "join", payload: "" },
    ]);
    expect(msg.yonder?.state).toBe("rejected");
  });
});

describe("yonder-revert", () => {
  it("puts back the apply the message names", async () => {
    replies.push(ok({ state: "idle" }));
    const msg = await send(revertNode, "yonder-revert", { yonder: { id: "abc" } });
    // The operator's own command took effect and is staying. Reporting the
    // change's fate here would light a red lamp on a control that did exactly
    // what it was asked.
    expect(msg.yonder?.state).toBe("confirmed");
    expect(msg.yonder?.message).toContain("previous configuration");
    expect(asked).toEqual([{ method: "POST", path: "/revert", body: { id: "abc" }, timeoutMs: 60000 }]);
  });

  it("takes the id from the payload as well, because a flow may carry it there", async () => {
    replies.push(ok({ state: "idle" }));
    await send(revertNode, "yonder-revert", { payload: { id: "def" } });
    expect(asked[0]?.body).toEqual({ id: "def" });
  });

  it("refuses with a reason when there is nothing to put back, and calls nothing", async () => {
    const msg = await send(revertNode, "yonder-revert", { payload: undefined });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("no change waiting");
    expect(asked).toEqual([]);
  });

  it("reports a device that refused, so the key never silently does nothing", async () => {
    replies.push({ ok: true, status: 400, body: { error: "nothing is pending confirmation" } });
    const msg = await send(revertNode, "yonder-revert", { yonder: { id: "abc" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toBe("nothing is pending confirmation");
  });
});

/**
 * **R-UI-15.** The banner that makes a pending change visible wherever the
 * operator is, rather than only on the page it was made on.
 */
describe("yonder-pending", () => {
  /**
   * A polling node reads once on registration, so the sink may see that
   * message before the one a `receive` produced. Every test here scripts the
   * same reply twice and waits for the message it is actually about.
   */
  function fromPoller(
    message: Record<string, unknown> | undefined,
    want: (m: Received) => boolean = () => true,
  ): Promise<Received> {
    const flow = [
      { id: "n1", type: "yonder-pending", interval: 2, wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    return new Promise((resolve, reject) => {
      void helper.load(pendingNode, flow, () => {
        const sink = helper.getNode("n2") as unknown as {
          on(event: string, fn: (msg: Received) => void): void;
        };
        sink.on("input", (msg) => { if (want(msg)) resolve(msg); });
        if (message !== undefined) {
          (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive(message);
        }
        setTimeout(() => { reject(new Error("no message from yonder-pending")); }, 4_000);
      });
    });
  }

  it("reads the apply state and says nothing is pending", async () => {
    replies.push(ok({ state: "idle" }), ok({ state: "idle" }));
    const msg = await fromPoller({});
    // `keys` joined this payload when R-CFG-11 made the rail's contents
    // depend on which change is pending: a radio move is confirmed by the
    // device, so the banner over one offers no CONFIRM. With nothing pending
    // the list is the ordinary pair, which is what the rail's own
    // configuration says too.
    expect(msg.payload).toEqual({
      pending: false, id: "", what: "", why: "", engineState: "idle", observedAt: expect.any(Number),
      keys: [
        { label: "KEEP", action: "confirm", tone: "warn" },
        { label: "REVERT", action: "revert", tone: "act" },
      ],
    });
    expect(asked[0]).toEqual({ method: "GET", path: "/status" });
  });

  /**
   * **The rail's keys reach the page, and the radio case reaches it whole.**
   *
   * The decision is `pendingChange()`'s and it is tested in `yonder-core`;
   * what this asserts is that it survives the node — the payload the banner's
   * soft-key rail is drawn from carries only `REVERT NOW` for a change the
   * device is confirming for itself, and the prose beside it says so.
   */
  it("carries only REVERT NOW for a change that moved the radio", async () => {
    const moving = {
      state: "pending", id: "a1", expiresAt: Date.now() + 92_000, movesRadio: true,
    };
    replies.push(ok(moving), ok(moving));
    const msg = await fromPoller({}, (m) => (m.payload as { pending?: boolean }).pending === true);
    const payload = msg.payload as
      { keys: { label: string; action: string }[]; what: string; why: string };
    expect(payload.keys).toEqual([{ label: "REVERT", action: "revert", tone: "act" }]);
    expect(payload.keys.map((k) => k.action)).not.toContain("confirm");
    expect(payload.what).toMatch(/confirming it for itself/);
    expect(msg.yonder?.movesRadio).toBe(true);
  });

  it("carries the countdown as words, and both lines, while one is pending", async () => {
    const soon = { state: "pending", id: "a1", expiresAt: Date.now() + 92_000 };
    replies.push(ok(soon), ok(soon));
    const msg = await fromPoller({}, (m) => (m.payload as { pending?: boolean }).pending === true);
    const payload = msg.payload as { pending: boolean; id: string; what: string; why: string };
    expect(payload.pending).toBe(true);
    expect(payload.id).toBe("a1");
    expect(payload.what).not.toBe("");
    expect(payload.why).toMatch(/restore the previous settings/);
    // An ordinary change is still the operator's to keep, and the rail says so.
    expect((payload as unknown as { keys: { action: string }[] }).keys.map((k) => k.action))
      .toEqual(["confirm", "revert"]);
    // Already words. A clock ticking in a flow would be arithmetic in wiring.
    expect(msg.yonder?.state).toBe("pending");
    expect(msg.yonder?.message).toMatch(/^Reverts in 1:3\d$/);
  });

  /**
   * The key's own action rides on `msg.topic`, and the read must not lose it:
   * that is what lets one press be answered by a fresh read of `/status`, so
   * the id the confirm and revert nodes act on is the one the device holds at
   * that moment rather than one a flow cached.
   */
  it("keeps what the incoming message carried, so a key press survives the read", async () => {
    const now = { state: "pending", id: "a1", expiresAt: Date.now() + 60_000 };
    replies.push(ok(now), ok(now));
    const msg = await fromPoller(
      { payload: "revert", topic: "revert" },
      (m) => m.topic === "revert",
    );
    expect(msg.topic).toBe("revert");
    expect((msg.payload as { id: string }).id).toBe("a1");
  });

  it("leaves the banner down when the daemon does not answer, and says why", async () => {
    replies.push(unreachable, unreachable);
    const msg = await fromPoller({});
    expect((msg.payload as { pending: boolean }).pending).toBe(false);
    expect(msg.yonder?.state).toBe("rejected");
  });
});

/**
 * **R-UI-18.** The way back into a device an operator has lost the console to.
 *
 * The one property worth a node test: the passphrase rule holds through a
 * real Node-RED, not just in the pure function. What reaches a widget is the
 * published value or the words *changed* — never anything the device stores.
 */
describe("yonder-wayback", () => {
  const PUBLISHED = {
    ssid: "yonder", address: "192.168.77.1", hostname: "yonder.local",
    passphrase: "yonder1234",
  };

  /**
   * A polling node reads once on registration, so the sink may see that
   * message before the one a `receive` produced. Every test here scripts the
   * same reply twice and waits for the message it is actually about.
   */
  function fromPoller(
    message: Record<string, unknown> | undefined,
    want: (m: Received) => boolean = () => true,
  ): Promise<Received> {
    const flow = [
      { id: "n1", type: "yonder-wayback", interval: 2, wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    return new Promise((resolve, reject) => {
      void helper.load(waybackNode, flow, () => {
        const sink = helper.getNode("n2") as unknown as {
          on(event: string, fn: (msg: Received) => void): void;
        };
        sink.on("input", (msg) => { if (want(msg)) resolve(msg); });
        if (message !== undefined) {
          (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive(message);
        }
        setTimeout(() => { reject(new Error("no message from yonder-wayback")); }, 4_000);
      });
    });
  }

  it("reads /status and names the network, its address and the hostname", async () => {
    const body = { state: "idle", wayBackIn: PUBLISHED };
    replies.push(ok(body), ok(body));
    const msg = await fromPoller({});
    expect(asked[0]).toEqual({ method: "GET", path: "/status" });
    expect(msg.payload).toMatchObject({
      join: "yonder", at: "192.168.77.1", or: "yonder.local", passphrase: "yonder1234",
    });
  });

  /**
   * R-SEC-10, end to end through a runtime. The daemon answered `null`; what
   * arrives at the widget is a sentence, and the operator's own passphrase is
   * nowhere on the message — including on `msg.yonder`, which a widget also
   * reads.
   */
  it("says the passphrase was changed, and carries no passphrase at all", async () => {
    const body = { state: "idle", wayBackIn: { ...PUBLISHED, passphrase: null } };
    replies.push(ok(body), ok(body));
    const msg = await fromPoller({});
    expect((msg.payload as { passphrase: string }).passphrase).toMatch(/^changed/);
    expect(JSON.stringify(msg)).not.toMatch(/yonder1234/);
  });

  /**
   * A daemon that has gone quiet must not take the way back in off the page.
   * Nothing is sent, so the last good message stays on screen — the opposite
   * of `yonder-pending`, whose banner has to come down because a stale
   * countdown is a lie. There is no reading here to go stale.
   */
  it("sends nothing when the daemon does not answer, so the panel stays up", async () => {
    // Two failures — the read on registration and the one `receive` asks
    // for — then a poll that succeeds. Only the third produces a message.
    replies.push(unreachable, unreachable, ok({ state: "idle", wayBackIn: PUBLISHED }));
    const msg = await fromPoller({}, (m) => (m.payload as { join?: string }).join === "yonder");
    // The only message that arrived is the one from the reply that succeeded.
    expect((msg.payload as { join: string }).join).toBe("yonder");
  });
});

/**
 * `yonder-config-watch` — R-UI-20.
 *
 * The console read `config.yaml` once, when the flows were deployed, and
 * never again: an operator who opened MAVLink ingest went on being told the
 * board accepted it from itself alone (R-MAV-07). The fix could not simply be
 * a repeating read, because the same document seeds ten boxes an operator
 * types into. So the read repeats and the message does not.
 */
describe("yonder-config-watch", () => {
  /**
   * The node polls and has no input, so a test drives it by scripting replies
   * and collecting whatever arrives inside a window rather than by sending it
   * a message.
   *
   * **The windows are wall-clock and they are long on purpose.** The seeding
   * read is a second after deployment and R-UI-06's two-second floor is
   * enforced in `yonder-core`, so reads land at roughly 1 s, 3 s and 5 s. A
   * test that wanted them sooner would have to reach around the floor, and
   * the floor still applying is one of the things worth knowing.
   */
  const SEED = 1_600;
  const TICKS = 5_600;
  function collected(ms: number): Promise<Received[]> {
    const flow = [
      { id: "n1", type: "yonder-config-watch", interval: 2, wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    const seen: Received[] = [];
    return new Promise((resolve) => {
      void helper.load(watchNode, flow, () => {
        const sink = helper.getNode("n2") as unknown as {
          on(event: string, fn: (msg: Received) => void): void;
        };
        sink.on("input", (msg) => { seen.push(msg); });
        setTimeout(() => { resolve(seen); }, ms);
      });
    });
  }

  /**
   * The first read is the seed (R-UI-17). Waiting a poll interval for it
   * would put an empty form in front of whoever opened the console first.
   */
  it("reads the configuration on registration and sends it", async () => {
    const config = { version: 1, mavlink: { ingest: { loopback_only: true } } };
    replies.push(ok(config));
    const seen = await collected(SEED);
    expect(asked[0]).toEqual({ method: "GET", path: "/config" });
    expect(seen[0]?.payload).toEqual(config);
  });

  /**
   * **The constraint the one-shot inject existed to honour.** Ten
   * `ui-text-input` boxes hang off this. A second identical message would
   * overwrite whatever an operator had typed into one of them.
   */
  it("says nothing more while the document has not moved", { timeout: 15_000 }, async () => {
    const config = { version: 1, network: { modem: { apn: "ereseller" } } };
    for (let i = 0; i < 6; i += 1) replies.push(ok(structuredClone(config)));
    const seen = await collected(TICKS);
    expect(asked.length, "the read is supposed to repeat").toBeGreaterThan(1);
    expect(seen).toHaveLength(1);
  });

  /**
   * The defect, in the shape it was found in: the daemon accepted a change to
   * where MAVLink is accepted from, and the page had to stop saying
   * `Loopback only`.
   */
  it("sends again the moment the ingest setting moves", { timeout: 15_000 }, async () => {
    const closed = { mavlink: { ingest: { loopback_only: true } } };
    const open = { mavlink: { ingest: { loopback_only: false } } };
    replies.push(ok(closed), ok(open), ok(structuredClone(open)), ok(structuredClone(open)));
    const seen = await collected(TICKS);
    expect(seen.map((m) => (m.payload as typeof closed).mavlink.ingest.loopback_only))
      .toEqual([true, false]);
  });

  /**
   * A dropped socket must leave a form full of an operator's settings alone.
   * Blanking one looks exactly like a device that has forgotten them — which
   * is why this sends nothing rather than sending `payload: null` the way
   * `yonder-config` does for a button that is waiting on an answer.
   */
  it("sends nothing at all when the daemon does not answer", async () => {
    replies.push(unreachable, unreachable);
    const seen = await collected(SEED);
    expect(seen).toEqual([]);
  });
});
