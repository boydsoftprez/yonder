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
const addressNode = (await import("./stream-address.js")).default ?? await import("./stream-address.js");
const capturesNode = (await import("./captures.js")).default ?? await import("./captures.js");

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });
/** The daemon answering, and refusing. `ok` here is the *transport*: the
 * request reached the daemon and it said no, which is a different thing from
 * a socket that would not open. */
const refused = (status: number, body: unknown): DaemonReply => ({ ok: true, status, body });

interface Received {
  payload?: unknown;
  yonder?: { state?: string; message?: string };
  /** A refused apply's detail, by draft path — see the tests at the end. */
  problems?: { path: string; message: string }[];
  /** Which camera an answer is about. */
  camera?: string;
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

  /** The ADD key's own request — the socket, never `/dev/videoN` (R-CAM-05). */
  it("adopts the socket an ADD press names", async () => {
    replies.push(ok({ camera: "cam1", id: "a-1", expiresAt: null }));
    await send(camerasNode, "yonder-cameras", { payload: { adopt: "platform-usb-0:1.1:1.0-video-index0" } });
    expect(asked).toEqual([
      { method: "POST", path: "/cameras", body: { device: "platform-usb-0:1.1:1.0-video-index0" } },
    ]);
  });

  /**
   * **The removal key's own request** (R-CAM-21).
   *
   * The **id**, where the adoption above names the socket, and the asymmetry
   * is the point: an adoption has no entry to name yet, and a removal is very
   * often of a camera whose socket has nothing on it at all — a thing that is
   * not there cannot be addressed by where it is not.
   */
  it("removes the camera a removal press names, by id, on the address it already has", async () => {
    replies.push(ok({ camera: "cam1", id: "a-2", expiresAt: 1_000 }));
    const msg = await send(camerasNode, "yonder-cameras", { payload: { forget: "cam1" } });
    expect(asked).toEqual([{ method: "DELETE", path: "/cameras/cam1" }]);
    // Which camera the answer is about, on a message the node emitted fresh.
    expect(msg.camera).toBeUndefined();
    expect((msg.payload as { camera: string }).camera).toBe("cam1");
  });

  /**
   * A refusal is a refusal, and the node says so rather than reporting a
   * change that did not happen. The reason the operator actually reads is the
   * one on the key itself — this page reads the list again after every press,
   * so a refusal on the message is overwritten before anything draws it.
   */
  it("reports a refused removal as rejected, never as a change that took", async () => {
    replies.push(refused(409, { error: "this camera is streaming; stop it before taking it out of the configuration" }));
    const msg = await send(camerasNode, "yonder-cameras", { payload: { forget: "cam1" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.payload).toBeNull();
  });

  /** A message with neither key is still a sweep, which is what a poll sends. */
  it("sweeps the board when a message names no press at all", async () => {
    replies.push(ok({ found: [], rejected: [] }));
    await send(camerasNode, "yonder-cameras", { payload: { forget: "" } });
    expect(asked).toEqual([{ method: "GET", path: "/cameras" }]);
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

  /**
   * R-CTL-02, R-CTL-03. A different thing again from `controls`: this changes
   * what the camera *is* rather than what it is doing, so it goes through the
   * apply engine and comes back as an apply — which is why the status is
   * `applyStatus`'s and not a flat "confirmed".
   *
   * **This is what lets the Setup deck draw a countdown only where one arms.**
   * The page renders the engine's own answer, so it cannot promise a confirm
   * control that never comes or omit one that does.
   */
  it("posts a settings change, and reports a kept apply as confirmed", async () => {
    replies.push(ok({ id: "a1", expiresAt: null }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "settings", payload: { framerate: 25 }, camera: "cam0",
    });
    expect(asked).toEqual([
      { method: "POST", path: "/cameras/cam0/settings", body: { framerate: 25 } },
    ]);
    expect(msg.yonder?.state).toBe("confirmed");
    expect(msg.yonder?.message).toContain("nothing to confirm");
  });

  it("reports an apply that armed the window as pending, never as done", async () => {
    replies.push(ok({ id: "a2", expiresAt: Date.now() + 120_000 }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "settings", payload: { bitrate_kbps: 3000 }, camera: "cam0",
    });
    expect(msg.yonder?.state).toBe("pending");
    expect((msg.yonder as { id?: string }).id).toBe("a2");
  });

  it("refuses a settings message whose payload is not an object, and calls nothing", async () => {
    for (const payload of ["25", 25, null, undefined, [1, 2]]) {
      const msg = await send(cameraNode, "yonder-camera", { topic: "settings", payload, camera: "cam0" });
      expect(msg.yonder?.state, JSON.stringify(payload)).toBe("rejected");
      await helper.unload();
    }
    expect(asked).toEqual([]);
  });

  it("refuses a controls message whose payload is not an object, and calls nothing", async () => {
    for (const payload of ["bright", 100, null, undefined, [1, 2]]) {
      const msg = await send(cameraNode, "yonder-camera", { topic: "controls", payload, camera: "cam0" });
      expect(msg.yonder?.state, JSON.stringify(payload)).toBe("rejected");
      await helper.unload();
    }
    expect(asked).toEqual([]);
  });

  /**
   * **The one hop that makes a refusal usable, and it is only visible here.**
   *
   * `POST /cameras/:id/apply` answers 400 with `problems` — a message per
   * draft path — precisely so the Setup deck can mark the field the operator
   * has to change rather than showing a sentence about a form. `fetched()`
   * reduces any non-200 to a single sentence, which is right for a status
   * badge and drops the array; this node is what puts it back on the wire.
   *
   * **A component test cannot catch this**, and that is why it is here: every
   * test in `deck.component.test.ts` mocks the socket and hands the component
   * a report with `problems` already on it, so removing this pass-through
   * leaves all of them green — the same shape as a widget shipping dead
   * because `emitsActions` was missing, which only `nodes.test.ts` could see.
   *
   * `camera` travels with it because the node emits a *fresh* message: the
   * `msg.camera` that addressed it does not survive the round trip, and a
   * refusal that does not say which camera it is about can be drawn against a
   * different one.
   */
  it("carries a refused apply's problems, and the camera they are about", async () => {
    replies.push(refused(400, {
      error: "this draft cannot be applied as it stands",
      problems: [{ path: "preview.floor_kbps", message: "the floor is above the ceiling" }],
    }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "apply", payload: { previewFloor: 2000, previewCeiling: 500 }, camera: "cam0",
    });
    expect(msg.yonder?.state).toBe("rejected");
    // The daemon's own sentence, for the toast.
    expect(msg.yonder?.message).toBe("this draft cannot be applied as it stands");
    // And the detail, by path, for the field.
    expect(msg.problems).toEqual([
      { path: "preview.floor_kbps", message: "the floor is above the ceiling" },
    ]);
    expect(msg.camera).toBe("cam0");
    // Never a payload: an operator must be able to tell "nothing to show"
    // from "this never loaded", and a widget's own report must not be
    // overwritten by a refusal.
    expect(msg.payload).toBeNull();
  });

  it("carries no problems where the daemon named none, rather than an empty list", async () => {
    replies.push(refused(400, { error: "no camera is configured with the id \"cam0\"" }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "apply", payload: { previewRate: 25 }, camera: "cam0",
    });
    expect(msg.yonder?.state).toBe("rejected");
    // Absent, not `[]`: an empty list is a claim that the daemon looked and
    // found nothing wrong with any field, which is not what a 404 said.
    expect(Object.prototype.hasOwnProperty.call(msg, "problems")).toBe(false);
    expect(msg.camera).toBe("cam0");
  });

  /**
   * The browser's own report (spec §8.2). `msg.viewer` is part of the
   * address, like `msg.camera` — a report whose subject was inside its own
   * body could name a browser the route was not built for.
   */
  it("posts a viewer report to the route for that browser", async () => {
    replies.push(ok({ camera: "cam0", viewer: "1f2e3d4c", overlay: { head: "adaptive", cost: { view: "0.93 Mb/s" } } }));
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "viewer",
      camera: "cam0",
      viewer: "1f2e3d4c",
      payload: { want: "video", stats: { rtt: 38, loss: 0, egress: 900, capacity: 40_000 } },
    });
    expect(asked).toEqual([{
      method: "POST",
      path: "/cameras/cam0/viewers/1f2e3d4c",
      body: { want: "video", stats: { rtt: 38, loss: 0, egress: 900, capacity: 40_000 } },
    }]);
    expect(msg.yonder?.state).toBe("confirmed");
    expect(msg.yonder?.message).toBe("cam0: adaptive · this view 0.93 Mb/s");
  });

  it("posts an empty report, which is a reconnect asking for the state", async () => {
    replies.push(ok({ camera: "cam0", viewer: "1f2e3d4c", overlay: { head: "stills", cost: {} } }));
    await send(cameraNode, "yonder-camera", { topic: "viewer", camera: "cam0", viewer: "1f2e3d4c" });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/viewers/1f2e3d4c", body: {} }]);
  });

  it.each([["../run"], ["a/b"], [""], [7], [undefined]])(
    "refuses %o as a viewer id, because it goes straight into a path, and calls nothing",
    async (viewer) => {
      const msg = await send(cameraNode, "yonder-camera", {
        topic: "viewer", camera: "cam0", viewer, payload: { want: "video" },
      });
      expect(asked).toEqual([]);
      expect(msg.yonder?.state).toBe("rejected");
    },
  );

  it("refuses a viewer report whose payload could not be one, and calls nothing", async () => {
    const msg = await send(cameraNode, "yonder-camera", {
      topic: "viewer", camera: "cam0", viewer: "1f2e3d4c", payload: "video please",
    });
    expect(asked).toEqual([]);
    expect(msg.yonder?.state).toBe("rejected");
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

describe("yonder-stream-address", () => {
  it("asks the daemon for the finished text and never resolves a secret itself", async () => {
    // Node-RED must never read /etc/yonder/secrets.yaml. The daemon owns it;
    // this node receives text that already has the credential in it.
    replies.push(ok({ renderings: [{ kind: "url", body: "rtsp://yonder:Kx7@10.0.0.1:8554/cam0" }] }));
    const msg = await send(addressNode, "yonder-stream-address", { camera: "cam0" });
    expect(asked).toEqual([{ method: "GET", path: "/cameras/cam0/stream-address" }]);
    expect(msg.payload).toBeDefined();
  });

  it("carries the address this session arrived on, when the page knows it", async () => {
    replies.push(ok({ renderings: [] }));
    await send(addressNode, "yonder-stream-address", { camera: "cam0", address: "10.147.17.42" });
    expect(asked).toEqual([
      { method: "GET", path: "/cameras/cam0/stream-address?address=10.147.17.42" },
    ]);
  });

  /**
   * **R-UI-24 on the node's own badge.** "4 ways to receive" on a board
   * reachable only over cellular is the node saying four things work when one
   * does — which is exactly the statement this whole surface exists to stop
   * the console making. The verdict itself is `outputReach()`'s, resolved by
   * the daemon; this only counts what came back.
   */
  it("counts what can be used, not what was offered", async () => {
    const line = (kind: string, usable: boolean): Record<string, unknown> =>
      ({ kind, body: "x", usable, note: usable ? "fine" : "unusable — no" });
    replies.push(ok({
      renderings: [
        line("gstreamer", true), line("dialog", true),
        line("appsink", true), line("url", false),
      ],
    }));
    const msg = await send(addressNode, "yonder-stream-address", { camera: "cam0" });
    expect(msg.yonder?.message).toBe("3 of 4 ways to receive");
  });

  it("says four plainly when all four can be used", async () => {
    replies.push(ok({
      renderings: ["gstreamer", "dialog", "appsink", "url"]
        .map((kind) => ({ kind, body: "x", usable: true, note: "fine" })),
    }));
    const msg = await send(addressNode, "yonder-stream-address", { camera: "cam0" });
    expect(msg.yonder?.message).toBe("4 ways to receive");
  });

  /**
   * A refusal names the camera it is about, like every other camera route's
   * — the node emits a fresh message, so the `msg.camera` that addressed it
   * does not survive the round trip on its own.
   */
  it("says which camera a refusal is about", async () => {
    replies.push(refused(404, { error: 'no camera is configured with the id "cam9"' }));
    const msg = await send(addressNode, "yonder-stream-address", { camera: "cam9" });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.camera).toBe("cam9");
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

/**
 * The shutter, and the files it makes (R-CAM-17, R-CAM-18, R-STO-06).
 *
 * **The reason this node exists is a press that reached nothing.** The deck
 * has emitted `{ shutter: … }` since it was built and the route behind it
 * switched on four other keys, so RECORD and PHOTO did nothing at all, in
 * silence. So the first thing tested here is the mapping itself: which route
 * a press becomes. `flows.test.ts` holds the other half — that a press
 * reaches this node at all — because a test of one without the other is
 * exactly how that defect stayed invisible.
 */
describe("yonder-captures", () => {
  it("starts a recording, with the action in the body rather than in the route", async () => {
    replies.push(ok({ recording: true, since: 1, destination: "board", remainingSeconds: 7080, bytes: 0, ended: null }));
    const started = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "record" } });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/record", body: { action: "start" } }]);
    expect(started.yonder?.message).toBe("recording");
  });

  it("stops one on the same route, because a stop is not a second thing", async () => {
    replies.push(ok({ recording: false, since: null, destination: "board", remainingSeconds: 7000, bytes: null, ended: null }));
    const stopped = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "stop" } });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/record", body: { action: "stop" } }]);
    expect(stopped.yonder?.message).toBe("recording stopped");
  });

  /**
   * R-STO-06 is only honest if the interface can say *that is what happened*.
   * A recording the reserve ended and one the operator ended are the same
   * silence otherwise, and the operator is the one who was not there for it.
   */
  it("says why a recording ended when it ended by itself", async () => {
    replies.push(ok({
      recording: false, since: null, destination: "board", remainingSeconds: 0, bytes: null,
      ended: { at: 2, reason: "the card reached the 1024 MB reserve" },
    }));
    const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "stop" } });
    expect(msg.yonder?.message).toBe("recording ended · the card reached the 1024 MB reserve");
  });

  it("takes a still, and reports the capture it made", async () => {
    replies.push(ok({ name: "2026-09-07T14-22-05-123Z-1280x720.jpg", at: 1, bytes: 6, width: 1280, height: 720, held: "board" }));
    const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "photo" } });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/photo" }]);
    expect(msg.yonder?.message).toBe("2026-09-07T14-22-05-123Z-1280x720.jpg");
  });

  it("reads the listing for a message that asks for nothing else", async () => {
    replies.push(ok({ camera: "cam0", captures: [{ name: "a.jpg" }, { name: "b.jpg" }] }));
    const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: {} });
    expect(asked).toEqual([{ method: "GET", path: "/cameras/cam0/captures" }]);
    expect(msg.yonder?.message).toBe("2 captures");
  });

  it("deletes the capture it was named, and never a path", async () => {
    const name = "2026-09-07T14-22-05-123Z-1280x720.jpg";
    replies.push(ok({ name }));
    await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { remove: name } });
    expect(asked).toEqual([{ method: "DELETE", path: `/cameras/cam0/captures/${name}` }]);
  });

  it.each([["../../etc/shadow"], ["a/b.jpg"], [""], [7]])(
    "calls the daemon nothing at all for %p, which could not be a capture name",
    async (remove) => {
      const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { remove } });
      expect(msg.yonder?.state).toBe("rejected");
      // The guard is that nothing was asked, not that the daemon said no: a
      // string with a slash in it would address a different route entirely.
      expect(asked, "a refusal spends no round trip").toEqual([]);
    },
  );

  /**
   * A word this node does not know is a drift between the deck and the route,
   * and the honest answer is to say so — never to fall through to the listing,
   * which would answer a question nobody asked and look like it worked.
   */
  it("refuses a shutter word it does not know rather than reading the listing", async () => {
    const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "pause" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(asked).toEqual([]);
  });

  it("calls the daemon nothing when no camera is named", async () => {
    const msg = await send(capturesNode, "yonder-captures", { payload: { shutter: "photo" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(asked).toEqual([]);
  });

  it("says which camera a refusal is about", async () => {
    replies.push(refused(409, { error: "cam0 is already recording" }));
    const msg = await send(capturesNode, "yonder-captures", { camera: "cam0", payload: { shutter: "record" } });
    expect(msg.yonder?.state).toBe("rejected");
    expect(msg.camera).toBe("cam0");
  });
});
