// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * DUML v1, DJI's device command protocol.
 *
 * The wire layout and CRC parameters are ported from
 * `scripts/pocket2/duml.py`. That reference records their provenance in the
 * public dji-firmware-tools Wireshark dissector and `comm_mkdupc.py`:
 *
 *   0      SOF 0x55
 *   1..2   length (10 bits) | version (6 bits), little endian
 *   3      CRC8 over bytes 0..2
 *   4..5   sender and receiver type (low 5 bits), index (high 3 bits)
 *   6..7   sequence, little endian
 *   8      response bit 7, acknowledgement bits 5..6, encryption bits 0..2
 *   9..10  command set and command id
 *   11..   payload
 *   last 2 CRC16 over everything before it, little endian
 */

export const DUML_SOF = 0x55;
export const MIN_DUML_FRAME = 13;
export const MAX_DUML_FRAME = 0x3ff;
export const MAX_DUML_PAYLOAD = MAX_DUML_FRAME - MIN_DUML_FRAME;

export const DEV_CAMERA = 1;
export const DEV_APP = 2;
export const DEV_GIMBAL = 4;
export const DEV_RC = 6;
export const DEV_PC = 10;

const CRC8_SEED = 0x77;
const CRC16_SEED = 0x3692;

export function crc8(data: Uint8Array, seed = CRC8_SEED): number {
  let crc = seed & 0xff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
    }
  }
  return crc & 0xff;
}

export function crc16(data: Uint8Array, seed = CRC16_SEED): number {
  let crc = seed & 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

export interface DumlCommand {
  readonly commandSet: number;
  readonly commandId: number;
  readonly payload?: Uint8Array;
  readonly sequence?: number;
  readonly sender?: number;
  readonly senderIndex?: number;
  readonly receiver?: number;
  readonly receiverIndex?: number;
  readonly response?: boolean;
  readonly ack?: number;
  readonly encryption?: number;
  readonly version?: number;
}

export interface DumlFrame {
  readonly raw: Uint8Array;
  readonly length: number;
  readonly version: number;
  readonly sender: number;
  readonly senderIndex: number;
  readonly receiver: number;
  readonly receiverIndex: number;
  readonly sequence: number;
  readonly response: boolean;
  readonly ack: number;
  readonly encryption: number;
  readonly commandSet: number;
  readonly commandId: number;
  readonly payload: Uint8Array;
}

function integer(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function device(type: number, index: number): number {
  return integer("device type", type, 0, 0x1f)
    | (integer("device index", index, 0, 7) << 5);
}

export function encodeDuml(command: DumlCommand): Uint8Array {
  const payload = command.payload?.slice() ?? new Uint8Array(0);
  if (payload.length > MAX_DUML_PAYLOAD) {
    throw new RangeError(`payload must be at most ${MAX_DUML_PAYLOAD} bytes`);
  }

  const length = MIN_DUML_FRAME + payload.length;
  const version = integer("version", command.version ?? 1, 0, 0x3f);
  const sequence = integer("sequence", command.sequence ?? 0, 0, 0xffff);
  const ack = integer("ack", command.ack ?? 1, 0, 3);
  const encryption = integer("encryption", command.encryption ?? 0, 0, 7);
  const commandSet = integer("commandSet", command.commandSet, 0, 0xff);
  const commandId = integer("commandId", command.commandId, 0, 0xff);

  const frame = new Uint8Array(length);
  const view = new DataView(frame.buffer);
  frame[0] = DUML_SOF;
  view.setUint16(1, length | (version << 10), true);
  frame[3] = crc8(frame.subarray(0, 3));
  frame[4] = device(command.sender ?? DEV_APP, command.senderIndex ?? 1);
  frame[5] = device(command.receiver ?? DEV_CAMERA, command.receiverIndex ?? 0);
  view.setUint16(6, sequence, true);
  frame[8] = (command.response === true ? 0x80 : 0) | (ack << 5) | encryption;
  frame[9] = commandSet;
  frame[10] = commandId;
  frame.set(payload, 11);
  view.setUint16(length - 2, crc16(frame.subarray(0, length - 2)), true);
  return frame;
}

/** Strictly decode exactly one complete, valid DUML frame. */
export function decodeDuml(input: Uint8Array): DumlFrame | null {
  if (input.length < MIN_DUML_FRAME || input.length > MAX_DUML_FRAME) return null;
  if (input[0] !== DUML_SOF || crc8(input.subarray(0, 3)) !== input[3]) return null;

  const source = input.slice();
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const lengthVersion = view.getUint16(1, true);
  const length = lengthVersion & 0x3ff;
  if (length !== source.length || length < MIN_DUML_FRAME) return null;
  const sentCrc = view.getUint16(length - 2, true);
  if (crc16(source.subarray(0, length - 2)) !== sentCrc) return null;

  const commandType = source[8]!;
  return {
    raw: source,
    length,
    version: lengthVersion >>> 10,
    sender: source[4]! & 0x1f,
    senderIndex: source[4]! >>> 5,
    receiver: source[5]! & 0x1f,
    receiverIndex: source[5]! >>> 5,
    sequence: view.getUint16(6, true),
    response: (commandType & 0x80) !== 0,
    ack: (commandType >>> 5) & 3,
    encryption: commandType & 7,
    commandSet: source[9]!,
    commandId: source[10]!,
    payload: source.slice(11, length - 2),
  };
}

export type DumlSplitPart =
  | { readonly kind: "frame"; readonly frame: DumlFrame }
  | { readonly kind: "junk"; readonly data: Uint8Array };

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/** Reassembles frames from arbitrary bulk chunks without trusting a bad length. */
export class DumlSplitter {
  private buffer: Uint8Array = new Uint8Array(0);

  get bufferedBytes(): number { return this.buffer.length; }

  reset(): void { this.buffer = new Uint8Array(0); }

  push(chunk: Uint8Array): DumlSplitPart[] {
    this.buffer = concat(this.buffer, chunk);
    const parts: DumlSplitPart[] = [];

    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf(DUML_SOF);
      if (start < 0) {
        parts.push({ kind: "junk", data: this.buffer });
        this.buffer = new Uint8Array(0);
        break;
      }
      if (start > 0) {
        parts.push({ kind: "junk", data: this.buffer.slice(0, start) });
        this.buffer = this.buffer.slice(start);
      }
      if (this.buffer.length < 4) break;

      if (crc8(this.buffer.subarray(0, 3)) !== this.buffer[3]) {
        parts.push({ kind: "junk", data: this.buffer.slice(0, 1) });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const length = (this.buffer[1]! | (this.buffer[2]! << 8)) & 0x3ff;
      if (length < MIN_DUML_FRAME) {
        parts.push({ kind: "junk", data: this.buffer.slice(0, 1) });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < length) break;

      const frame = decodeDuml(this.buffer.subarray(0, length));
      if (frame === null) {
        parts.push({ kind: "junk", data: this.buffer.slice(0, 1) });
        this.buffer = this.buffer.slice(1);
        continue;
      }
      parts.push({ kind: "frame", frame });
      this.buffer = this.buffer.slice(length);
    }
    return parts;
  }
}
