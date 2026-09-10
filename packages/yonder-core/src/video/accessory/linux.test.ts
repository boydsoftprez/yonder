// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Pocket2Device, WRITE_CONFIRMATION_GRACE_MS, type FunctionFsHelper } from "./linux.js";
import { AOA_COMMAND_ROUTE, encodeAoaEnvelope } from "./aoa.js";
import { encodeDuml } from "./duml.js";
import { GimbalController } from "./gimbal.js";
import type { GuardContext } from "./guard.js";
import type { IntentClock } from "./intent.js";

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
  const onFailure = vi.fn();
  const device = new Pocket2Device({ controller: "fe980000.usb", now: () => Date.now(), onCommand, onFailure,
    helperFactory: (event) => { const helper = new FakeHelper(event); children.push(helper); return helper; } });
  devices.push(device);
  return { device, children, onCommand, onFailure };
}
async function phone(f: ReturnType<typeof fixture>) {
  await f.device.start();
  const h = f.children.at(-1)!;
  h.emit({ type: "ready" });
  h.emit({ type: "bound", stage: "phone" });
  identify(h);
  return h;
}
function identify(h: FakeHelper): void {
  for (const [index, text] of [[0, "DJI"], [1, "HG211"]] as const) {
    h.emit({ type: "setup", id: index + 1, stage: "phone", setup: { requestType: 64, request: 52, value: 0, index, length: text.length + 1 } });
    h.emit({ type: "control-data", id: index + 1, data: Buffer.from(text + "\0").toString("base64") });
  }
}
function enableAccessory(h: FakeHelper): void {
  h.emit({ type: "setup", id: 3, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  h.emit({ type: "control-done", id: 3 });
  h.emit({ type: "event", stage: "phone", event: "DISABLE" });
  h.emit({ type: "event", stage: "phone", event: "UNBIND" });
  h.emit({ type: "event", stage: "accessory", event: "ENABLE" });
  h.emit({ type: "data", data: Buffer.from(encodeAoaEnvelope(AOA_COMMAND_ROUTE, encodeDuml({ commandSet: 2, commandId: 128, sequence: 7, ack: 0 }))).toString("base64") });
}
async function live(f: ReturnType<typeof fixture>) {
  const h = await phone(f);
  enableAccessory(h);
  return h;
}
it("prepares both descriptors before phone binding and verifies live identity through real protocol", async () => {
  const f = fixture(); const h = await live(f);
  expect(h.messages[0]).toMatchObject({ type: "prepare", controller: "fe980000.usb" });
  expect(h.messages[0].stages.map((s: any) => s.productId)).toEqual(["4ee1", "2d00"]);
  expect(h.messages[0].stages.map((s: any) => s.serial)).toEqual(["0001", "0001"]);
  expect(h.messages.some(m => m.type === "bind" && m.stage === "accessory")).toBe(true);
  expect(f.device.snapshot()).toMatchObject({ state: "live", identity: "pocket2:fe980000.usb", manufacturer: "DJI", model: "HG211" });
  expect(f.onCommand).toHaveBeenCalledOnce();
});
it("keeps a bound phone ready for five idle minutes and accepts a late camera without resource churn", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "ready" }); h.emit({ type: "bound", stage: "phone" });
  const generation = f.device.snapshot().generation;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.children).toHaveLength(1); expect(h.stopped).toBe(false);
  expect(h.messages.map(m => m.type)).toEqual(["prepare", "bind"]);
  expect(f.device.snapshot()).toMatchObject({ state: "phone", generation, manufacturer: null, model: null });
  identify(h); enableAccessory(h);
  expect(f.device.snapshot()).toMatchObject({ state: "live", generation, manufacturer: "DJI", model: "HG211" });
  expect(f.onCommand).toHaveBeenCalledOnce();
});
it.each(["preparation", "binding", "wrong-stage-bound", "premature-phone-bound"])("retains the 15-second startup bound during %s", async phase => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  if (phase === "binding" || phase === "wrong-stage-bound") h.emit({ type: "ready" });
  if (phase === "wrong-stage-bound") h.emit({ type: "bound", stage: "accessory" });
  if (phase === "premature-phone-bound") h.emit({ type: "bound", stage: "phone" });
  await vi.advanceTimersByTimeAsync(14_999); expect(h.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(h.stopped).toBe(true);
  expect(f.device.snapshot()).toMatchObject({ state: "detached-backoff", reason: expect.stringMatching(/timed out/) });
});
it.each([
  { requestType: 192, request: 51, value: 0, index: 0, length: 2 },
  { requestType: 64, request: 52, value: 0, index: 0, length: 4 },
  { requestType: 64, request: 53, value: 0, index: 0, length: 0 },
])("starts a fresh 15-second handshake budget on the first recognized AOA request $request", async setup => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "ready" }); h.emit({ type: "bound", stage: "phone" });
  await vi.advanceTimersByTimeAsync(60_000);
  h.emit({ type: "setup", stage: "phone", id: 7, setup });
  if (setup.request === 52) h.emit({ type: "control-data", id: 7, data: Buffer.from("DJI\0").toString("base64") });
  else h.emit({ type: "control-done", id: 7 });
  await vi.advanceTimersByTimeAsync(14_999); expect(h.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(h.stopped).toBe(true);
  expect(f.device.snapshot().reason).toMatch(/handshake timed out/);
});
it("late phone bound and further recognized or unknown setup cannot extend a begun handshake", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0]; h.emit({ type: "ready" });
  await vi.advanceTimersByTimeAsync(10_000);
  const protocol = { requestType: 192, request: 51, value: 0, index: 0, length: 2 };
  h.emit({ type: "setup", stage: "phone", id: 1, setup: protocol }); h.emit({ type: "control-done", id: 1 });
  await vi.advanceTimersByTimeAsync(10_000);
  h.emit({ type: "bound", stage: "phone" }); h.emit({ type: "bound", stage: "phone" });
  for (const [id, setup] of [
    [2, { ...protocol, request: 99 }], [3, { ...protocol, requestType: 128 }], [4, protocol],
  ] as const) {
    h.emit({ type: "setup", stage: "phone", id, setup }); h.emit({ type: "control-done", id });
  }
  await vi.advanceTimersByTimeAsync(4_999); expect(h.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(h.stopped).toBe(true);
});
it("unknown and non-AOA setup leave a bound idle phone waiting without starting a handshake", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "ready" }); h.emit({ type: "bound", stage: "phone" });
  for (const [id, requestType, request] of [[1, 192, 99], [2, 128, 51]] as const) {
    h.emit({ type: "setup", stage: "phone", id, setup: { requestType, request, value: 0, index: 0, length: 2 } });
    expect(h.messages.at(-1)).toMatchObject({ type: "control", action: "stall" });
    h.emit({ type: "control-done", id });
  }
  await vi.advanceTimersByTimeAsync(300_000);
  expect(h.stopped).toBe(false); expect(f.children).toHaveLength(1); expect(f.device.snapshot().state).toBe("phone");
});
it("retired generation bound/setup events cannot change the replacement attachment wait or deadline", async () => {
  const f = fixture(); await f.device.start(); const old = f.children[0];
  old.emit({ type: "ready" }); old.emit({ type: "bound", stage: "phone" });
  old.emit({ type: "error", message: "disconnected" }); await vi.advanceTimersByTimeAsync(45_000);
  const h = f.children[1]; h.emit({ type: "ready" }); h.emit({ type: "bound", stage: "phone" });
  const protocol = { requestType: 192, request: 51, value: 0, index: 0, length: 2 };
  old.emit({ type: "setup", stage: "phone", id: 1, setup: protocol }); old.emit({ type: "bound", stage: "phone" });
  await vi.advanceTimersByTimeAsync(300_000);
  expect(f.children).toHaveLength(2); expect(h.stopped).toBe(false);
  h.emit({ type: "setup", stage: "phone", id: 1, setup: protocol }); h.emit({ type: "control-done", id: 1 });
  await vi.advanceTimersByTimeAsync(14_999); old.emit({ type: "bound", stage: "phone" });
  await vi.advanceTimersByTimeAsync(1); expect(h.stopped).toBe(true);
});
it("shutdown cleans a bound idle phone and does not retry or accept late attachment", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "ready" }); h.emit({ type: "bound", stage: "phone" });
  await vi.advanceTimersByTimeAsync(300_000); await f.device.close();
  expect(h.stopped).toBe(true); expect(f.device.snapshot().state).toBe("closed");
  h.emit({ type: "bound", stage: "phone" }); identify(h);
  await vi.advanceTimersByTimeAsync(300_000); expect(f.children).toHaveLength(1);
  expect(h.messages.map(m => m.type)).toEqual(["prepare", "bind"]);
});
it("stalls unknown OUT before reading its control data", async () => {
  const f = fixture(); await f.device.start(); const h = f.children[0];
  h.emit({ type: "setup", id: 9, stage: "phone", setup: { requestType: 64, request: 99, value: 0, index: 0, length: 12 } });
  expect(h.messages.at(-1)).toEqual({ type: "control", id: 9, action: "stall" });
});
it.each(["pointer release", "intent renewal"])("keeps USB live when %s lands after physical dispatch but before written IPC", async reason => {
  const f = fixture(); const h = await live(f); const abort = new AbortController();
  const generation = f.device.snapshot().generation;
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12 }, { signal: abort.signal, deadline: Date.now() + 100 });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.messages.at(-1)).toMatchObject({ type: "write", deadline: Date.now() + 100 });
  const id = h.messages.at(-1)!.id;
  abort.abort(new Error(reason));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.stopped).toBe(false);
  expect(f.device.snapshot()).toMatchObject({ state: "live", generation });
  h.emit({ type: "written", id });
  await expect(pending).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(f.children).toHaveLength(1);
});
it.each(["release", "renewal"] as const)("an actual gimbal %s during written IPC wait does not retire USB", async action => {
  const f = fixture(); const h = await live(f); const generation = f.device.snapshot().generation;
  const intentClock: IntentClock = {
    now: () => Date.now(),
    setTimer: (ms, fn) => setTimeout(fn, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  const context: GuardContext = {
    now: Date.now(), attitudeMaxAgeMs: 500,
    attitude: { pitch: 0, roll: 0, yaw: 0, mode: 2, at: Date.now(),
      pitchLimit: false, yawLimit: false, fault: false, quaternion: [1, 0, 0, 0] },
    mount: null, envelopes: [], signs: { pan: null, tilt: null }, limitDirections: {},
    intentAllowanceMs: 500, deviceStopAllowanceMs: 800, actions: [],
  };
  const gimbal = new GimbalController({ clock: intentClock, context: () => ({ ...context, now: Date.now() }),
    write: (command, options) => f.device.sendCommand(command, options) });
  const issued = gimbal.issue("operator", "physical");
  if (!issued.accepted) throw new Error(issued.reason);
  const admitted = gimbal.admit("operator", { ...issued.grant, seq: 1, rate: { pan: 1, tilt: 0 } });
  if (!admitted.accepted || !admitted.next) throw new Error("rate was not admitted");
  await vi.advanceTimersByTimeAsync(0);
  const write = h.messages.at(-1)!;
  expect(write.type).toBe("write");

  if (action === "release") gimbal.end("operator", issued.grant.gesture);
  else expect(gimbal.admit("operator", { ...admitted.next, seq: 2, rate: { pan: 2, tilt: 0 } })).toMatchObject({ accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.stopped).toBe(false);
  expect(f.device.snapshot()).toMatchObject({ state: "live", generation });

  h.emit({ type: "written", id: write.id });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.stopped).toBe(false);
  expect(f.device.snapshot()).toMatchObject({ state: "live", generation });
  gimbal.close();
});
it("keeps the original endpoint deadline while allowing delayed completion IPC", async () => {
  const f = fixture(); const h = await live(f); const generation = f.device.snapshot().generation;
  const deadline = Date.now() + 80;
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12 }, { deadline });
  await vi.advanceTimersByTimeAsync(0);
  const write = h.messages.at(-1)!;
  expect(write).toMatchObject({ type: 'write', deadline });
  await vi.advanceTimersByTimeAsync(90);
  expect(h.stopped).toBe(false);
  h.emit({ type: 'written', id: write.id }); await pending;
  expect(f.device.snapshot()).toMatchObject({ state: 'live', generation });
  expect(f.onFailure).not.toHaveBeenCalled();
});
it("a helper endpoint-deadline failure retires immediately without waiting for IPC grace", async () => {
  const f = fixture(); const h = await live(f);
  const deadline = Date.now() + 80;
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12, payload: Uint8Array.of(1,2,3) }, { deadline });
  const rejected = expect(pending).rejects.toThrow(/endpoint deadline/);
  await vi.advanceTimersByTimeAsync(80);
  h.emit({ type: 'error', message: 'endpoint deadline expired' }); await rejected;
  expect(h.stopped).toBe(true);
  expect(f.onFailure).toHaveBeenCalledOnce();
  expect(f.onFailure.mock.calls[0][0]).toMatchObject({ reason: 'endpoint deadline expired',
    pendingWrite: { commandSet: 4, commandId: 12, deadline, elapsedMs: 80 } });
  expect(f.onFailure.mock.calls[0][0].pendingWrite).not.toHaveProperty('payload');
});
it("bounds an unconfirmed write even when the helper and camera are silent", async () => {
  const f = fixture(); const h = await live(f);
  const pending = f.device.sendCommand({ commandSet: 4, commandId: 12 }, { deadline: Date.now() + 80 });
  const rejected = expect(pending).rejects.toThrow(/confirmation timed out/);
  await vi.advanceTimersByTimeAsync(80 + WRITE_CONFIRMATION_GRACE_MS - 1); expect(h.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejected; expect(h.stopped).toBe(true);
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
  const f = { device, children: [] as FakeHelper[], onCommand: vi.fn(), onFailure: vi.fn() };
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
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(manifest.scripts.build).toContain("scripts/copy-assets.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "yonder-helper-assets-"));
  try {
    mkdirSync(join(scratch, "scripts")); mkdirSync(join(scratch, "dist"));
    mkdirSync(join(scratch, "src/video/accessory/assets"), { recursive: true });
    copyFileSync(new URL("../../../scripts/copy-assets.mjs", import.meta.url), join(scratch, "scripts/copy-assets.mjs"));
    copyFileSync(FUNCTIONFS_HELPER_PATH, join(scratch, "src/video/accessory/assets/functionfs.py"));
    copyFileSync(new URL('./assets/usb_aio.py', import.meta.url), join(scratch, "src/video/accessory/assets/usb_aio.py"));
    execFileSync("node", [join(scratch, "scripts/copy-assets.mjs")]);
    const installed = join(scratch, "dist/video/accessory/assets/functionfs.py");
    expect(readFileSync(installed)).toEqual(readFileSync(FUNCTIONFS_HELPER_PATH));
    execFileSync("python3", ["-B", "-c", "import sys,runpy,pathlib; sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); runpy.run_path(sys.argv[1],run_name='package_import_check')", installed]);
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

it.each(["DISABLE", "UNBIND"])("invalidates phone identity on unexpected %s and requires new strings", async event => {
  const f = fixture(); const h = await phone(f);
  const generation = f.device.snapshot().generation;
  expect(f.device.snapshot()).toMatchObject({ manufacturer: "DJI", model: "HG211" });
  h.emit({ type: "event", stage: "phone", event });
  expect(f.device.snapshot()).toMatchObject({ state: "stale", manufacturer: null, model: null });
  expect(f.device.snapshot().generation).toBeGreaterThan(generation);
  h.emit({ type: "setup", id: 3, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  expect(h.messages.some(m => m.type === "bind" && m.stage === "accessory")).toBe(false);
  await vi.advanceTimersByTimeAsync(45_000);
  const replacement = f.children.at(-1)!;
  expect(replacement).not.toBe(h);
  replacement.emit({ type: "ready" });
  replacement.emit({ type: "setup", id: 1, stage: "phone", setup: { requestType: 64, request: 53, value: 0, index: 0, length: 0 } });
  expect(replacement.messages.at(-1)).toMatchObject({ type: "control", action: "stall" });
  replacement.emit({ type: "control-done", id: 1 });
  expect(replacement.messages.some(m => m.type === "bind" && m.stage === "accessory")).toBe(false);
});

it.each(["SIGHUP", "SIGSEGV", "SIGABRT", "SIGTERM", "SIGINT"])("treats helper signal exit %s as uncertain cleanup and never retries", async signal => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { NdjsonFunctionFsHelper } = await import("./linux.js");
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  const factory = vi.fn(event => new NdjsonFunctionFsHelper(event, { spawn: (() => child) as any }));
  const statuses: string[] = [];
  const device = new Pocket2Device({ controller: "test.udc", helperFactory: factory, onStatus: status => statuses.push(status.state) });
  await device.start();
  child.stdout.write('{"type":"ready"}\n');
  child.emit("close", null, signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(device.snapshot()).toMatchObject({ state: "fault", reason: expect.stringMatching(/cleanup incomplete/) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(factory).toHaveBeenCalledOnce();
  await expect(device.close()).rejects.toThrow(/cleanup/);
  expect(statuses).not.toContain("closed");
  expect(statuses).not.toContain("detached-backoff");
});
it("accepts numeric clean exit after the helper handles termination and cleanup", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { NdjsonFunctionFsHelper } = await import("./linux.js");
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 0, null)); return true; });
  const device = new Pocket2Device({ controller: "test.udc", helperFactory: event => new NdjsonFunctionFsHelper(event, { spawn: (() => child) as any }) });
  await device.start(); await device.close();
  expect(device.snapshot().state).toBe("closed");
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});


it('runs the USB scheduling, backpressure and native-AIO buffer-lifetime regressions', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const script of ['functionfs_test.py', 'usb_aio_test.py']) {
    execFileSync('python3', ['-B', fileURLToPath(new URL(script, import.meta.url))], { timeout: 10000, stdio: 'pipe' });
  }
});

it.each([false, true])('reproduces the false watchdog retirement under video backlog; priority completion=%s', async priority => {
  const { execFileSync } = await import('node:child_process');
  const { FUNCTIONFS_HELPER_PATH } = await import('./linux.js');
  const f = fixture(); const h = await live(f);
  const result = f.device.sendCommand({ commandSet: 0, commandId: 14, ack: 0 })
    .then(() => ({ ok: true, reason: '' }), error => ({ ok: false, reason: error.message }));
  await vi.advanceTimersByTimeAsync(0);
  const write = h.messages.at(-1)!;
  const send = h.send.bind(h);
  h.send = message => { send(message); if (message.type === 'write' && message.id !== write.id) queueMicrotask(() => h.emit({ type: 'written', id: message.id })); };
  // Fresh, valid camera traffic fills the helper's real output queue. The
  // throttled consumer delivers one queued line every 100 ms. No camera or
  // physical write has failed; only the old completion ordering is wrong.
  const packet = Buffer.from(encodeAoaEnvelope(AOA_COMMAND_ROUTE,
    encodeDuml({ commandSet: 0, commandId: 0, sequence: 9, response: true, ack: 0 })));
  const data = Buffer.concat(Array.from({ length: 700 }, () => packet)).toString('base64');
  const program = `import sys,json,runpy,pathlib
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
module=runpy.run_path(sys.argv[1],run_name='queue_test')
helper=module['Helper'](); request=json.load(sys.stdin)
for _ in range(30): helper.emit(type='data',data=request['data'])
helper.emit(type='written',id=request['id'])
sys.stdout.buffer.write(helper.output)
`;
  const output = execFileSync('python3', ['-B', '-c', program, FUNCTIONFS_HELPER_PATH],
    { input: JSON.stringify({ id: write.id, data }), encoding: 'utf8', maxBuffer: 2_000_000 });
  let messages = output.trim().split('\n').map(line => JSON.parse(line));
  // Negative control: the former FIFO put the same completed-write notice
  // after all video. The positive case uses the shipped helper's ordering.
  if (!priority) messages = [...messages.filter(m => m.type === 'data'), ...messages.filter(m => m.type === 'written')];
  for (const message of messages) {
    await vi.advanceTimersByTimeAsync(100);
    if (!h.stopped) h.emit(message);
  }
  const outcome = await result;
  expect(outcome.ok).toBe(priority);
  if (priority) {
    expect(h.stopped).toBe(false); expect(f.onFailure).not.toHaveBeenCalled();
  } else {
    expect(outcome.reason).toContain('write confirmation timed out');
    expect(f.onFailure).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'Pocket 2 write confirmation timed out',
      lastCommandAgeMs: 100,
      pendingWrite: expect.objectContaining({ commandSet: 0, commandId: 14 }),
    }));
  }
});
