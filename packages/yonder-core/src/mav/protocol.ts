// SPDX-License-Identifier: GPL-3.0-or-later
import { ardupilotmega, common, minimal, standard, MavLinkProtocolV1, MavLinkProtocolV2, x25crc, type MavLinkData, type MavLinkPacketRegistry } from "node-mavlink";
export interface DecodedFrame { system: number; component: number; id: number; data: MavLinkData }
const REGISTRY: MavLinkPacketRegistry = { ...minimal.REGISTRY, ...standard.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY };
/** UDP boundary handling only; node-mavlink owns dialect, checksum and field decoding. */
export function decodeDatagram(bytes: Uint8Array): DecodedFrame[] {
  const buffer = Buffer.from(bytes), found: DecodedFrame[] = [];
  if (buffer.length > 65535) return found;
  for (let i = 0; i < buffer.length;) {
    const v2 = buffer[i] === 0xfd;
    if (!v2 && buffer[i] !== 0xfe) { i++; continue; }
    const headerLength = v2 ? 10 : 6;
    if (i + headerLength > buffer.length) break;
    const flags = v2 ? buffer[i + 2] : 0;
    const length = headerLength + buffer[i + 1] + 2 + ((flags & 1) ? 13 : 0);
    if (i + length > buffer.length) { i++; continue; }
    // Unsupported envelopes are opaque: their payload may itself contain packet-looking bytes.
    if (flags !== 0) { i += length; continue; }
    const packet = buffer.subarray(i, i + length);
    const protocol = v2 ? new MavLinkProtocolV2() : new MavLinkProtocolV1();
    try {
      const header = protocol.header(packet), clazz = REGISTRY[header.msgid];
      if (!clazz || protocol.crc(packet) !== x25crc(packet, 1, 2, clazz.MAGIC_NUMBER)) { i++; continue; }
      const data = protocol.data(protocol.payload(packet), clazz);
      found.push({ system: header.sysid, component: header.compid, id: header.msgid, data });
      i += length;
    } catch { i++; }
  }
  return found;
}
