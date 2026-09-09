// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ardupilotmega, common, minimal, MavLinkProtocolV1, MavLinkProtocolV2 } from "node-mavlink";
import { decodeDatagram } from "./protocol.js";
describe("MAVLink datagrams", () => {
  it("decodes checksum-validated v1 and truncated-v2 payloads in receipt order", () => {
    const hb = Object.assign(new minimal.Heartbeat(), { autopilot: 3, type: 1, customMode: 10, baseMode: 129 });
    const ack = Object.assign(new common.CommandAck(), { command: 176, result: 0 });
    const bytes = Buffer.concat([new MavLinkProtocolV1(1, 1).serialize(hb, 1), new MavLinkProtocolV2(1, 1).serialize(ack, 2)]);
    const frames = decodeDatagram(bytes);
    expect(frames.map(x => [x.system, x.component, x.id])).toEqual([[1, 1, 0], [1, 1, 77]]);
    expect((frames[0].data as minimal.Heartbeat).customMode).toBe(10);
    expect((frames[1].data as common.CommandAck).targetSystem).toBe(0);
  });
  it("rejects corruption, signed frames without configured verification, and cross-datagram fragments", () => {
    const p = new MavLinkProtocolV2(1, 1), m = new minimal.Heartbeat();
    const good = p.serialize(m, 1), bad = Buffer.from(good); bad[10] ^= 1;
    expect(decodeDatagram(bad)).toEqual([]);
    expect(decodeDatagram(good.subarray(0, 10))).toEqual([]);
    expect(decodeDatagram(good.subarray(10))).toEqual([]);
    const signing = new MavLinkProtocolV2(1, 1, MavLinkProtocolV2.IFLAG_SIGNED);
    const signed = signing.sign(signing.serialize(m, 1), 1, Buffer.alloc(32, 3));
    expect(decodeDatagram(signed)).toEqual([]);
  });
  it("does not reinterpret the payload of an unsupported signed frame as unsigned telemetry", () => {
    const inner=new MavLinkProtocolV2(42,1).serialize(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1}),1);
    const payload=Array(64).fill(0);inner.forEach((b,i)=>payload[i]=b);
    const p=new MavLinkProtocolV2(1,1,1),message=Object.assign(new ardupilotmega.Data64(),{type:0,len:inner.length,data:payload});
    expect(decodeDatagram(p.sign(p.serialize(message,1),1,Buffer.alloc(32,3)))).toEqual([]);
  });
});
