// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Pocket2Device, type FunctionFsHelper } from "./linux.js";
import { AOA_COMMAND_ROUTE, encodeAoaEnvelope } from "./aoa.js";
import { encodeDuml } from "./duml.js";

class FakeHelper implements FunctionFsHelper {
  messages: Record<string, any>[] = [];
  stopped = false;
  constructor(readonly event: (message: Record<string, any>) => void) {}
  send(message: Record<string, any>): void { this.messages.push(message); }
  async close(): Promise<void> { this.stopped = true; }
  emit(message: Record<string, any>): void { this.event(message); }
}
let devices: Pocket2Device[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await Promise.all(devices.map(d => d.close())); devices = []; vi.useRealTimers(); });
function fixture() {
  const children: FakeHelper[] = [];
  const onCommand = vi.fn();
  const device = new Pocket2Device({ controller: "fe980000.usb", now: () => Date.now(), onCommand,
    helperFactory: (event) => { const helper = new FakeHelper(event); children.push(helper); return helper; } });
  devices.push(device);
  return { device, children, onCommand };
}
async function live(f: ReturnType<typeof fixture>) {
  await f.device.start();
  const h = f.children.at(-1)!;
  h.emit({ type: "ready" });
  for (const [index, text] of [[0, "DJI"], [1, "HG211"]] as const) {
    h.emit({ type: "setup", id: index + 1, stage: "phone", setup: { requestType: 64, request: 52, value: 0, index, length: text.length + 1 } });
    h.emit({ type: "control-data", id: index + 1, data: Buffer.from(text + "\0").toString("base64") });
  }
  h.emit({ type: "setup", id: 3, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  h.emit({ type: "control-done", id: 3 });
  h.emit({ type: "event", stage: "accessory", event: "ENABLE" });
  h.emit({ type: "data", data: Buffer.from(encodeAoaEnvelope(AOA_COMMAND_ROUTE, encodeDuml({ commandSet: 2, commandId: 128, sequence: 7, ack: 0 }))).toString("base64") });
  return h;
}
it("prepares both descriptors before phone binding and verifies live identity through real protocol", async () => {
  const f = fixture(); const h = await live(f);
  expect(h.messages[0]).toMatchObject({ type: "prepare", controller: "fe980000.usb" });
  expect(h.messages[0].stages.map((s: any) => s.productId)).toEqual(["4ee1", "2d00"]);
  expect(h.messages.some(m => m.type === "bind" && m.stage === "accessory")).toBe(true);
  expect(f.device.snapshot()).toMatchObject({ state: "live", identity: "pocket2:fe980000.usb", manufacturer: "DJI", model: "HG211" });
  expect(f.onCommand).toHaveBeenCalledOnce();
});
it("stalls unknown OUT before reading its control data", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "setup", id: 9, stage: "phone", setup: { requestType: 64, request: 99, value: 0, index: 0, length: 12 } });
  expect(h.messages.at(-1)).toEqual({ type: "control", id: 9, action: "stall" });
});
it("retires active canceled writes, forwards the absolute deadline, and never replays queued commands", async () => {
  const f = fixture(); const h = await live(f); const abort = new AbortController();
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12 }, { signal: abort.signal, deadline: Date.now() + 100 });
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.messages.at(-1)).toMatchObject({ type: "write", deadline: Date.now() + 100 });
  abort.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.stopped).toBe(true);
  expect(f.device.snapshot().state).toBe("detached-backoff");
  await vi.advanceTimersByTimeAsync(44_999); expect(f.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.children).toHaveLength(2);
  expect(f.children[1].messages.map(m => m.type)).toEqual(["prepare"]);
});
it("expires blocked writes even when the camera is silent", async () => {
  const f = fixture(); const h = await live(f);
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12 }, { deadline: Date.now() + 80 });
  const rejected = expect(pending).rejects.toThrow(/deadline/);
  await vi.advanceTimersByTimeAsync(80); await rejected; expect(h.stopped).toBe(true);
});
it("uses valid inbound traffic for liveness and cancels the detached retry on close", async () => {
  const f = fixture(); const h = await live(f);
  // Acknowledge session opening/keepalive writes without producing inbound camera traffic.
  const original = h.send.bind(h); h.send = m => { original(m); if (m.type === "write") queueMicrotask(() => h.emit({ type: "written", id: m.id })); };
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.stopped).toBe(true); expect(f.device.snapshot().state).toBe("detached-backoff");
  await f.device.close(); await vi.advanceTimersByTimeAsync(60_000); expect(f.children).toHaveLength(1);
});
it("reports missing peripheral mode and rejects commands while unready", async () => {
  const f = fixture(); await f.device.start();
  f.children[0].emit({ type: "error", code: "unavailable", message: "no peripheral controller" });
  expect(f.device.snapshot()).toMatchObject({ state: "unavailable", reason: "no peripheral controller" });
  await expect(f.device.sendCommand({ commandSet: 4, commandId: 12 })).rejects.toThrow(/live/);
});
it("does not bind accessory for an unverified camera", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0]; h.emit({ type: "ready" });
  h.emit({ type: "setup", id: 1, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  expect(h.messages.at(-1)).toMatchObject({ type: "control", action: "stall" });
  h.emit({ type: "control-done", id: 1 });
  expect(h.messages.filter(m => m.type === "bind").map(m => m.stage)).toEqual(["phone"]);
});
it("waits for actual write completion and invalidates old child events after disconnect", async () => {
  const f = fixture(); const h = await live(f);
  let finished = false;
  const command = f.device.sendCommand({ commandSet: 2, commandId: 42 }).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(false);
  h.emit({ type: "written", id: h.messages.at(-1)!.id });
  await command; expect(finished).toBe(true);
  h.emit({ type: "event", stage: "accessory", event: "DISABLE" });
  await vi.advanceTimersByTimeAsync(0);
  h.emit({ type: "ready" });
  expect(f.device.snapshot().state).toBe("detached-backoff");
});
it("preserves camera video timestamps", async () => {
  const frames: any[] = []; let helper!: FakeHelper;
  const device = new Pocket2Device({ controller: "test.udc", now: () => Date.now(), onVideo: frame => frames.push(frame), helperFactory: event => helper = new FakeHelper(event) });
  devices.push(device);
  const f = { device, children: [] as FakeHelper[], onCommand: vi.fn() };
  await device.start(); f.children.push(helper);
  await live(f);
  const record = Buffer.from("000001ff0500ff00901162002a0000000000000165", "hex");
  const { AOA_VIDEO_ROUTE } = await import("./aoa.js");
  helper.emit({ type: "data", data: Buffer.from(encodeAoaEnvelope(AOA_VIDEO_ROUTE, record)).toString("base64") });
  expect(frames[0]).toMatchObject({ timestamp: 42, data: Uint8Array.from([0, 0, 0, 1, 0x65]) });
});

it("bounds fragmented helper IPC, rejects malformed data, and waits for its own child", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { NdjsonFunctionFsHelper } = await import("./linux.js");
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 0, null)); return true; });
  const event = vi.fn();
  const helper = new NdjsonFunctionFsHelper(event, { spawn: (() => child) as any });
  child.stdout.write('{"type":"rea'); child.stdout.write('dy"}\n');
  expect(event).toHaveBeenCalledWith({ type: "ready" });
  child.stdout.write('x'.repeat(24_001));
  expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/large/) }));
  await helper.close(); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
it("does not hide failure to clean an owned helper or automatically reuse that controller", async () => {
  const f = fixture(); const h = await live(f);
  h.close = async () => { throw new Error("cleanup failed"); };
  h.emit({ type: "event", stage: "accessory", event: "DISABLE" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.device.snapshot()).toMatchObject({ state: "fault", reason: expect.stringMatching(/cleanup incomplete/) });
  await vi.advanceTimersByTimeAsync(60_000); expect(f.children).toHaveLength(1);
  await expect(f.device.close()).rejects.toThrow(/cleanup/);
  devices = devices.filter(device => device !== f.device);
});
it("ships its executable Python helper through the existing core asset copier", async () => {
  const { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } = await import("node:fs");
  const { FUNCTIONFS_HELPER_PATH } = await import("./linux.js");
  const { execFileSync } = await import("node:child_process");
  expect(existsSync(FUNCTIONFS_HELPER_PATH)).toBe(true);
  expect(readFileSync(FUNCTIONFS_HELPER_PATH, "utf8").startsWith("#!/usr/bin/env python3\n")).toBe(true);
  expect(statSync(FUNCTIONFS_HELPER_PATH).mode & 0o111).not.toBe(0);
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.scripts.build).toContain("scripts/copy-assets.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "yonder-helper-assets-"));
  try {
    mkdirSync(join(scratch, "scripts")); mkdirSync(join(scratch, "dist"));
    mkdirSync(join(scratch, "src/video/accessory/assets"), { recursive: true });
    copyFileSync("scripts/copy-assets.mjs", join(scratch, "scripts/copy-assets.mjs"));
    copyFileSync(FUNCTIONFS_HELPER_PATH, join(scratch, "src/video/accessory/assets/functionfs.py"));
    execFileSync("node", [join(scratch, "scripts/copy-assets.mjs")]);
    const installed = join(scratch, "dist/video/accessory/assets/functionfs.py");
    expect(readFileSync(installed)).toEqual(readFileSync(FUNCTIONFS_HELPER_PATH));
    execFileSync("python3", ["-c", "import sys; compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')", installed]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
it("never promotes an enabled but silent or malformed stream to live", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0]; h.emit({ type: "ready" });
  for (const [index, text] of [[0, "DJI"], [1, "HG211"]] as const) {
    h.emit({ type: "setup", id: index + 1, stage: "phone", setup: { requestType: 64, request: 52, value: 0, index, length: text.length + 1 } });
    h.emit({ type: "control-data", id: index + 1, data: Buffer.from(text + "\0").toString("base64") });
  }
  h.emit({ type: "setup", id: 3, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  h.emit({ type: "control-done", id: 3 });
  h.emit({ type: "event", stage: "accessory", event: "ENABLE" });
  h.emit({ type: "data", data: Buffer.from("junk").toString("base64") });
  expect(f.device.snapshot().state).toBe("accessory");
  await expect(f.device.sendCommand({ commandSet: 4, commandId: 12 })).rejects.toThrow(/live/);
  const original = h.send.bind(h); h.send = m => { original(m); if (m.type === "write") queueMicrotask(() => h.emit({ type: "written", id: m.id })); };
  await vi.advanceTimersByTimeAsync(3_000);
  expect(h.stopped).toBe(true); expect(f.device.snapshot().state).toBe("detached-backoff");
});
it("bounds an absent handshake and refuses a second queued caller command", async () => {
  const f = fixture(); await f.device.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.children[0].stopped).toBe(true);
  expect(f.device.snapshot().reason).toMatch(/handshake timed out/);
  const other = fixture(); await live(other);
  const pending = other.device.sendCommand({ commandSet: 2, commandId: 42 });
  const canceled = expect(pending).rejects.toThrow();
  await expect(other.device.sendCommand({ commandSet: 4, commandId: 12 })).rejects.toThrow(/pending/);
  await other.device.close(); await canceled;
});
