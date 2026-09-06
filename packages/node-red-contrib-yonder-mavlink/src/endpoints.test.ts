// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { endpointsMessage } from "./endpoints.js";

/**
 * `mavlink.autocast`/`mavlink.ingest.loopback_only`/`mavlink.endpoints` are
 * configuration, never `/mav/state` — see `state.ts`'s own docstring for why
 * the two are kept apart. This node reads them the way `yonder-modem-form`
 * reads `network.modem`: input-driven, off the configuration the flows
 * already read once with `yonder-config`, never with a socket client of its
 * own (a second reader of the same document would show an operator their own
 * half-typed host/port boxes being overwritten).
 */

const config = (mavlink: Record<string, unknown>): unknown => ({ version: 1, mavlink });

const configured = config({
  autocast: true,
  ingest: { loopback_only: true },
  tcp_server: { enabled: true, port: 5760 },
  endpoints: [
    { name: "gcs0", host: "192.168.191.40", port: 14550 },
    { name: "gcs1", host: "10.147.20.8", port: 14551 },
  ],
});

describe("endpointsMessage — R-UI-17: opens showing what is actually configured", () => {
  it("seeds each configured host and port pair", () => {
    const msgs = endpointsMessage(configured);
    expect(msgs[1]?.payload).toBe("192.168.191.40");
    expect(msgs[2]?.payload).toBe("14550");
    expect(msgs[3]?.payload).toBe("10.147.20.8");
    expect(msgs[4]?.payload).toBe("14551");
  });

  it("is an empty box for a row nothing has configured, never a fabricated value", () => {
    const msgs = endpointsMessage(configured);
    // Only two endpoints are configured; the third row has nothing to seed.
    expect(msgs[5]?.payload).toBe("");
    expect(msgs[6]?.payload).toBe("");
  });

  it("says telemetry starts on its own, in words", () => {
    const msgs = endpointsMessage(configured);
    expect((msgs[0]?.payload as { atboot: unknown })?.atboot).toBe("Automatic");
  });

  it("says telemetry does not start on its own when autocast is off", () => {
    const msgs = endpointsMessage(config({
      autocast: false, ingest: { loopback_only: true }, tcp_server: { enabled: true, port: 5760 }, endpoints: [],
    }));
    expect((msgs[0]?.payload as { atboot: unknown })?.atboot).toBe("Manual");
  });

  it("names where MAVLink is accepted from", () => {
    expect((endpointsMessage(configured)[0]?.payload as { ingest: unknown })?.ingest).toBe("Loopback only");
    const opened = endpointsMessage(config({
      autocast: true, ingest: { loopback_only: false }, tcp_server: { enabled: true, port: 5760 }, endpoints: [],
    }));
    expect((opened[0]?.payload as { ingest: unknown })?.ingest).toBe("Any network");
  });

  it("carries the TCP server's own address, already in words", () => {
    expect((endpointsMessage(configured)[0]?.payload as { tcpAddress: unknown })?.tcpAddress).toBe(":5760");
  });
});

describe("endpointsMessage — a read that found nothing to seed", () => {
  it("is null on every output rather than blanking a form the operator is editing", () => {
    expect(endpointsMessage(null)).toEqual([null, null, null, null, null, null, null]);
  });

  it("is null on every output for a document with no mavlink section", () => {
    expect(endpointsMessage({ version: 1 })).toEqual([null, null, null, null, null, null, null]);
  });
});
