// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Enough MAVLink to recognise a heartbeat, and no more (§1).
 *
 * M5a reads nothing but heartbeats, which is a boundary chosen to defer a
 * decision rather than to make one: which library, which dialect, v1 or v2,
 * signed or not. Recognising one message needs none of that. When M5b needs
 * the rest it takes a dependency and this file goes away; growing it into a
 * MAVLink library one message at a time is how that decision gets made by
 * accident.
 */

const V1 = 0xfe;
const V2 = 0xfd;
const HEARTBEAT = 0;
/** The message-definition checksum MAVLink appends before the CRC. */
const HEARTBEAT_CRC_EXTRA = 50;
const MAV_TYPE_GCS = 6;
/** What every component that is not an autopilot puts in the autopilot field. */
const MAV_AUTOPILOT_INVALID = 8;

/** X25 / CRC-16-MCRF4XX, one byte at a time — MAVLink's own accumulator. */
function accumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

export interface Heartbeat {
  system: number;
  component: number;
  vehicleType: number;
  autopilot: number;
  /**
   * A ground station heartbeats back, which is what makes §6's "someone is
   * listening" a measurement rather than an assumption — and also what would
   * make a naive reader think the aircraft had two autopilots.
   */
  fromVehicle: boolean;
}

const VEHICLES: Record<number, string> = {
  1: "ArduPlane", 2: "ArduCopter", 4: "Helicopter", 6: "Ground station",
  10: "Rover", 11: "Boat", 12: "Submarine", 13: "Hexacopter",
  14: "Octocopter", 15: "Tricopter", 19: "VTOL", 20: "VTOL",
};

export function describeVehicle(h: Heartbeat): string {
  return VEHICLES[h.vehicleType] ?? `Vehicle type ${h.vehicleType}`;
}

export class HeartbeatScanner {
  private buffer = new Uint8Array(0);
  rejected = 0;

  push(chunk: Uint8Array): Heartbeat[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const found: Heartbeat[] = [];
    let i = 0;
    while (i < this.buffer.length) {
      const magic = this.buffer[i];
      if (magic !== V1 && magic !== V2) { i += 1; continue; }
      const headerLength = magic === V2 ? 10 : 6;
      if (i + headerLength > this.buffer.length) break;       // need more bytes to even read the header

      // msgid lives inside the fixed-size header, so it is readable as soon
      // as the header itself is — *before* the payload length claimed by
      // that same header has been trusted for anything. Only HEARTBEAT
      // carries a CRC_EXTRA we know, so only HEARTBEAT can be checksummed;
      // everything else is resynced past one byte at a time, regardless of
      // what length it claims.
      const messageId = magic === V2
        ? this.buffer[i + 7] | (this.buffer[i + 8] << 8) | (this.buffer[i + 9] << 16)
        : this.buffer[i + 5];
      if (messageId !== HEARTBEAT) { i += 1; continue; }

      const payloadLength = this.buffer[i + 1];
      const signed = magic === V2 && (this.buffer[i + 2] & 0x01) !== 0;
      const total = headerLength + payloadLength + 2 + (signed ? 13 : 0);

      // A length we have not checksummed is a number a noise byte can invent,
      // and skipping by it steps *over* whatever follows. A bogus header
      // claiming to be a 21-byte HEARTBEAT, followed by a real one, must not
      // swallow the real frame — but that trap is already closed above: a
      // bogus header only reaches here at all once its msgid has passed as
      // HEARTBEAT, which noise does not do on purpose. What is left to
      // handle here is the ordinary streaming case, so an unverified-but-
      // plausible frame short of bytes so far is waited for, never skipped
      // past by its own claim.
      if (i + total > this.buffer.length) break;

      let crc = 0xffff;
      for (let k = i + 1; k < i + headerLength + payloadLength; k += 1) crc = accumulate(this.buffer[k], crc);
      crc = accumulate(HEARTBEAT_CRC_EXTRA, crc);

      const sent = this.buffer[i + headerLength + payloadLength] | (this.buffer[i + headerLength + payloadLength + 1] << 8);
      if (crc !== sent) { this.rejected += 1; i += 1; continue; }  // resync from the next byte

      const payload = this.buffer.subarray(i + headerLength, i + headerLength + payloadLength);
      const vehicleType = payload[4] ?? 0;
      const autopilot = payload[5] ?? 0;
      found.push({
        system: this.buffer[i + (magic === V2 ? 5 : 3)],
        component: this.buffer[i + (magic === V2 ? 6 : 4)],
        vehicleType,
        autopilot,
        // "Not a ground station" is not "an autopilot". Cameras, gimbals,
        // ADS-B receivers and the router itself all heartbeat, all with a
        // vehicle type that is not GCS — a Pocket 2 on the same bus would be
        // detected as the aircraft. What marks a *flight controller* is an
        // autopilot field that names one: MAV_AUTOPILOT_INVALID (8) is what
        // every non-autopilot component sends, including a GCS.
        fromVehicle: autopilot !== MAV_AUTOPILOT_INVALID && vehicleType !== MAV_TYPE_GCS,
      });
      i += total;
    }
    this.buffer = this.buffer.subarray(i);
    return found;
  }
}
