// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AOA_COMMAND_ROUTE,
  AOA_VIDEO_ROUTE,
  AoaEnvelopeSplitter,
  AccessorySession,
  MAX_AOA_PAYLOAD,
  aoaSetupResponse,
  encodeAoaEnvelope,
  functionFsDescriptors,
  functionFsStrings,
  type AoaBulkTransport,
} from "./aoa.js";
import { decodeDuml, encodeDuml } from "./duml.js";

const bytes = (hex: string): Uint8Array => Uint8Array.from(
  hex.split(/\s+/).filter(Boolean).map((part) => Number.parseInt(part, 16)),
);
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function videoRecord(data: Uint8Array, timestamp = 0x12345678): Uint8Array {
  const record = new Uint8Array(16 + data.length);
  const view = new DataView(record.buffer);
  record.set(bytes("00 00 01 ff"), 0);
  view.setUint16(4, data.length, true);
  view.setUint16(6, 0x00ff, true);
  view.setUint32(8, 0x89abcdef, true);
  view.setUint32(12, timestamp, true);
  record.set(data, 16);
  return record;
}

describe("AOA FunctionFS helpers", () => {
  it("matches the Python accessory descriptors and strings byte for byte", () => {
    expect(hex(functionFsDescriptors("accessory"))).toBe(
      "0300000042000000c30000000300000003000000" +
      "0904000002ffff00010705810240000007050102400000" +
      "0904000002ffff00010705810200020007050102000200",
    );
    expect(hex(functionFsStrings())).toBe("020000001600000001000000010000000904616f6100");
  });

  it("matches the Python phone descriptor before accessory re-enumeration", () => {
    expect(hex(functionFsDescriptors("phone"))).toBe(
      "0300000026000000c30000000100000001000000" +
      "0904000000ff4200010904000000ff420001",
    );
  });

  it("answers only valid AOA setup requests", () => {
    expect(aoaSetupResponse({ requestType: 0xc0, request: 51, value: 0, index: 0, length: 2 }))
      .toEqual({ kind: "reply", data: bytes("02 00") });
    expect(aoaSetupResponse(
      { requestType: 0x40, request: 52, value: 0, index: 1, length: 9 },
      new TextEncoder().encode("Pocket 2\0"),
    )).toEqual({ kind: "string", name: "model", value: "Pocket 2" });
    expect(aoaSetupResponse({ requestType: 0x40, request: 53, value: 0, index: 0, length: 0 }))
      .toEqual({ kind: "start" });
    expect(aoaSetupResponse({ requestType: 0x80, request: 51, value: 0, index: 0, length: 2 }))
      .toBeNull();
    expect(aoaSetupResponse({ requestType: 0xc0, request: 51, value: 0, index: 0, length: 1 }))
      .toBeNull();
  });
});

describe("AoaEnvelopeSplitter", () => {
  it("reassembles the command and video routes across every chunk boundary, including split magic", () => {
    const command = encodeAoaEnvelope(AOA_COMMAND_ROUTE, bytes("01 02 03"));
    const video = encodeAoaEnvelope(AOA_VIDEO_ROUTE, bytes("00 00 01 67"));
    const stream = Uint8Array.from([...command, ...video]);
    for (let cut = 1; cut < stream.length; cut += 1) {
      const splitter = new AoaEnvelopeSplitter();
      const envelopes = [
        ...splitter.push(stream.subarray(0, cut)),
        ...splitter.push(stream.subarray(cut)),
      ].filter((event) => event.kind === "envelope");
      expect(envelopes.map((event) => [hex(event.route), hex(event.payload)]))
        .toEqual([["4957", "010203"], ["4a57", "00000167"]]);
    }
  });

  it("rejects an oversized length and finds the next valid envelope", () => {
    const malformed = new Uint8Array(8);
    malformed.set(bytes("55 cc 49 57"));
    new DataView(malformed.buffer).setUint32(4, MAX_AOA_PAYLOAD + 1, true);
    const good = encodeAoaEnvelope(AOA_COMMAND_ROUTE, bytes("55"));
    const events = new AoaEnvelopeSplitter().push(Uint8Array.from([...malformed, ...good]));
    expect(events.filter((event) => event.kind === "error")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "envelope")).toMatchObject([
      { route: AOA_COMMAND_ROUTE, payload: bytes("55") },
    ]);
  });

  it("keeps only a possible split magic byte from arbitrary noise", () => {
    const splitter = new AoaEnvelopeSplitter();
    const events = splitter.push(Uint8Array.from([...new Uint8Array(100_000).fill(0x41), 0x55]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect(splitter.bufferedBytes).toBe(1);
    expect(splitter.push(Uint8Array.from([0xcc, 0x49, 0x57, 1, 0, 0, 0, 0xaa])))
      .toMatchObject([{ kind: "envelope", route: AOA_COMMAND_ROUTE, payload: bytes("aa") }]);
  });
});

describe("AccessorySession", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function recordingTransport(): AoaBulkTransport & { writes: Uint8Array[] } {
    const writes: Uint8Array[] = [];
    return { writes, write: async (data) => { writes.push(data.slice()); } };
  }

  function writtenCommands(writes: Uint8Array[]) {
    const splitter = new AoaEnvelopeSplitter();
    return writes.flatMap((write) => splitter.push(write))
      .filter((event) => event.kind === "envelope")
      .map((event) => decodeDuml(event.payload));
  }

  it("says nothing before enable, then sends the bench opening and 1 Hz liveness pair", async () => {
    const transport = recordingTransport();
    const session = new AccessorySession({ transport });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.writes).toEqual([]);

    session.enable();
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(writtenCommands(transport.writes)).toMatchObject([
      { commandSet: 0, commandId: 0x00, ack: 1, sequence: 1 },
      { commandSet: 0, commandId: 0x01, ack: 1, sequence: 2 },
      { commandSet: 0, commandId: 0xff, ack: 1, sequence: 3 },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(writtenCommands(transport.writes).slice(-2)).toMatchObject([
      { commandSet: 0, commandId: 0x0e, ack: 0, sequence: 4 },
      { commandSet: 0, commandId: 0x00, ack: 1, sequence: 5 },
    ]);
    session.close();
  });

  it("delivers raw DUML command state and parsed H264 on separate callbacks", () => {
    const commands: ReturnType<typeof decodeDuml>[] = [];
    const video: { data: Uint8Array; timestamp: number }[] = [];
    const session = new AccessorySession({
      transport: recordingTransport(),
      onCommand: (frame) => { commands.push(frame); },
      onVideo: (unit) => { video.push(unit); },
    });
    session.enable();
    const command = encodeAoaEnvelope(AOA_COMMAND_ROUTE, encodeDuml({
      commandSet: 4, commandId: 0x05, sequence: 92, payload: bytes("01 02"),
    }));
    const h264 = bytes("00 00 00 01 67 64 00 1f");
    const image = encodeAoaEnvelope(AOA_VIDEO_ROUTE, videoRecord(h264));
    const stream = Uint8Array.from([...command, ...image]);
    for (const byte of stream) session.receive(Uint8Array.of(byte));

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ commandSet: 4, commandId: 0x05, sequence: 92 });
    expect(commands[0]?.raw).toEqual(command.subarray(8));
    expect(video).toEqual([{ data: h264, timestamp: 0x12345678, metadata: 0x89abcdef }]);
    session.close();
  });

  it("reassembles one H264 access unit split across video envelopes", () => {
    const video: Uint8Array[] = [];
    const errors: Error[] = [];
    const session = new AccessorySession({
      transport: recordingTransport(),
      onVideo: (unit) => { video.push(unit.data); },
      onError: (error) => { errors.push(error); },
    });
    session.enable();
    const h264 = bytes("00 00 00 01 65 aa bb cc dd");
    const record = videoRecord(h264);
    session.receive(encodeAoaEnvelope(AOA_VIDEO_ROUTE, record.subarray(0, 11)));
    expect(video).toEqual([]);
    session.receive(encodeAoaEnvelope(AOA_VIDEO_ROUTE, record.subarray(11)));
    expect(video).toEqual([h264]);
    expect(errors).toEqual([]);
    session.close();
  });

  it("acknowledges unsolicited requests with status 00, matching sequence and reversed address", async () => {
    const transport = recordingTransport();
    const session = new AccessorySession({ transport });
    session.enable();
    const request = encodeDuml({
      commandSet: 2,
      commandId: 0x80,
      sequence: 0x2468,
      sender: 1,
      senderIndex: 3,
      receiver: 2,
      receiverIndex: 1,
      ack: 1,
      payload: bytes("80 04 00"),
    });
    session.receive(encodeAoaEnvelope(AOA_COMMAND_ROUTE, request));
    await flush();

    expect(writtenCommands(transport.writes)).toMatchObject([{
      commandSet: 2,
      commandId: 0x80,
      sequence: 0x2468,
      sender: 2,
      senderIndex: 1,
      receiver: 1,
      receiverIndex: 3,
      response: true,
      ack: 0,
      payload: bytes("00"),
    }]);
    session.close();
  });

  it("exposes an explicit command API on the command route", async () => {
    const transport = recordingTransport();
    const session = new AccessorySession({ transport });
    await expect(session.sendCommand({ commandSet: 2, commandId: 0x2a, payload: bytes("03") }))
      .rejects.toThrow(/enabled/);
    session.enable();
    await session.sendCommand({ commandSet: 2, commandId: 0x2a, payload: bytes("03") });
    const [sent] = writtenCommands(transport.writes);
    expect(sent).toMatchObject({ commandSet: 2, commandId: 0x2a, payload: bytes("03") });
    session.close();
  });

  it("aborts an active write and rejects queued writes on disconnect", async () => {
    let signal: AbortSignal | undefined;
    const transport: AoaBulkTransport = {
      write: (_data, active) => new Promise<void>((_resolve, reject) => {
        signal = active;
        active.addEventListener("abort", () => reject(active.reason), { once: true });
      }),
    };
    const session = new AccessorySession({ transport });
    session.enable();
    const first = session.sendCommand({ commandSet: 2, commandId: 1 });
    const queued = session.sendCommand({ commandSet: 2, commandId: 2 });
    await flush();
    expect(signal?.aborted).toBe(false);
    session.disconnect();
    expect(signal?.aborted).toBe(true);
    await expect(first).rejects.toThrow(/disconnected/);
    await expect(queued).rejects.toThrow(/disconnected/);
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it("surfaces transport and malformed-input errors and stops the link", async () => {
    const errors: Error[] = [];
    const session = new AccessorySession({
      transport: { write: async () => { throw new Error("endpoint shutdown"); } },
      onError: (error) => { errors.push(error); },
    });
    session.enable();
    await expect(session.sendCommand({ commandSet: 0, commandId: 1 }))
      .rejects.toThrow("endpoint shutdown");
    expect(errors.map((error) => error.message)).toEqual(["endpoint shutdown"]);
    expect(session.enabled).toBe(false);

    session.enable();
    const malformed = new Uint8Array(8);
    malformed.set(bytes("55 cc 49 57"));
    new DataView(malformed.buffer).setUint32(4, MAX_AOA_PAYLOAD + 1, true);
    session.receive(malformed);
    expect(errors.at(-1)?.message).toMatch(/payload length/);
    session.close();
  });

  it("close cancels liveness permanently", async () => {
    const transport = recordingTransport();
    const session = new AccessorySession({ transport });
    session.enable();
    session.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.writes).toEqual([]);
    expect(() => session.enable()).toThrow(/closed/);
  });
});
