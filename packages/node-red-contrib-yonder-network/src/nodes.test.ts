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

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
const unreachable: DaemonReply = {
  ok: false, reason: "unreachable", message: "connect ENOENT /run/yonder/core.sock",
};

interface Received {
  payload?: unknown;
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
    expect(msg.yonder?.message).toContain("access point is going away");
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
