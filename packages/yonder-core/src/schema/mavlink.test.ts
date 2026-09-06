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

  /**
   * R-MAV-15's reserved list is a claim on a section heading, and it is the
   * same claim in every spelling. `z.string().min(1)` accepted `Yonder`
   * alongside the reserved `yonder`: either mavlink-router folds case, in
   * which case one section silently replaces the other and R-MAV-15's whole
   * harm is back, or it does not, in which case the operator has an endpoint
   * named after Yonder's own. Neither is worth accepting.
   */
  it("refuses a reserved name spelled with capitals, and a duplicate that differs only in them (R-MAV-15)", () => {
    for (const reserved of RESERVED_ENDPOINT_NAMES) {
      const shouted = reserved.charAt(0).toUpperCase() + reserved.slice(1);
      expect(() => ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [{ name: shouted, host: "192.168.2.10", port: 14550 }] },
      }), shouted).toThrow(new RegExp(`${shouted}.*reserved`));
    }
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [
        { name: "gcs0", host: "192.168.2.10", port: 14550 },
        { name: "GCS0", host: "10.147.20.8", port: 14551 },
      ] },
    })).toThrow(/GCS0.*already/);
  });

  /**
   * **R-MAV-18: a name and a host are values, never structure.**
   *
   * `router/config.ts` interpolates both verbatim — `[UdpEndpoint <name>]`
   * and `Address = <host>` — so a newline in either is a new line of INI. A
   * name carrying one adds an entire extra `[UdpEndpoint …]`: an
   * unconfigured second copy of the aircraft's telemetry that `config.yaml`
   * never described, that the console never draws, and that R-MAV-15's
   * duplicate check cannot see, because the name it compares is the whole
   * blob. A host carrying one opens a `[General]` and strands the
   * legitimate endpoint's own `Port` line inside it.
   *
   * Both assertions run the generated file, not only the parse: refusing the
   * document is the fix, and the file is the harm it prevents.
   */
  it.each([
    ["a newline in the name adds a section", "gcs0\n[UdpEndpoint evil]\nMode = Normal\nAddress = 10.0.0.9", "192.168.2.10"],
    ["a carriage return in the name", "gcs0\r[UdpEndpoint evil]", "192.168.2.10"],
    ["a bracket in the name closes the heading early", "gcs0] extra", "192.168.2.10"],
    ["a space in the name splits the heading", "gcs 0", "192.168.2.10"],
    ["a newline in the host opens a section", "gcs0", "10.0.0.9\n[General]\nTcpServerPort = 5760"],
    ["a space in the host", "gcs0", "10.0.0.9 evil"],
    ["an empty name", "", "192.168.2.10"],
    ["an empty host", "gcs0", ""],
  ])("refuses %s (R-MAV-18)", (_what, name, host) => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [{ name, host, port: 14550 }] },
    })).toThrow();
  });

  /**
   * The other half: what is refused must not be everything. A hostname, a
   * dotted quad, an IPv6 literal and a scoped link-local address are all
   * things `mavlink-router` will dial, and a name may carry the separators
   * an operator actually reaches for.
   */
  it.each([
    ["a dotted quad", "gcs0", "192.168.2.10"],
    ["a DNS name", "gcs-0", "gcs.example.com"],
    ["a single-label host", "gcs_0", "laptop"],
    ["an IPv6 literal", "gcs.0", "fd00::1"],
    ["a scoped link-local address", "GCS0", "fe80::1%eth0"],
  ])("accepts %s (R-MAV-18)", (_what, name, host) => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [{ name, host, port: 14550 }] },
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
