// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HeartbeatScanner, describeVehicle } from "./frame.js";
import { heartbeatV2 } from "./testing.js";

describe("HeartbeatScanner", () => {
  it("finds a heartbeat and reports the vehicle it came from", () => {
    const s = new HeartbeatScanner();
    const [hb] = s.push(heartbeatV2(1, 1, 3)); // fixed wing, ArduPilot
    expect(hb).toMatchObject({ system: 1, vehicleType: 1, autopilot: 3, fromVehicle: true });
    expect(describeVehicle(hb)).toBe("ArduPlane");
  });

  it("tells a ground station's heartbeat from a vehicle's (§6)", () => {
    const s = new HeartbeatScanner();
    const [hb] = s.push(heartbeatV2(255, 6, 8)); // MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID
    expect(hb.fromVehicle).toBe(false);
  });

  // A camera on the same bus heartbeats with a vehicle type that is not GCS.
  // "Not a ground station" would accept it as the aircraft.
  it("does not mistake a camera or a gimbal for a flight controller", () => {
    const s = new HeartbeatScanner();
    const [cam] = s.push(heartbeatV2(1, 30, 8)); // MAV_TYPE_CAMERA, no autopilot
    expect(cam.fromVehicle).toBe(false);
  });

  // A false header's length is a number noise can invent; skipping by it steps
  // over whatever follows.
  it("finds a heartbeat hidden behind a bogus header that claims its length", () => {
    const s = new HeartbeatScanner();
    const bogus = Uint8Array.from([0xfd, 21, 0, 0, 0, 1, 1, 99, 0, 0]);
    const found = s.push(Uint8Array.from([...bogus, ...heartbeatV2(1, 1, 3)]));
    expect(found).toHaveLength(1);
  });

  it("survives being fed one byte at a time", () => {
    const s = new HeartbeatScanner();
    const frame = heartbeatV2(1, 2, 3);
    const found = frame.reduce<number>((n, b) => n + s.push(Uint8Array.of(b)).length, 0);
    expect(found).toBe(1);
  });

  it("counts a frame whose checksum fails and does not emit it", () => {
    const s = new HeartbeatScanner();
    const bad = heartbeatV2(1, 1, 3);
    bad[bad.length - 1] ^= 0xff;
    expect(s.push(bad)).toEqual([]);
    expect(s.rejected).toBe(1);
  });

  it("finds a good frame that follows garbage — this is what a wrong baud looks like", () => {
    const s = new HeartbeatScanner();
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
    const found = s.push(Uint8Array.from([...noise, ...heartbeatV2(1, 1, 3)]));
    expect(found).toHaveLength(1);
  });
});
