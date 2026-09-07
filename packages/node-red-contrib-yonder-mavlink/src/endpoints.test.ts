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

  /**
   * **The rail has to agree with the line above it** (R-MAV-07, R-MAV-09).
   *
   * `ui-yonder-softkeys` lights whichever key its configuration marks
   * `active` unless a message carries a list, and that configuration lights
   * `THIS DEVICE` always. So a device accepting MAVLink from the network read
   * *Any network* above a rail claiming the opposite — the one confusion
   * R-MAV-09 names by hand. Both keys come off the same predicate as the
   * words, so they cannot come apart.
   */
  type Key = { label: string; action: string; tone: string; active: boolean };
  const keysOf = (config: unknown): Key[] =>
    (endpointsMessage(config)[0]?.payload as { keys: Key[] }).keys;

  it("lights the ingest key that is actually in force", () => {
    expect(keysOf(configured)).toEqual([
      { label: "THIS DEVICE", action: "loopback", tone: "act", active: true },
      { label: "ANY NETWORK", action: "open", tone: "caution", active: false },
    ]);
    expect(keysOf(config({
      autocast: true, ingest: { loopback_only: false }, tcp_server: { enabled: true, port: 5760 }, endpoints: [],
    }))).toEqual([
      { label: "THIS DEVICE", action: "loopback", tone: "act", active: false },
      { label: "ANY NETWORK", action: "open", tone: "caution", active: true },
    ]);
  });

  /**
   * The lit key and the word are one reading, so they are asserted together:
   * a change that moved one and not the other would leave the page saying two
   * things about the same setting, which is the defect this closed.
   */
  it("never lights a key the words disagree with", () => {
    for (const loopbackOnly of [true, false]) {
      const seeded = endpointsMessage(config({
        autocast: true,
        ingest: { loopback_only: loopbackOnly },
        tcp_server: { enabled: true, port: 5760 },
        endpoints: [],
      }))[0]?.payload as { ingest: string; keys: Key[] };
      const lit = seeded.keys.find((key) => key.active);
      expect(lit?.label).toBe(seeded.ingest === "Any network" ? "ANY NETWORK" : "THIS DEVICE");
    }
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
