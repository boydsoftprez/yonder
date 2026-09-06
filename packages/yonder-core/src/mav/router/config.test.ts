// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { routerConfig } from "./config.js";

const link = { device: "/dev/ttyAMA0", baud: 57600 };
const base = DEFAULT_CONFIG.mavlink;

describe("routerConfig", () => {
  it("names the serial device and the speed detection settled on", () => {
    const out = routerConfig(base, link);
    expect(out).toContain("[UartEndpoint autopilot]");
    expect(out).toContain("Device = /dev/ttyAMA0");
    expect(out).toContain("Baud = 57600");
  });

  it("always emits the control plane's loopback copy, even with no ground station (R-MAV-05)", () => {
    const out = routerConfig({ ...base, endpoints: [] }, link);
    expect(out).toContain("[UdpEndpoint yonder]");
    expect(out).toContain("Address = 127.0.0.1");
    expect(out).toContain("Port = 14559");
  });

  it("emits one block per ground station, named for it (R-MAV-03)", () => {
    const out = routerConfig({ ...base, endpoints: [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
    ] }, link);
    expect(out).toContain("[UdpEndpoint gcs0]");
    expect(out).toContain("Address = 192.168.2.10");
    expect(out).toContain("[UdpEndpoint gcs1]");
    expect(out).toContain("Port = 14551");
  });

  // R-CFG-13, added with M3: what is generated matches the configuration
  // *including what it no longer says*. An operator who clears gcs1 must find
  // that block gone, not standing at its old address still receiving.
  it("drops an endpoint the configuration no longer names (R-CFG-13)", () => {
    const both = routerConfig({ ...base, endpoints: [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
    ] }, link);
    expect(both).toContain("[UdpEndpoint gcs1]");
    const cleared = routerConfig({ ...base, endpoints: [{ name: "gcs0", host: "192.168.2.10", port: 14550 }] }, link);
    expect(cleared).not.toContain("gcs1");
    expect(cleared).not.toContain("10.147.20.8");
  });

  // Omitting the key does not disable the server — the router falls back to
  // its own default port and listens anyway. "Off" has to be said out loud.
  it("says port 0 rather than omitting the key, because omission ships a listener (R-MAV-04)", () => {
    const off = routerConfig({ ...base, tcp_server: { enabled: false, port: 5760 } }, link);
    expect(off).toContain("TcpServerPort = 0");
    expect(off).not.toContain("TcpServerPort = 5760");
  });

  // R-MAV-07. The TCP server accepts *commands*, so leaving it up while ingest
  // is closed would be an unauthenticated command path the console reports as
  // "Loopback only". Asserted rather than reviewed.
  it("keeps the tcp server down while ingest is loopback-only, however it is configured", () => {
    const closed = routerConfig({ ...base, tcp_server: { enabled: true, port: 5760 } }, link);
    expect(closed).toContain("TcpServerPort = 0");
  });

  it("raises it only when ingest has been deliberately opened", () => {
    const open = routerConfig(
      { ...base, ingest: { loopback_only: false }, tcp_server: { enabled: true, port: 5760 } }, link);
    expect(open).toContain("TcpServerPort = 5760");
    expect(open).toContain("Mode = Server");
  });

  // The given tests above only ever check the TCP server's *port number* —
  // none of them assert that closed ingest leaves no listening surface at
  // all. A generator that always emitted the UDP inbound block, gated on
  // nothing, would still pass every test above while leaving an
  // unauthenticated command path open on every device that ever shipped.
  // R-MAV-07 is exactly the requirement that gap would violate, so it is
  // asserted here rather than left to follow from the TCP-only checks.
  it("opens no UDP ingest surface at all while loopback-only, at the schema's own default", () => {
    const closed = routerConfig(base, link);
    expect(closed).not.toContain("Mode = Server");
    expect(closed).not.toContain("0.0.0.0");
    expect(closed).not.toContain("[UdpEndpoint inbound]");
  });

  // The TCP server's own switch and the ingest gate are independent: turning
  // ingest on does not resurrect a TCP server an operator turned off, and
  // turning the TCP server on does not by itself open the UDP path.
  it("switches the TCP server and the UDP ingest path independently of each other", () => {
    const udpOnlyOpen = routerConfig(
      { ...base, ingest: { loopback_only: false }, tcp_server: { enabled: false, port: 5760 } }, link);
    expect(udpOnlyOpen).toContain("TcpServerPort = 0");
    expect(udpOnlyOpen).toContain("[UdpEndpoint inbound]");
  });

  // §6 and router/stats.ts read this line's presence, not its value — it is
  // the only source the console has for which ground station is answering,
  // the throughput sparkline and the TCP client count. Checked on its own,
  // unconditionally, because every other test in this file would still pass
  // if it silently stopped being emitted.
  it("always emits ReportStats = true, the only source the console has for per-endpoint traffic", () => {
    expect(routerConfig(base, link)).toContain("ReportStats = true");
    expect(routerConfig({ ...base, ingest: { loopback_only: false } }, link)).toContain("ReportStats = true");
  });
});
