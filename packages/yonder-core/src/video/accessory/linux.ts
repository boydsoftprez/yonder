// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AccessorySession, aoaSetupResponse, functionFsDescriptors, functionFsStrings,
  type AccessoryCommandOptions, type H264AccessUnit, type UsbSetupPacket,
} from "./aoa.js";
import type { DumlCommand, DumlFrame } from "./duml.js";

/** R-CAM-15: one owned FunctionFS generation, never a persisted command queue. */
export const FUNCTIONFS_HELPER_PATH = fileURLToPath(new URL("./assets/functionfs.py", import.meta.url));
export const DETACHED_BACKOFF_MS = 45_000;
export const TRAFFIC_TIMEOUT_MS = 3_000;
const STARTUP_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 1_000;
const MAX_LINE = 24_000;
const MAX_CHUNK = 16_384;
export const monotonicMilliseconds = (): number => Number(process.hrtime.bigint() / 1_000_000n);
type Message = Record<string, any>;
export interface FunctionFsHelper {
  send(message: Message): void;
  /** Stop actual endpoint I/O and wait for resource cleanup and child exit. */
  close(): Promise<void>;
}

/** Bounded NDJSON. No raw device data or helper stderr is copied to errors. */
export class NdjsonFunctionFsHelper implements FunctionFsHelper {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private closed = false;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private closePromise?: Promise<void>;
  constructor(private readonly event: (message: Message) => void, options: {
    helperPath?: string; spawn?: typeof spawn;
  } = {}) {
    this.child = (options.spawn ?? spawn)("python3", ["-u", options.helperPath ?? FUNCTIONFS_HELPER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => {
      this.child.once("close", (code, signal) => { resolve({ code, signal }); if (!this.closed) this.fail("FunctionFS helper exited"); });
    });
    this.child.once("error", () => this.fail("FunctionFS helper could not start; check python3 and packaged helper"));
    this.child.stdin.on("error", () => this.fail("FunctionFS helper input closed"));
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        if (end > MAX_LINE) { this.fail("FunctionFS IPC line too large"); return; }
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
          this.event(value as Message);
        } catch { this.fail("Malformed FunctionFS IPC"); return; }
        if (this.closed) return;
      }
      if (this.buffer.length > MAX_LINE) this.fail("FunctionFS IPC line too large");
    });
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.event({ type: "error", code: "fault", message });
    void this.close().catch(() => undefined);
  }
  send(message: Message): void {
    if (this.closed) throw new Error("FunctionFS helper closed");
    const line = JSON.stringify(message) + "\n";
    if (line.length > MAX_LINE || this.child.stdin.writableLength + line.length > 64_000) {
      throw new Error("FunctionFS IPC queue limit");
    }
    this.child.stdin.write(line);
  }
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    // SIGTERM interrupts the helper's nonblocking loop and enters its owned-resource cleanup.
    this.child.kill("SIGTERM");
    this.closePromise = (async () => {
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
      try {
        const result = await this.exited;
        // Handled SIGTERM/SIGINT finish Python cleanup and return a numeric code.
        // Any signal-valued exit bypassed that path, so owned resources are uncertain.
        if (result.signal !== null || result.code === 2) throw new Error("FunctionFS cleanup was not completed");
      } finally { clearTimeout(kill); }
    })();
    return this.closePromise;
  }
}

export type Pocket2State = "unavailable" | "preparing" | "phone" | "accessory" | "live" | "stale" | "detached-backoff" | "fault" | "closed";
export interface Pocket2Status {
  readonly state: Pocket2State;
  readonly generation: number;
  readonly identity: string;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly lastCommandAt: number | null;
  readonly lastVideoAt: number | null;
  readonly reason: string | null;
}
export interface Pocket2DeviceOptions {
  readonly controller: string;
  readonly now?: () => number;
  readonly helperFactory?: (event: (message: Message) => void) => FunctionFsHelper;
  readonly onCommand?: (frame: DumlFrame) => void;
  readonly onVideo?: (unit: H264AccessUnit) => void;
  readonly onStatus?: (status: Pocket2Status) => void;
}

export class Pocket2Device {
  private status: Pocket2Status;
  private readonly now: () => number;
  private helper?: FunctionFsHelper;
  private session?: AccessorySession;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private freshnessTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private enabledAt?: number;
  private control?: { id: number; setup: UsbSetupPacket; start: boolean };
  private write?: { id: number; reject: (reason: Error) => void; resolve: () => void };
  private serial = 0;
  private stopping?: Promise<void>;
  private closed = false;
  private started = false;
  private externalPending = false;
  private cleanupFailure?: Error;

  constructor(private readonly options: Pocket2DeviceOptions) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.controller)) throw new Error("invalid USB controller name");
    this.now = options.now ?? monotonicMilliseconds;
    this.status = { state: "unavailable", generation: 0, identity: `pocket2:${options.controller}`,
      manufacturer: null, model: null, lastCommandAt: null, lastVideoAt: null, reason: null };
  }
  snapshot(): Pocket2Status { return { ...this.status }; }
  private update(state: Pocket2State, reason: string | null = null): void {
    this.status = { ...this.status, state, reason }; this.options.onStatus?.(this.snapshot());
  }
  /** Schedules discovery; never waits on USB enumeration or a configuration renderer. */
  async start(): Promise<void> {
    if (this.closed) throw new Error("Pocket 2 device closed");
    if (this.started) return;
    this.started = true; this.prepare();
  }
  private prepare(): void {
    if (this.closed) return;
    this.status = { ...this.status, generation: this.status.generation + 1,
      manufacturer: null, model: null, lastCommandAt: null, lastVideoAt: null };
    this.enabledAt = undefined; this.control = undefined;
    const generation = this.status.generation;
    this.update("preparing");
    this.startupTimer = setTimeout(() => { void this.retire("fault", "Pocket 2 handshake timed out"); }, STARTUP_TIMEOUT_MS);
    try {
      this.helper = (this.options.helperFactory ?? (event => new NdjsonFunctionFsHelper(event)))(message => {
        if (generation !== this.status.generation || this.closed || this.stopping) return;
        try { this.receive(message); } catch { void this.retire("fault", "Invalid FunctionFS message or control sequence"); }
      });
      this.helper.send({ type: "prepare", controller: this.options.controller, stages: [
        { stage: "phone", vendorId: "18d1", productId: "4ee1", manufacturer: "Google", product: "Pixel", serial: "0001", descriptors: b64(functionFsDescriptors("phone")), strings: b64(functionFsStrings()) },
        { stage: "accessory", vendorId: "18d1", productId: "2d00", manufacturer: "Android", product: "Android Accessory", serial: "0001", descriptors: b64(functionFsDescriptors("accessory")), strings: b64(functionFsStrings()) },
      ] });
    } catch { void this.retire("unavailable", "FunctionFS helper unavailable"); }
  }
  private receive(message: Message): void {
    switch (message.type) {
      case "ready":
        if (this.status.state !== "preparing") throw new Error();
        this.helper!.send({ type: "bind", stage: "phone" }); this.update("phone"); break;
      case "setup": this.setup(message); break;
      case "control-data": {
        const control = this.control;
        if (!control || control.id !== message.id) throw new Error();
        const response = aoaSetupResponse(control.setup, new Uint8Array(from64(message.data)));
        if (response?.kind !== "string") throw new Error();
        if (response.name === "manufacturer" || response.name === "model") {
          this.status = { ...this.status, [response.name]: response.value };
        }
        this.control = undefined;
        break;
      }
      case "control-done":
        if (this.control?.id !== message.id) throw new Error();
        if (this.control!.start) {
          this.helper!.send({ type: "bind", stage: "accessory" }); this.update("accessory");
        }
        this.control = undefined; break;
      case "event":
        if (message.stage !== "phone" && message.stage !== "accessory") throw new Error();
        if (message.stage === "accessory" && message.event === "ENABLE") this.enable();
        // After START completion the state is accessory; phone detach then is the
        // deliberate handover. Earlier detach invalidates the current camera strings.
        else if (["DISABLE", "UNBIND"].includes(message.event)
          && (message.stage === "accessory" || this.status.state === "phone")) {
          void this.retire("stale", "Pocket 2 USB disconnected");
        } else if (!["BIND", "UNBIND", "ENABLE", "DISABLE", "SUSPEND", "RESUME"].includes(message.event)) throw new Error();
        break;
      case "data":
        if (!this.session?.enabled) throw new Error();
        this.session.receive(from64(message.data)); break;
      case "written":
        if (message.id !== this.write?.id) throw new Error();
        this.write!.resolve(); break;
      case "error":
        void this.retire(message.code === "unavailable" ? "unavailable" : "fault",
          typeof message.message === "string" ? message.message.slice(0, 200) : "FunctionFS failed"); break;
      case "bound": break;
      default: throw new Error();
    }
  }
  private setup(message: Message): void {
    const setup = message.setup as UsbSetupPacket;
    if (this.control || !Number.isSafeInteger(message.id) || !setup || ![setup.requestType, setup.request, setup.value, setup.index, setup.length].every(Number.isInteger)) throw new Error();
    let action: Message = { type: "control", id: message.id, action: "stall" };
    // Validate policy before an OUT read; reading ep0 can acknowledge the request.
    if (setup.length >= 0 && setup.length <= 4_096) {
      const response = aoaSetupResponse(setup, new Uint8Array(setup.length));
      if (response?.kind === "string" && message.stage === "phone" && this.status.state === "phone") action = { ...action, action: "read" };
      else if (response?.kind === "reply") action = { ...action, action: "write", data: b64(response.data) };
      else if (response?.kind === "start" && message.stage === "phone" && this.status.state === "phone"
        && this.status.manufacturer === "DJI" && this.status.model === "HG211") action = { ...action, action: "read" };
    }
    this.control = { id: message.id, setup, start: setup.request === 53 && action.action === "read" };
    this.helper!.send(action);
  }
  private enable(): void {
    if (this.status.state !== "accessory" || this.status.manufacturer !== "DJI" || this.status.model !== "HG211") throw new Error();
    if (this.session?.enabled) return;
    this.enabledAt = this.now();
    this.session = new AccessorySession({ transport: { write: (data, signal, deadline) => this.bulkWrite(data, signal, deadline) },
      onCommand: frame => { this.traffic("lastCommandAt"); this.options.onCommand?.(frame); },
      onVideo: unit => { this.traffic("lastVideoAt"); this.options.onVideo?.(unit); },
    });
    this.session.enable();
    this.freshnessTimer = setInterval(() => {
      const newest = Math.max(this.status.lastCommandAt ?? this.enabledAt!, this.status.lastVideoAt ?? this.enabledAt!);
      if (this.now() - newest >= TRAFFIC_TIMEOUT_MS) void this.retire("stale", "Pocket 2 protocol traffic stopped");
    }, 250);
  }
  private traffic(field: "lastCommandAt" | "lastVideoAt"): void {
    this.status = { ...this.status, [field]: this.now() };
    if (this.status.state !== "live") { clearTimeout(this.startupTimer); this.update("live"); }
  }
  /** One caller command in flight; no unbounded motion queue behind endpoint backpressure. */
  async sendCommand(command: Omit<DumlCommand, "sequence">, options: AccessoryCommandOptions = {}): Promise<void> {
    if (this.status.state !== "live" || !this.session || this.stopping) throw new Error("Pocket 2 link is not live");
    const latest = Math.max(this.status.lastCommandAt ?? -Infinity, this.status.lastVideoAt ?? -Infinity);
    if (this.now() - latest >= TRAFFIC_TIMEOUT_MS) {
      void this.retire("stale", "Pocket 2 protocol traffic stopped");
      throw new Error("Pocket 2 link is not live");
    }
    if (this.externalPending) throw new Error("Pocket 2 command already pending");
    if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline <= this.now())) throw new Error("Pocket 2 command deadline expired");
    this.externalPending = true;
    try { await this.session.sendCommand(command, options); }
    finally { this.externalPending = false; }
  }
  private bulkWrite(data: Uint8Array, signal: AbortSignal, requestedDeadline?: number): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("Pocket 2 write aborted"));
    const deadline = Math.min(requestedDeadline ?? Infinity, this.now() + WRITE_TIMEOUT_MS);
    if (deadline <= this.now()) {
      void this.retire("stale", "Pocket 2 command deadline expired at dispatch");
      return Promise.reject(new Error("Pocket 2 command deadline expired"));
    }
    if (!this.helper || this.write || data.length > MAX_CHUNK) return Promise.reject(new Error("Pocket 2 writer unavailable or oversized"));
    return new Promise<void>((resolve, reject) => {
      const id = ++this.serial;
      const finish = (error?: Error): void => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (this.write?.id === id) this.write = undefined;
        if (error) reject(error); else resolve();
      };
      const abort = (): void => { void this.retire("stale", "Pocket 2 active write canceled"); };
      const timer = setTimeout(() => { void this.retire("stale", "Pocket 2 write deadline expired"); }, Math.max(0, deadline - this.now()));
      this.write = { id, resolve: () => finish(), reject: error => finish(error) };
      signal.addEventListener("abort", abort, { once: true });
      try { this.helper!.send({ type: "write", id, data: b64(data), deadline }); }
      catch { void this.retire("fault", "Pocket 2 endpoint write failed"); }
    });
  }
  private retire(state: "stale" | "fault" | "unavailable", reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    // Invalidate before aborting AccessorySession, whose abort handler comes back here.
    const helper = this.helper; this.helper = undefined;
    let complete!: () => void;
    this.stopping = new Promise<void>(resolve => { complete = resolve; });
    this.status = { ...this.status, generation: this.status.generation + 1, manufacturer: null, model: null };
    this.update(state, reason);
    clearTimeout(this.startupTimer); clearInterval(this.freshnessTimer);
    this.write?.reject(new Error(reason)); this.session?.close(); this.session = undefined;
    void (async () => {
      let cleanupFailed = false;
      try { await helper?.close(); }
      catch {
        cleanupFailed = true;
        this.cleanupFailure = new Error("FunctionFS cleanup incomplete; controller needs inspection before retry");
        this.update("fault", this.cleanupFailure.message);
      }
      finally {
        this.stopping = undefined;
        if (!this.closed && !cleanupFailed) {
          if (state !== "unavailable") this.update("detached-backoff", reason);
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.prepare(); }, DETACHED_BACKOFF_MS);
        }
        complete();
      }
    })();
    return this.stopping;
  }
  async close(): Promise<void> {
    if (this.closed) {
      await this.stopping;
      if (this.cleanupFailure) throw this.cleanupFailure;
      return;
    }
    this.closed = true; clearTimeout(this.retryTimer);
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.retire("stale", "Pocket 2 device closed");
    if (this.cleanupFailure) throw this.cleanupFailure;
    this.update("closed");
  }
}
function b64(data: Uint8Array): string { return Buffer.from(data).toString("base64"); }
function from64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > 21_848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid base64");
  const data = Buffer.from(value, "base64");
  if (data.length > MAX_CHUNK) throw new Error("oversized bulk chunk");
  return data;
}
