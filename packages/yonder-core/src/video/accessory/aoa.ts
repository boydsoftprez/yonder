// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DumlSplitter,
  encodeDuml,
  type DumlCommand,
  type DumlFrame,
} from "./duml.js";

/**
 * Android Open Accessory and DJI Pocket 2 session primitives.
 *
 * The FunctionFS descriptors, setup request behavior, `55 cc` envelope and
 * session opening are faithful ports of `scripts/pocket2/aoa_stage.py` and
 * `scripts/pocket2/aoa_session.py`. The two Python programs record what was
 * observed on the bench and keep the Linux file-descriptor work outside this
 * protocol module. A later adapter only has to provide the bulk writer and
 * pass enabled-link bytes and lifecycle events into AccessorySession.
 */

export const AOA_COMMAND_ROUTE = Uint8Array.of(0x49, 0x57);
export const AOA_VIDEO_ROUTE = Uint8Array.of(0x4a, 0x57);
export const MAX_AOA_PAYLOAD = 16 * 1024 * 1024;
export const SESSION_START_DELAY_MS = 500;
export const SESSION_LIVENESS_MS = 1_000;

const ENVELOPE_MAGIC = Uint8Array.of(0x55, 0xcc);
const VIDEO_MAGIC = Uint8Array.of(0x00, 0x00, 0x01, 0xff);
const VIDEO_HEADER_BYTES = 16;
const MEDIA_KIND_H264 = 0x11;
const MEDIA_KIND_AAC = 0x24;

const DESCRIPTORS_MAGIC_V2 = 3;
const STRINGS_MAGIC = 2;
const HAS_FS_DESC = 1;
const HAS_HS_DESC = 2;
const ALL_CTRL_RECIP = 64;
const CONFIG0_SETUP = 128;

export const AOA_GET_PROTOCOL = 51;
export const AOA_SEND_STRING = 52;
export const AOA_START = 53;

export type FunctionFsStage = "phone" | "accessory";

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function little(values: readonly { readonly bytes: 2 | 4; readonly value: number }[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.bytes, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const item of values) {
    if (item.bytes === 2) view.setUint16(offset, item.value, true);
    else view.setUint32(offset, item.value, true);
    offset += item.bytes;
  }
  return result;
}

function interfaceDescriptor(endpoints: number, subclass: number): Uint8Array {
  return Uint8Array.of(9, 4, 0, 0, endpoints, 0xff, subclass, 0, 1);
}

function endpointDescriptor(address: number, maxPacketSize: number): Uint8Array {
  return concat(Uint8Array.of(7, 5, address, 2), little([{ bytes: 2, value: maxPacketSize }]), Uint8Array.of(0));
}

/** The exact FunctionFS v2 descriptor block written to ep0 by the bench tools. */
export function functionFsDescriptors(stage: FunctionFsStage): Uint8Array {
  const phone = interfaceDescriptor(0, 0x42);
  const fullSpeed = stage === "phone"
    ? phone
    : concat(interfaceDescriptor(2, 0xff), endpointDescriptor(0x81, 64), endpointDescriptor(0x01, 64));
  const highSpeed = stage === "phone"
    ? phone
    : concat(interfaceDescriptor(2, 0xff), endpointDescriptor(0x81, 512), endpointDescriptor(0x01, 512));
  const descriptorCount = stage === "phone" ? 1 : 3;
  const body = concat(
    little([
      { bytes: 4, value: descriptorCount },
      { bytes: 4, value: descriptorCount },
    ]),
    fullSpeed,
    highSpeed,
  );
  return concat(little([
    { bytes: 4, value: DESCRIPTORS_MAGIC_V2 },
    { bytes: 4, value: 12 + body.length },
    { bytes: 4, value: HAS_FS_DESC | HAS_HS_DESC | ALL_CTRL_RECIP | CONFIG0_SETUP },
  ]), body);
}

/** The exact single-language `aoa` FunctionFS string block from the bench. */
export function functionFsStrings(): Uint8Array {
  const value = Uint8Array.of(0x61, 0x6f, 0x61, 0);
  return concat(little([
    { bytes: 4, value: STRINGS_MAGIC },
    { bytes: 4, value: 16 + 2 + value.length },
    { bytes: 4, value: 1 },
    { bytes: 4, value: 1 },
    { bytes: 2, value: 0x0409 },
  ]), value);
}

export interface UsbSetupPacket {
  readonly requestType: number;
  readonly request: number;
  readonly value: number;
  readonly index: number;
  readonly length: number;
}

export type AoaSetupResponse =
  | { readonly kind: "reply"; readonly data: Uint8Array }
  | { readonly kind: "string"; readonly name: "manufacturer" | "model" | "description" | "version" | "uri" | "serial"; readonly value: string }
  | { readonly kind: "start" };

const STRING_NAMES = ["manufacturer", "model", "description", "version", "uri", "serial"] as const;

/** Return the AOA action for a valid vendor setup request; null means stall it. */
export function aoaSetupResponse(setup: UsbSetupPacket, payload = new Uint8Array(0)): AoaSetupResponse | null {
  const vendor = (setup.requestType & 0x60) === 0x40;
  const directionIn = (setup.requestType & 0x80) !== 0;
  if (!vendor || setup.value !== 0) return null;

  if (setup.request === AOA_GET_PROTOCOL) {
    if (!directionIn || setup.length !== 2 || setup.index !== 0) return null;
    return { kind: "reply", data: Uint8Array.of(2, 0) };
  }
  if (setup.request === AOA_SEND_STRING) {
    const name = STRING_NAMES[setup.index];
    if (directionIn || name === undefined || payload.length !== setup.length) return null;
    const end = payload.indexOf(0);
    return {
      kind: "string",
      name,
      value: new TextDecoder().decode(end < 0 ? payload : payload.subarray(0, end)),
    };
  }
  if (setup.request === AOA_START) {
    if (directionIn || setup.index !== 0 || setup.length !== 0 || payload.length !== 0) return null;
    return { kind: "start" };
  }
  return null;
}

function sameRoute(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === 2 && right.length === 2 && left[0] === right[0] && left[1] === right[1];
}

export function encodeAoaEnvelope(route: Uint8Array, payload: Uint8Array): Uint8Array {
  if (route.length !== 2) throw new RangeError("AOA route must contain exactly two bytes");
  if (payload.length > MAX_AOA_PAYLOAD) {
    throw new RangeError(`AOA payload must be at most ${MAX_AOA_PAYLOAD} bytes`);
  }
  const header = new Uint8Array(8);
  header.set(ENVELOPE_MAGIC);
  header.set(route, 2);
  new DataView(header.buffer).setUint32(4, payload.length, true);
  return concat(header, payload);
}

export interface AoaEnvelope {
  readonly route: Uint8Array;
  readonly payload: Uint8Array;
}

export type AoaEnvelopeEvent =
  | ({ readonly kind: "envelope" } & AoaEnvelope)
  | { readonly kind: "error"; readonly error: Error };

function magicAt(buffer: Uint8Array, magic: Uint8Array, from = 0): number {
  outer: for (let offset = from; offset <= buffer.length - magic.length; offset += 1) {
    for (let i = 0; i < magic.length; i += 1) {
      if (buffer[offset + i] !== magic[i]) continue outer;
    }
    return offset;
  }
  return -1;
}

function possibleMagicSuffix(buffer: Uint8Array, magic: Uint8Array): number {
  for (let length = Math.min(buffer.length, magic.length - 1); length > 0; length -= 1) {
    let matches = true;
    for (let i = 0; i < length; i += 1) {
      if (buffer[buffer.length - length + i] !== magic[i]) { matches = false; break; }
    }
    if (matches) return length;
  }
  return 0;
}

export class AoaEnvelopeSplitter {
  private buffer: Uint8Array = new Uint8Array(0);

  get bufferedBytes(): number { return this.buffer.length; }

  reset(): void { this.buffer = new Uint8Array(0); }

  push(chunk: Uint8Array): AoaEnvelopeEvent[] {
    this.buffer = concat(this.buffer, chunk);
    const events: AoaEnvelopeEvent[] = [];
    while (this.buffer.length > 0) {
      const start = magicAt(this.buffer, ENVELOPE_MAGIC);
      if (start < 0) {
        const keep = possibleMagicSuffix(this.buffer, ENVELOPE_MAGIC);
        const rejected = this.buffer.length - keep;
        if (rejected > 0) {
          events.push({ kind: "error", error: new Error(`discarded ${rejected} bytes before an AOA envelope`) });
          this.buffer = this.buffer.slice(rejected);
        }
        break;
      }
      if (start > 0) {
        events.push({ kind: "error", error: new Error(`discarded ${start} bytes before an AOA envelope`) });
        this.buffer = this.buffer.slice(start);
      }
      if (this.buffer.length < 8) break;

      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
        .getUint32(4, true);
      if (length > MAX_AOA_PAYLOAD) {
        events.push({
          kind: "error",
          error: new Error(`AOA payload length ${length} exceeds ${MAX_AOA_PAYLOAD}`),
        });
        const next = magicAt(this.buffer, ENVELOPE_MAGIC, 1);
        if (next >= 0) this.buffer = this.buffer.slice(next);
        else {
          const keep = possibleMagicSuffix(this.buffer, ENVELOPE_MAGIC);
          this.buffer = keep === 0 ? new Uint8Array(0) : this.buffer.slice(-keep);
        }
        continue;
      }
      if (this.buffer.length < 8 + length) break;
      events.push({
        kind: "envelope",
        route: this.buffer.slice(2, 4),
        payload: this.buffer.slice(8, 8 + length),
      });
      this.buffer = this.buffer.slice(8 + length);
    }
    return events;
  }
}

export interface H264AccessUnit {
  /** Annex-B bytes, with the Pocket 2's 16-byte record removed. */
  readonly data: Uint8Array;
  /** Camera timestamp in milliseconds, observed as a 30 fps clock. */
  readonly timestamp: number;
  /** Header bytes 8..11 retained raw; byte 9 within them is the H264 kind. */
  readonly metadata: number;
}

type VideoEvent =
  | { readonly kind: "unit"; readonly unit: H264AccessUnit }
  | { readonly kind: "ignored-audio" }
  | { readonly kind: "error"; readonly error: Error };

class Pocket2VideoSplitter {
  private buffer: Uint8Array = new Uint8Array(0);

  reset(): void { this.buffer = new Uint8Array(0); }

  push(chunk: Uint8Array): VideoEvent[] {
    this.buffer = concat(this.buffer, chunk);
    const events: VideoEvent[] = [];
    while (this.buffer.length > 0) {
      const start = magicAt(this.buffer, VIDEO_MAGIC);
      if (start < 0) {
        const keep = possibleMagicSuffix(this.buffer, VIDEO_MAGIC);
        const rejected = this.buffer.length - keep;
        if (rejected > 0) {
          events.push({ kind: "error", error: new Error(`discarded ${rejected} bytes before a Pocket 2 video record`) });
          this.buffer = this.buffer.slice(rejected);
        }
        break;
      }
      if (start > 0) {
        events.push({ kind: "error", error: new Error(`discarded ${start} bytes before a Pocket 2 video record`) });
        this.buffer = this.buffer.slice(start);
      }
      if (this.buffer.length < VIDEO_HEADER_BYTES) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      // Confirmed against 284 records from the Pocket 2: bytes 4..5 are the
      // low word, byte 6 is ff, and byte 7 is the high length byte. Eight
      // captured H264 keyframes use that high byte, including 105081 bytes.
      const length = view.getUint16(4, true) | (this.buffer[7]! << 16);
      if (length === 0 || this.buffer[6] !== 0xff) {
        events.push({ kind: "error", error: new Error("malformed Pocket 2 video record header") });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < VIDEO_HEADER_BYTES + length) break;
      const mediaKind = this.buffer[9]!;
      if (mediaKind === MEDIA_KIND_H264) {
        events.push({
          kind: "unit",
          unit: {
            data: this.buffer.slice(VIDEO_HEADER_BYTES, VIDEO_HEADER_BYTES + length),
            metadata: view.getUint32(8, true),
            timestamp: view.getUint32(12, true),
          },
        });
      } else if (mediaKind === MEDIA_KIND_AAC) {
        // Route 4a57 multiplexes AAC with H264. Audio is not a product feature
        // in this task, so consume its complete record without sending it to
        // the video callback.
        events.push({ kind: "ignored-audio" });
      } else {
        events.push({
          kind: "error",
          error: new Error(`unknown Pocket 2 media kind 0x${mediaKind.toString(16).padStart(2, "0")}`),
        });
      }
      this.buffer = this.buffer.slice(VIDEO_HEADER_BYTES + length);
    }
    return events;
  }
}

export interface AoaBulkTransport {
  /** Resolve only once the entire envelope has been written. Honor abort. */
  write(data: Uint8Array, signal: AbortSignal, deadline?: number): Promise<void>;
}

export interface AccessorySessionOptions {
  readonly transport: AoaBulkTransport;
  readonly onCommand?: (frame: DumlFrame) => void;
  readonly onVideo?: (unit: H264AccessUnit) => void;
  readonly onError?: (error: Error) => void;
}

export interface AccessoryCommandOptions {
  /**
   * Cancels this command independently of the link until physical dispatch.
   * It is checked when the serialized writer reaches the command, so an
   * expired gesture cannot move after waiting behind backpressure. Once one
   * write is admitted, cancellation cannot retract its bytes and must not be
   * mistaken for a link failure while its completion acknowledgement arrives.
   */
  readonly signal?: AbortSignal;
  /** Absolute CLOCK_MONOTONIC milliseconds, preserved through the command queue. */
  readonly deadline?: number;
  /** Rechecked at serialized dispatch (for revocable motion admission). */
  readonly admission?: () => boolean;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function combineAbortSignals(
  session: AbortSignal,
  command: AbortSignal | undefined,
): { readonly signal: AbortSignal; dispose(): void } {
  if (command === undefined) return { signal: session, dispose: () => undefined };
  const controller = new AbortController();
  const dispose = (): void => {
    session.removeEventListener("abort", sessionAborted);
    command.removeEventListener("abort", commandAborted);
  };
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    dispose();
  };
  const sessionAborted = (): void => { abortFrom(session); };
  const commandAborted = (): void => { abortFrom(command); };
  if (session.aborted) abortFrom(session);
  else if (command.aborted) abortFrom(command);
  else {
    session.addEventListener("abort", sessionAborted, { once: true });
    command.addEventListener("abort", commandAborted, { once: true });
  }
  return { signal: controller.signal, dispose };
}

export class AccessorySession {
  private readonly transport: AoaBulkTransport;
  private readonly onCommand?: (frame: DumlFrame) => void;
  private readonly onVideo?: (unit: H264AccessUnit) => void;
  private readonly onError?: (error: Error) => void;
  private readonly envelopes = new AoaEnvelopeSplitter();
  private readonly commands = new DumlSplitter();
  private readonly video = new Pocket2VideoSplitter();
  private abort = new AbortController();
  private writeTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private sequence = 1;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private linkEnabled = false;
  private closed = false;

  constructor(options: AccessorySessionOptions) {
    this.transport = options.transport;
    this.onCommand = options.onCommand;
    this.onVideo = options.onVideo;
    this.onError = options.onError;
  }

  get enabled(): boolean { return this.linkEnabled; }

  /** Called only for FunctionFS ENABLE, after both bulk endpoints are open. */
  enable(): void {
    if (this.closed) throw new Error("accessory session is closed");
    if (this.linkEnabled) return;
    this.linkEnabled = true;
    this.generation += 1;
    this.sequence = 1;
    this.abort = new AbortController();
    this.writeTail = Promise.resolve();
    this.envelopes.reset();
    this.commands.reset();
    this.video.reset();
    const generation = this.generation;
    this.startTimer = setTimeout(() => { void this.opening(generation); }, SESSION_START_DELAY_MS);
  }

  private async opening(generation: number): Promise<void> {
    this.startTimer = undefined;
    try {
      await this.sendCommand({ commandSet: 0, commandId: 0x00 });
      await this.sendCommand({ commandSet: 0, commandId: 0x01 });
      await this.sendCommand({ commandSet: 0, commandId: 0xff });
    } catch {
      return; // writeCommand already surfaced a transport error or disconnect
    }
    if (!this.linkEnabled || generation !== this.generation) return;
    this.livenessTimer = setInterval(() => { void this.liveness(generation); }, SESSION_LIVENESS_MS);
  }

  private async liveness(generation: number): Promise<void> {
    if (!this.linkEnabled || generation !== this.generation) return;
    try {
      // Bench result: heartbeat is fire-and-forget; ping asks for an answer
      // and keeps the H.264 route alive for about two seconds.
      await this.sendCommand({ commandSet: 0, commandId: 0x0e, ack: 0 });
      await this.sendCommand({ commandSet: 0, commandId: 0x00, ack: 1 });
    } catch {
      // writeCommand owns error reporting and link teardown.
    }
  }

  sendCommand(
    command: Omit<DumlCommand, "sequence">,
    options: AccessoryCommandOptions = {},
  ): Promise<void> {
    if (!this.linkEnabled) return Promise.reject(new Error("accessory link is not enabled"));
    if (options.signal?.aborted === true) {
      return Promise.reject(asError(options.signal.reason ?? "accessory command aborted"));
    }
    const frame = encodeDuml({ ...command, sequence: this.sequence });
    this.sequence = (this.sequence + 1) & 0xffff;
    return this.writeFrame(frame, options.signal, options.deadline, options.admission);
  }

  /** Feed bytes read from the enabled FunctionFS bulk OUT endpoint. */
  receive(chunk: Uint8Array): void {
    if (!this.linkEnabled || chunk.length === 0) return;
    for (const envelopeEvent of this.envelopes.push(chunk)) {
      if (envelopeEvent.kind === "error") {
        this.report(envelopeEvent.error);
        continue;
      }
      if (sameRoute(envelopeEvent.route, AOA_COMMAND_ROUTE)) {
        for (const commandEvent of this.commands.push(envelopeEvent.payload)) {
          if (commandEvent.kind === "junk") {
            this.report(new Error(`discarded ${commandEvent.data.length} malformed DUML bytes`));
            continue;
          }
          const frame = commandEvent.frame;
          this.onCommand?.(frame);
          if (!frame.response && frame.ack !== 0) {
            const response = encodeDuml({
              commandSet: frame.commandSet,
              commandId: frame.commandId,
              payload: Uint8Array.of(0),
              sequence: frame.sequence,
              sender: frame.receiver,
              senderIndex: frame.receiverIndex,
              receiver: frame.sender,
              receiverIndex: frame.senderIndex,
              response: true,
              ack: 0,
            });
            void this.writeFrame(response).catch(() => { /* reported by writeFrame */ });
          }
        }
      } else if (sameRoute(envelopeEvent.route, AOA_VIDEO_ROUTE)) {
        for (const videoEvent of this.video.push(envelopeEvent.payload)) {
          if (videoEvent.kind === "error") this.report(videoEvent.error);
          else if (videoEvent.kind === "unit") this.onVideo?.(videoEvent.unit);
        }
      } else {
        this.report(new Error(`unknown AOA route ${Buffer.from(envelopeEvent.route).toString("hex")}`));
      }
    }
  }

  disconnect(reason?: unknown): void {
    if (reason !== undefined) this.report(asError(reason));
    this.stop("accessory session disconnected");
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    if (reason !== undefined) this.report(asError(reason));
    this.closed = true;
    this.stop("accessory session closed");
  }

  private writeFrame(frame: Uint8Array, commandSignal?: AbortSignal, deadline?: number, admission?: () => boolean): Promise<void> {
    if (!this.linkEnabled) return Promise.reject(new Error("accessory link is not enabled"));
    const generation = this.generation;
    const sessionSignal = this.abort.signal;
    const combined = combineAbortSignals(sessionSignal, commandSignal);
    const envelope = encodeAoaEnvelope(AOA_COMMAND_ROUTE, frame);
    let admitted = true;
    let dispatched = false;
    const pending = this.writeTail.then(async () => {
      try {
        if (!this.linkEnabled || generation !== this.generation || combined.signal.aborted) {
          throw asError(combined.signal.reason ?? "accessory session disconnected");
        }
        if (admission !== undefined && !admission()) {
          admitted = false;
          throw new Error("accessory command admission expired");
        }
        // Command cancellation remains authoritative through the synchronous
        // admission above. From this point the one physical write is already
        // committed: only link/session teardown may abort it. Its original
        // deadline remains unchanged and still bounds completion.
        combined.dispose();
        dispatched = true;
        await this.transport.write(envelope, sessionSignal, deadline);
      } finally {
        combined.dispose();
      }
    });
    this.writeTail = pending.catch(() => undefined);
    return pending.catch((reason: unknown) => {
      const error = asError(reason);
      if (admitted && this.linkEnabled && generation === this.generation
        && !sessionSignal.aborted && (dispatched || commandSignal?.aborted !== true)) {
        this.report(error);
        this.stop("accessory session disconnected after transport error");
      }
      throw error;
    });
  }

  private report(error: Error): void { this.onError?.(error); }

  private stop(message: string): void {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    if (this.livenessTimer !== undefined) clearInterval(this.livenessTimer);
    this.startTimer = undefined;
    this.livenessTimer = undefined;
    this.linkEnabled = false;
    this.generation += 1;
    if (!this.abort.signal.aborted) this.abort.abort(new Error(message));
    this.envelopes.reset();
    this.commands.reset();
    this.video.reset();
  }
}
