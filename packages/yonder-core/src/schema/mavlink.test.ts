// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { RESERVED_ENDPOINT_NAMES } from "../mav/router/config.js";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";

describe("the mavlink section", () => {
  it("defaults to auto detection, no endpoints, tcp on, autocast on, loopback ingest", () => {
    expect(DEFAULT_CONFIG.mavlink).toEqual({
      serial: { device: "auto", baud: "auto" },
      endpoints: [],
      tcp_server: { enabled: true, port: 5760 },
      autocast: true,
      ingest: { loopback_only: true },
    });
  });

  it("takes three ground stations and refuses a fourth (R-MAV-03)", () => {
    const three = [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
      { name: "gcs2", host: "10.147.20.9", port: 14552 },
    ];
    expect(ConfigSchema.parse({ ...DEFAULT_CONFIG, mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: three } })
      .mavlink.endpoints).toHaveLength(3);
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [...three, { name: "gcs3", host: "1.2.3.4", port: 14553 }] },
    })).toThrow();
  });

  // R-MAV-15. router/config.ts keys mavlink-router's own generated sections
  // by name; a ground station reusing one of `autopilot`, `yonder` or
  // `inbound` produces two identically-headed sections in the generated
  // file, and the router keeps one and silently drops the other.
  it("refuses a ground station named after one of the router's own reserved endpoints (R-MAV-15)", () => {
    for (const reserved of RESERVED_ENDPOINT_NAMES) {
      expect(() => ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [{ name: reserved, host: "192.168.2.10", port: 14550 }] },
      })).toThrow(new RegExp(`${reserved}.*reserved`, "i"));
    }
  });

  it("refuses two ground stations that share a name (R-MAV-15)", () => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [
        { name: "gcs0", host: "192.168.2.10", port: 14550 },
        { name: "gcs0", host: "10.147.20.8", port: 14551 },
      ] },
    })).toThrow(/gcs0.*already/i);
  });

  it("accepts an ordinary set of distinct, unreserved ground-station names", () => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [
        { name: "gcs0", host: "192.168.2.10", port: 14550 },
        { name: "gcs1", host: "10.147.20.8", port: 14551 },
      ] },
    })).not.toThrow();
  });

  it("accepts a pinned device and baud, and refuses a baud outside the sweep", () => {
    const pinned = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 57600 } },
    });
    expect(pinned.mavlink.serial).toEqual({ device: "/dev/ttyAMA0", baud: 57600 });
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 9600 } },
    })).toThrow();
  });

  // R-MAV-14. mavlink-router starts before the console; if it takes the
  // console's port the console cannot bind and the operator loses the page
  // they would fix it from. Refused at write time, because a renderer runs
  // after the apply has already been accepted.
  it("refuses a MAVLink TCP port the device already serves on (R-MAV-14)", () => {
    const clash = { ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: DEFAULT_CONFIG.ui.port } } };
    expect(() => ConfigSchema.parse(clash)).toThrow(/ui\.port|already/i);
  });

  it("allows the same port once the console has moved off it", () => {
    const moved = { ...DEFAULT_CONFIG,
      ui: { ...DEFAULT_CONFIG.ui, port: 3001 },
      mavlink: { ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: 3000 } } };
    expect(() => ConfigSchema.parse(moved)).not.toThrow();
  });

  it("is strict — a misspelled key is refused, not ignored (R-CFG-09)", () => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, autocasst: true },
    })).toThrow();
  });
});
