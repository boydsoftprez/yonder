// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import helper from "node-red-node-test-helper";
import type { DaemonClient, DaemonReply, DaemonRequest } from "yonder-core";

/**
 * The nodes, in a real Node-RED.
 *
 * **No test opens a socket.** `clientFor` is mocked so the node gets a client
 * that answers from a script — which is also what keeps these tests about the
 * adapter rather than about the daemon. Everything the daemon decides is
 * tested in `yonder-core`, where it is tested without a Node-RED at all.
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

// Imported after the mock, so the nodes pick it up.
const statusNode = (await import("./status.js")).default ?? await import("./status.js");
const activityNode = (await import("./activity.js")).default ?? await import("./activity.js");
const diagNode = (await import("./diag.js")).default ?? await import("./diag.js");
const themeNode = (await import("./theme.js")).default ?? await import("./theme.js");

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
const unreachable: DaemonReply = {
  ok: false, reason: "unreachable", message: "connect ENOENT /run/yonder/core.sock",
};

interface Received { payload?: unknown; yonder?: { state?: string; message?: string } }

/** Load a flow and wait for the first message the node sends. */
function firstMessage(node: unknown, type: string, extra: Record<string, unknown> = {}): Promise<Received> {
  const flow = [
    { id: "n1", type, wires: [["n2"]], ...extra },
    { id: "n2", type: "helper" },
  ];
  return new Promise((resolve, reject) => {
    void helper.load(node, flow, () => {
      const sink = helper.getNode("n2") as unknown as {
        on(event: string, fn: (msg: Received) => void): void;
      };
      sink.on("input", (msg) => { resolve(msg); });
      const input = helper.getNode("n1") as unknown as { receive?(msg: unknown): void };
      // Polling nodes read once on registration; input-driven ones need a
      // message. Sending one to a polling node is harmless — it reads again.
      input.receive?.({ payload: extra.payload });
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

describe("yonder-status", () => {
  it("emits what the daemon said about the board", async () => {
    const facts = { facts: { model: "Raspberry Pi 4 Model B Rev 1.5" }, versions: { yonder: "0.1.0", os: "Debian" } };
    replies.push(ok(facts), ok(facts));
    const msg = await firstMessage(statusNode, "yonder-status", { interval: 5 });
    expect(msg.payload).toEqual(facts);
    expect(asked[0]).toMatchObject({ method: "GET", path: "/system" });
  });

  /**
   * The property every node in both packages has to have. An operator looking
   * at a blank panel cannot tell "there is nothing to show" from "this never
   * loaded", and the second is the one they have to act on (R-UI-05).
   */
  it("emits a rejected state rather than nothing when the daemon is down", async () => {
    replies.push(unreachable, unreachable);
    const msg = await firstMessage(statusNode, "yonder-status", { interval: 5 });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.payload).toBeNull();
  });

  /** A transport error names a socket path and an errno. Neither belongs on a page. */
  it("does not put the transport's own message on the page", async () => {
    replies.push(unreachable, unreachable);
    const msg = await firstMessage(statusNode, "yonder-status", { interval: 5 });
    expect(JSON.stringify(msg)).not.toContain("ENOENT");
    expect(JSON.stringify(msg)).not.toContain("core.sock");
  });
});

describe("yonder-activity", () => {
  it("emits the entries and nothing else", async () => {
    const page = {
      entries: [{ seq: 1, at: 0, level: "info", message: "the access point is up" }],
      oldestSeq: 1, newestSeq: 1, discarded: 0,
    };
    replies.push(ok(page), ok(page));
    const msg = await firstMessage(activityNode, "yonder-activity", { interval: 5 });
    expect(msg.payload).toEqual(page.entries);
  });

  /**
   * The cursor is what makes this usable on a slow link (R-UI-06): the whole
   * buffer once, and a few lines after that.
   */
  it("advances the cursor, so a second read asks only for what is new", async () => {
    replies.push(
      ok({ entries: [{ seq: 1, at: 0, level: "info", message: "one" }], oldestSeq: 1, newestSeq: 1, discarded: 0 }),
      ok({ entries: [{ seq: 2, at: 0, level: "info", message: "two" }], oldestSeq: 1, newestSeq: 2, discarded: 0 }),
    );
    await firstMessage(activityNode, "yonder-activity", { interval: 5 });
    // The registration read and the input-driven read both happened.
    expect(asked[0]?.path).toBe("/log?since=0");
    expect(asked.length).toBeGreaterThan(1);
    expect(asked[asked.length - 1]?.path).toMatch(/^\/log\?since=\d+$/);
  });
});

describe("yonder-diag", () => {
  it("probes reachability without being given a host", async () => {
    replies.push(ok({ host: "1.1.1.1", reachable: true, transmitted: 2, received: 2, rttMs: 9.1 }));
    const msg = await firstMessage(diagNode, "yonder-diag", { probe: "reachable" });
    expect(msg.payload).toMatchObject({ reachable: true });
    expect(asked[0]).toMatchObject({ method: "GET", path: "/diag/reachable" });
  });

  it("sends the host it was given to the route that validates it", async () => {
    replies.push(ok({ host: "example.com", reachable: false, transmitted: 3, received: 0, rttMs: null }));
    const msg = await firstMessage(diagNode, "yonder-diag", { probe: "ping", payload: "example.com" });
    expect(msg.payload).toMatchObject({ reachable: false });
    expect(asked[0]).toMatchObject({ method: "POST", path: "/diag/ping" });
    expect(asked[0]?.body).toMatchObject({ host: "example.com" });
  });

  /**
   * A probe that did not run and a host that did not answer are different
   * facts, and the operator has to be able to tell them apart.
   */
  it("emits a rejected state when the probe could not be run", async () => {
    replies.push({ ok: true, status: 400, body: { error: "host must be a host name or an IPv4 address" } });
    const msg = await firstMessage(diagNode, "yonder-diag", { probe: "ping", payload: "not a host" });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.yonder?.message).toContain("host name");
  });

  /** Yonder does not contact anything off this device on its own. */
  it("runs nothing until a message arrives", async () => {
    const flow = [{ id: "n1", type: "yonder-diag", probe: "reachable", wires: [[]] }];
    await new Promise<void>((resolve) => { void helper.load(diagNode, flow, resolve); });
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]);
  });
});

/**
 * `yonder-theme` — R-UI-07.
 *
 * It exists because the wiring it replaced could not be right. Two `change`
 * nodes cached the configuration in `flow.yonderConfig` and assigned
 * `payload.ui.theme` through a reference to it, so choosing a theme mutated
 * the cache in place whether or not the apply was confirmed — and a deploy
 * that happened while the daemon was down left the control broken until
 * someone refreshed a different page. This node caches nothing.
 */
describe("yonder-theme", () => {
  it("posts the bare string a dropdown sends", async () => {
    replies.push(ok({ id: "a1", expiresAt: Date.now() + 120_000 }));
    await firstMessage(themeNode, "yonder-theme", { payload: "night" });
    expect(asked[0]).toMatchObject({ method: "POST", path: "/ui/theme", body: { theme: "night" } });
  });

  it("posts the object a form sends", async () => {
    replies.push(ok({ id: "a2", expiresAt: Date.now() + 120_000 }));
    await firstMessage(themeNode, "yonder-theme", { payload: { theme: "day" } });
    expect(asked[0]).toMatchObject({ body: { theme: "day" } });
  });

  it("reads no configuration of its own", async () => {
    replies.push(ok({ id: "a3", expiresAt: Date.now() + 120_000 }));
    await firstMessage(themeNode, "yonder-theme", { payload: "night" });
    // One request, and it is the write. Anything that fetched the
    // configuration first would be caching it again.
    expect(asked).toHaveLength(1);
    expect(asked.map((a) => a.path)).not.toContain("/config");
  });

  it("emits a pending state carrying the apply, not a bare acknowledgement", async () => {
    replies.push(ok({ id: "a4", expiresAt: Date.now() + 120_000 }));
    const msg = await firstMessage(themeNode, "yonder-theme", { payload: "night" });
    expect(msg.yonder?.state).toBe("pending");
  });

  it("emits a rejected state rather than nothing when the daemon is down", async () => {
    replies.push(unreachable);
    const msg = await firstMessage(themeNode, "yonder-theme", { payload: "night" });
    expect(msg.yonder?.state).toBe("rejected");
  });
});
