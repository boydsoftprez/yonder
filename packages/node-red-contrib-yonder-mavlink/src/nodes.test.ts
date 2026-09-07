// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import helper from "node-red-node-test-helper";
import type { DaemonClient, DaemonReply, DaemonRequest } from "yonder-core";

/**
 * The nodes, in a real Node-RED — mirroring
 * `node-red-contrib-yonder-system`'s own `nodes.test.ts`.
 *
 * **No test opens a socket.** `clientFor` is mocked so a node gets a client
 * that answers from a script. Everything the daemon decides — `pathCheck`,
 * `LinkTracker`, `MavlinkRenderer` — is tested in `yonder-core`, without a
 * Node-RED at all; what belongs here is whether each node asks the right
 * question and reports the right thing when the daemon does not answer.
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
const stateNode = (await import("./state.js")).default;
const endpointsNode = (await import("./endpoints.js")).default;
const runNode = (await import("./run.js")).default;
const checkNode = (await import("./check.js")).default;

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
const noTelemetry: DaemonReply = {
  ok: true, status: 503, body: { error: "this device has no telemetry layer; see the device journal for the reason" },
};
const unreachable: DaemonReply = {
  ok: false, reason: "unreachable", message: "connect ENOENT /run/yonder/core.sock",
};

interface Received { payload?: unknown; yonder?: { state?: string; message?: string } }

/** Load a flow and wait for the first message the node under test sends. */
function firstMessage(node: unknown, type: string, extra: Record<string, unknown> = {}): Promise<Received> {
  const flow = [
    { id: "n1", type, wires: [["n2"]], ...extra },
    { id: "n2", type: "helper" },
  ];
  return new Promise((resolve, reject) => {
    void helper.load(node, flow, () => {
      const sink = helper.getNode("n2") as unknown as { on(event: string, fn: (msg: Received) => void): void };
      sink.on("input", (msg) => { resolve(msg); });
      const input = helper.getNode("n1") as unknown as { receive?(msg: unknown): void };
      input.receive?.({ payload: extra.payload });
      setTimeout(() => { reject(new Error(`no message from ${type}`)); }, 4_000);
    });
  });
}

const linkState = {
  phase: "linked", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1,
  heartbeatHz: 1, lastHeardMs: 400, groundStations: [], triedBauds: [], traffic: null, tcpClients: null,
};

beforeAll((): Promise<void> => new Promise((resolve) => { void helper.startServer(resolve); }));
afterAll((): Promise<void> => new Promise((resolve) => { void helper.stopServer(resolve); }));
afterEach(async () => {
  await helper.unload();
  replies.length = 0;
  asked.length = 0;
});

describe("yonder-mav-state", () => {
  it("reads GET /mav/state and shapes it through stateMessage", async () => {
    replies.push(ok({ link: linkState, telemetryRunning: true, routerRunning: true }));
    const msg = await firstMessage(stateNode, "yonder-mav-state");
    expect(asked[0]).toMatchObject({ method: "GET", path: "/mav/state" });
    expect((msg.payload as { port?: unknown })?.port).toBe("/dev/ttyAMA0");
    expect((msg.payload as { link?: unknown })?.link).toEqual({ state: "confirmed", message: "Connected" });
  });

  /** R-UI-05: a read that failed is reported, never left silent. */
  it("emits a rejected state when there is no telemetry layer on this build", async () => {
    replies.push(noTelemetry);
    const msg = await firstMessage(stateNode, "yonder-mav-state");
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.payload).toBeNull();
  });

  it("does not put the transport's own message on the page", async () => {
    replies.push(unreachable);
    const msg = await firstMessage(stateNode, "yonder-mav-state");
    expect(JSON.stringify(msg)).not.toContain("ENOENT");
    expect(JSON.stringify(msg)).not.toContain("core.sock");
  });
});

describe("yonder-mav-check", () => {
  it("reads GET /mav/check and draws the chain", async () => {
    replies.push(ok({
      autopilot: { ok: true, detail: "Heartbeat at 1.0 Hz, 57600 baud" },
      outbound: { ok: null, detail: "Nothing to send" },
      inbound: { ok: null, detail: "Not checked" },
    }));
    const msg = await firstMessage(checkNode, "yonder-mav-check");
    expect(asked[0]).toMatchObject({ method: "GET", path: "/mav/check" });
    expect((msg.payload as { autopilot?: unknown })?.autopilot).toBe("OK · Heartbeat at 1.0 Hz, 57600 baud");
    expect((msg.payload as { outbound?: unknown })?.outbound).toBe("— · Nothing to send");
  });

  it("emits a rejected state when the daemon is down", async () => {
    replies.push(unreachable);
    const msg = await firstMessage(checkNode, "yonder-mav-check");
    expect(msg.yonder?.state).toBe("rejected");
  });
});

describe("yonder-mav-endpoints", () => {
  it("seeds the host/port boxes from the configuration it is handed", async () => {
    const flow = [
      { id: "n1", type: "yonder-mav-endpoints", wires: [["h0"], ["h0"], ["p0"], [], [], [], []] },
      { id: "h0", type: "helper" },
    ];
    await new Promise<void>((resolve) => {
      void helper.load(endpointsNode, flow, () => { resolve(); });
    });
    const facts = await new Promise((resolve) => {
      const sink = helper.getNode("h0") as unknown as { on(event: string, fn: (msg: unknown) => void): void };
      sink.on("input", resolve);
      (helper.getNode("n1") as unknown as { receive(msg: unknown): void }).receive({
        payload: {
          version: 1,
          mavlink: {
            autocast: true,
            ingest: { loopback_only: true },
            tcp_server: { enabled: true, port: 5760 },
            endpoints: [{ name: "gcs0", host: "192.168.191.40", port: 14550 }],
          },
        },
      });
    });
    expect((facts as { payload: { atboot: string } }).payload.atboot).toBe("Automatic");
  });

  it("holds no daemon client of its own — it never calls the daemon", async () => {
    const flow = [{ id: "n1", type: "yonder-mav-endpoints", wires: [[], [], [], [], [], [], []] }];
    await new Promise<void>((resolve) => { void helper.load(endpointsNode, flow, () => { resolve(); }); });
    (helper.getNode("n1") as unknown as { receive(msg: unknown): void }).receive({ payload: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual([]);
  });
});

describe("yonder-mav-run", () => {
  it("toggle: reads current state, then starts when telemetry is not running", async () => {
    replies.push(
      ok({ link: linkState, telemetryRunning: false, routerRunning: true }),
      ok({ link: linkState, telemetryRunning: true, routerRunning: true }),
    );
    const msg = await firstMessage(runNode, "yonder-mav-run", { action: "toggle" });
    expect(asked[0]).toMatchObject({ method: "GET", path: "/mav/state" });
    expect(asked[1]).toMatchObject({ method: "POST", path: "/mav/start" });
    expect((msg.payload as { running?: unknown })?.running).toEqual({ state: "confirmed", message: "Running" });
  });

  it("toggle: stops when telemetry is currently running — never routerRunning's answer", async () => {
    replies.push(
      // routerRunning true and telemetryRunning true — a `!routerRunning`
      // toggle would also read "not running" here and start it again, which
      // is exactly the bug the plan names.
      ok({ link: linkState, telemetryRunning: true, routerRunning: true }),
      ok({ link: { ...linkState, phase: "stopped" }, telemetryRunning: false, routerRunning: true }),
    );
    await firstMessage(runNode, "yonder-mav-run", { action: "toggle" });
    expect(asked[1]).toMatchObject({ method: "POST", path: "/mav/stop" });
  });

  it("an explicit action skips the state read entirely", async () => {
    replies.push(ok({ link: linkState, telemetryRunning: true, routerRunning: true }));
    await firstMessage(runNode, "yonder-mav-run", { action: "start" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ method: "POST", path: "/mav/start" });
  });

  it("detect: posts to /mav/detect and names what the sweep found", async () => {
    replies.push(ok({
      link: linkState, telemetryRunning: true, routerRunning: true,
      outcome: { kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 },
    }));
    const msg = await firstMessage(runNode, "yonder-mav-run", { action: "detect" });
    expect(asked[0]).toMatchObject({ method: "POST", path: "/mav/detect" });
    expect((msg.payload as { outcome?: unknown })?.outcome).toBe("ArduPlane found on /dev/ttyAMA0 at 57 600 baud");
  });

  it("emits a rejected state when the toggle's own state read fails, and posts nothing", async () => {
    replies.push(unreachable);
    const msg = await firstMessage(runNode, "yonder-mav-run", { action: "toggle" });
    expect(msg.yonder?.state).toBe("rejected");
    expect(asked).toHaveLength(1);
  });

  it("emits a rejected state when the action itself is refused", async () => {
    replies.push(unreachable);
    const msg = await firstMessage(runNode, "yonder-mav-run", { action: "start" });
    expect(msg.yonder?.state).toBe("rejected");
  });
});
