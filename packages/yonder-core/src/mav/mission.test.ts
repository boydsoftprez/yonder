// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { common, MavLinkProtocolV2 } from "node-mavlink";
import { decodeMissionItem, encodeMissionItem, missionRevision, validateMission, verifyMission } from "./mission.js";
import { decodeDatagram } from "./protocol.js";
import type { MissionItem } from "./types.js";
const item = (changes: Partial<MissionItem> = {}): MissionItem => ({ seq: 0, command: 183, frame: 2, params: [9, 1500, null, null], x: 0, y: 0, z: null, current: false, autocontinue: true, ...changes });
describe("mission wire semantics", () => {
  it("preserves integer non-position payloads and null defaults through actual MAVLink bytes", () => {
    const original = item({ command: 1000, frame: 0, x: 4, y: 8 });
    const bytes = new MavLinkProtocolV2(1, 1).serialize(encodeMissionItem(original), 0);
    const decoded = decodeMissionItem(decodeDatagram(bytes)[0].data as common.MissionItemInt);
    expect(decoded).toEqual(original);
  });
  it("preserves unknown commands for roundtrip instead of deleting them from the mission", () => {
    const original = item({ command: 65000 }); expect(validateMission([original])).toBeNull();
    expect(decodeMissionItem(encodeMissionItem(original))).toEqual(original);
  });
  it("retains received default sentinels even when the authored upload form requires a value", () => {
    const received=item({command:65000,x:null,y:null});
    expect(validateMission([received],false)).toBeNull();
    expect(validateMission([received])).not.toBeNull();
  });
  it("checks catalog integer, enumeration and bitmask limits without asserting peripheral execution", () => {
    expect(validateMission([item({params:[1,1500.5,null,null]})])).toMatch(/PWM|integer/);
    expect(validateMission([item({command:181,params:[1,7,null,null]})])).toMatch(/option|setting/i);
  });
  it("accepts frame aliases and actual home normalization but catches changed coordinates", () => {
    const expected=[item({command:16,frame:0,x:35,y:-83,z:300,params:[0,0,0,0]}),item({seq:1,command:16,frame:3,x:35.2,y:-83.2,z:100,params:[0,0,0,0]})];
    const actual=structuredClone(expected);actual[0].z=302;actual[1].frame=6;actual[1].z=100.005;
    expect(verifyMission(expected,actual)).toEqual([]);actual[1].x!+=1e-5;expect(verifyMission(expected,actual)).toHaveLength(1);
  });
  it("keeps the ArduPlane home reference out of an opted-in content revision only", () => {
    const mission=[item({command:16,frame:0,x:35,y:-83,z:300,params:[0,0,0,0]}),item({seq:1,command:16,frame:3,x:35.2,y:-83.2,z:100,params:[0,0,0,0]})];
    const homeDrift=structuredClone(mission);homeDrift[0].x=35.00001;homeDrift[0].y=-83.00001;homeDrift[0].z=302;
    expect(missionRevision(homeDrift)).not.toBe(missionRevision(mission));
    expect(missionRevision(homeDrift,{ardupilotHome:true})).toBe(missionRevision(mission,{ardupilotHome:true}));
    const changedWaypoint=structuredClone(homeDrift);changedWaypoint[1].z=101;
    expect(missionRevision(changedWaypoint,{ardupilotHome:true})).not.toBe(missionRevision(mission,{ardupilotHome:true}));
    const changedHomeStructure=structuredClone(homeDrift);changedHomeStructure[0].params[0]=1;
    expect(missionRevision(changedHomeStructure,{ardupilotHome:true})).not.toBe(missionRevision(mission,{ardupilotHome:true}));
    const localFirst=structuredClone(mission);localFirst[0].frame=3;localFirst[0].x=35.00001;
    expect(missionRevision(localFirst,{ardupilotHome:true})).not.toBe(missionRevision(mission,{ardupilotHome:true}));
  });
});
