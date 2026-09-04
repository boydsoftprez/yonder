// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import helper from "node-red-node-test-helper";
import type { DaemonClient, DaemonReply, DaemonRequest } from "yonder-core";

/**
 * The camera nodes, in a real Node-RED.
 *
 * **No test opens a socket.** `clientFor` is mocked so each node gets a client
 * that answers from a script. What is under test is the adapter: the route it
 * calls, the message it emits, and — the part that matters most — that it
 * decides nothing of its own. Every camera decision lives in `yonder-core`,
 * where it is tested without a Node-RED and without a camera.
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

const camerasNode = (await import("./cameras.js")).default ?? await import("./cameras.js");
const cameraNode = (await import("./camera.js")).default ?? await import("./camera.js");
const streamNode = (await import("./stream.js")).default ?? await import("./stream.js");
const receiveNode = (await import("./receive-line.js")).default ?? await import("./receive-line.js");

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });

interface Received {
  payload?: unknown;
  yonder?: { state?: string; message?: string };
}

/** Copied from the network package: load one node, send it a message, read the output. */
function send(node: unknown, type: string, message: Record<string, unknown> = {}): Promise<Received> {
  const flow = [{ id: "n1", type, wires: [["n2"]] }, { id: "n2", type: "helper" }];
  return new Promise((resolve, reject) => {
    void helper.load(node, flow, () => {
      const sink = helper.getNode("n2") as unknown as { on(e: string, f: (m: Received) => void): void };
      sink.on("input", (msg) => { resolve(msg); });
      (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive(message);
      setTimeout(() => { reject(new Error(`no message from ${type}`)); }, 4_000);
    });
  });
}

beforeAll((): Promise<void> => new Promise((r) => { void helper.startServer(r); }));
afterAll((): Promise<void> => new Promise((r) => { void helper.stopServer(r); }));
afterEach(async () => { await helper.unload(); replies.length = 0; asked.length = 0; });

describe("yonder-cameras", () => {
  it("reads the detection, rejections included", async () => {
    replies.push(ok({ found: [{ id: "cam0", summary: "aim: none · zoom: yes" }], rejected: [{ reason: "decoder" }] }));
    const msg = await send(camerasNode, "yonder-cameras");
    expect(asked).toEqual([{ method: "GET", path: "/cameras" }]);
    expect((msg.payload as { rejected: unknown[] }).rejected).toHaveLength(1);
  });

  it("emits a rejected state rather than nothing when the daemon is down", async () => {
    const msg = await send(camerasNode, "yonder-cameras");
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.payload).toBeNull();
    // The transport's own message is a socket path and an errno. It is detail
    // for a journal, and it never reaches a page.
    expect(JSON.stringify(msg)).not.toContain("no reply scripted");
  });
});

describe("yonder-camera", () => {
  it("reads settings back from the daemon rather than echoing what was sent", async () => {
    // R-CTL-10, and the spec leans on it harder than the wording implies: a
    // control shows what the camera reports, never what was sent.
    replies.push(ok({ id: "cam0", settings: { brightness: 128 } }));
    const msg = await send(cameraNode, "yonder-camera", { payload: { brightness: 200 }, camera: "cam0" });
    expect((msg.payload as { settings: { brightness: number } }).settings.brightness).toBe(128);
    // One request, and it is a read. The settings in the message are not sent
    // anywhere: a camera's settings live in config.yaml and change through
    // yonder-apply, so they inherit the confirmation window.
    expect(asked).toEqual([{ method: "GET", path: "/cameras/cam0" }]);
  });

  it("re-probes that one camera for the Setup deck's Re-probe key", async () => {
    replies.push(ok({ camera: { id: "cam0" }, run: { state: "stopped" } }));
    await send(cameraNode, "yonder-camera", { topic: "probe", camera: "cam0" });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/probe" }]);
  });

  /**
   * R-CTL-04, R-CTL-05: the one topic that writes anything, and even this one
   * writes nothing to config.yaml — it is `POST /cameras/:id/controls`, the
   * live route, never `yonder-apply`. `msg.topic` must say so explicitly: a
   * plain input carrying a payload stays a read (the test above), so a flow
   * cannot change a camera's controls by accident.
   */
  it("posts a control change for the camera the message names", async () => {
    replies.push(ok({
      applied: { brightness: 64 },
      refused: [],
      clamped: [{ control: "brightness", requested: 100, sent: 64 }],
      current: { brightness: { state: "present", value: { current: 64 } } },
    }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "controls", payload: { brightness: 100 }, camera: "cam0",
    });
    expect(asked).toEqual([
      { method: "POST", path: "/cameras/cam0/controls", body: { brightness: 100 } },
    ]);
    expect((msg.payload as { applied: Record<string, number> }).applied).toEqual({ brightness: 64 });
  });

  it("refuses a controls message whose payload is not an object, and calls nothing", async () => {
    for (const payload of ["bright", 100, null, undefined, [1, 2]]) {
      const msg = await send(cameraNode, "yonder-camera", { topic: "controls", payload, camera: "cam0" });
      expect(msg.yonder?.state, JSON.stringify(payload)).toBe("rejected");
      await helper.unload();
    }
    expect(asked).toEqual([]);
  });

  it("takes the camera from the node when the message names none", async () => {
    replies.push(ok({ camera: { id: "nose" }, run: { state: "stopped" } }));
    const flow = [
      { id: "n1", type: "yonder-camera", camera: "nose", wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    await new Promise<void>((resolve, reject) => {
      void helper.load(cameraNode, flow, () => {
        const sink = helper.getNode("n2") as unknown as { on(e: string, f: () => void): void };
        sink.on("input", () => { resolve(); });
        (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive({});
        setTimeout(() => { reject(new Error("no message from yonder-camera")); }, 4_000);
      });
    });
    expect(asked).toEqual([{ method: "GET", path: "/cameras/nose" }]);
  });

  it("says so, and calls nothing, when nothing named a camera", async () => {
    const msg = await send(cameraNode, "yonder-camera", {});
    expect(msg.yonder?.state).toBe("rejected");
    expect(String(msg.yonder?.message)).toMatch(/not pointed at a camera/i);
    expect(asked).toEqual([]);
  });
});

describe("yonder-stream", () => {
  it("puts a command state on msg.yonder, like every other node", async () => {
    // ADR-0005: one command-state language, so a control means the same thing
    // on every page. A node inventing its own status text is the drift that
    // language was written to prevent.
    replies.push(ok({ state: "starting" }));
    const msg = await send(streamNode, "yonder-stream", { payload: "start", camera: "cam0" });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/run", body: { action: "start" } }]);
    expect(msg.yonder?.state).toBeDefined();
    expect(String(msg.yonder?.message)).toContain("starting");
  });

  it("stops the camera the message names", async () => {
    replies.push(ok({ state: "stopped" }));
    await send(streamNode, "yonder-stream", { payload: "stop", camera: "cam0" });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/run", body: { action: "stop" } }]);
  });

  /**
   * The brief for this task asserted `msg.yonder.message` contained the word
   * "unreachable". It cannot, and the reason is worth keeping: `fetched()` in
   * `yonder-core` deliberately drops the transport's own message — a socket
   * path and an errno — and answers in Yonder's words, the same words every
   * node in both packages uses. Making this one node say something else is
   * exactly the drift ADR-0005's single command-state language forbids. So the
   * assertion is on what the message must *convey* — the device is not
   * answering, and this was not a stop — plus the stronger half the original
   * did not have: that nothing from the transport got through.
   */
  it("reports a daemon that is not answering, rather than claiming a stop", async () => {
    const msg = await send(streamNode, "yonder-stream", { payload: "stop", camera: "cam0" });
    expect(msg.yonder?.state).not.toBe("ok");
    expect(msg.yonder?.state).toBe("rejected");
    expect(String(msg.yonder?.message)).toMatch(/not answering/i);
    expect(JSON.stringify(msg)).not.toContain("no reply scripted");
  });

  it("refuses an action that is neither start nor stop, and calls nothing", async () => {
    for (const payload of ["restart", "", 1, undefined]) {
      const msg = await send(streamNode, "yonder-stream", { payload, camera: "cam0" });
      expect(msg.yonder?.state, JSON.stringify(payload)).toBe("rejected");
      await helper.unload();
    }
    expect(asked).toEqual([]);
  });
});

describe("yonder-receive-line", () => {
  it("asks the daemon for the finished text and never resolves a secret itself", async () => {
    // Node-RED must never read /etc/yonder/secrets.yaml. The daemon owns it;
    // this node receives text that already has the credential in it.
    replies.push(ok({ renderings: [{ kind: "url", body: "rtsp://yonder:Kx7@10.0.0.1:8554/cam0" }] }));
    const msg = await send(receiveNode, "yonder-receive-line", { camera: "cam0" });
    expect(asked).toEqual([{ method: "GET", path: "/cameras/cam0/receive-line" }]);
    expect(msg.payload).toBeDefined();
  });

  it("carries the address this session arrived on, when the page knows it", async () => {
    replies.push(ok({ renderings: [] }));
    await send(receiveNode, "yonder-receive-line", { camera: "cam0", address: "10.147.17.42" });
    expect(asked).toEqual([
      { method: "GET", path: "/cameras/cam0/receive-line?address=10.147.17.42" },
    ]);
  });

  /**
   * The invariant, made structural rather than trusted.
   *
   * The daemon owns `secrets.yaml` at `0600` and hands back finished text —
   * that is the whole reason the rendering lives in `yonder-core`. A node that
   * grew a filesystem read would be a second place a credential could escape
   * from (R-SEC-10), and this is what would notice.
   */
  it("has no filesystem access anywhere in the package", () => {
    const src = dirname(fileURLToPath(import.meta.url));
    for (const entry of readdirSync(src)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      // Comments stripped first: the files that must not *read* secrets.yaml
      // are the ones that explain at length why they do not.
      const code = readFileSync(join(src, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, entry).not.toMatch(/node:fs|["']fs["']|readFileSync|secrets\.yaml/);
    }
  });
});
