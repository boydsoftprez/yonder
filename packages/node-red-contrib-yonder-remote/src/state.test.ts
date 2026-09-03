// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageFor } from "./state.js";

/** Fixed, so a relative-time assertion never races the wall clock. */
const NOW = 1_700_000_000_000;

describe("messageFor", () => {
  // The node hands the page one object. Everything the page shows is a field
  // here, so no widget has to know what ACCESS_DENIED means.
  it("carries the address to approve while waiting", () => {
    const msg = messageFor({
      phase: "waiting-for-approval",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: [],
      interface: "ztuqliuo7y",
      detail: null,
      networkName: null,
      online: true,
      relayed: null,
      latencyMs: null,
      lastHeardMs: null,
      peerCount: 0,
      rxBytes: null,
      txBytes: null,
    });
    expect(msg.payload.label).toBe("Waiting for you to approve it");
    expect(msg.payload.deviceId).toBe("9fef8a3bf9");
    expect(msg.payload.waiting).toBe(true);
  });

  it("shows the assigned address once connected", () => {
    const msg = messageFor({
      phase: "connected",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: ["10.147.20.26/24"],
      interface: "ztuqliuo7y",
      detail: null,
      networkName: null,
      online: true,
      relayed: null,
      latencyMs: null,
      lastHeardMs: null,
      peerCount: 0,
      rxBytes: null,
      txBytes: null,
    });
    expect(msg.payload.label).toBe("Connected");
    expect(msg.payload.address).toBe("10.147.20.26/24");
  });

  it("says nothing is configured rather than reporting a problem", () => {
    const msg = messageFor({
      phase: "off",
      networkId: null,
      deviceId: null,
      addresses: [],
      interface: null,
      detail: null,
      networkName: null,
      online: false,
      relayed: null,
      latencyMs: null,
      lastHeardMs: null,
      peerCount: 0,
      rxBytes: null,
      txBytes: null,
    });
    expect(msg.payload.label).toBe("Not configured");
    expect(msg.payload.waiting).toBe(false);
  });

  it("names the client's own word when there is a fault", () => {
    const msg = messageFor({
      phase: "fault",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: [],
      interface: null,
      detail: "PORT_ERROR",
      networkName: null,
      online: true,
      relayed: null,
      latencyMs: null,
      lastHeardMs: null,
      peerCount: 0,
      rxBytes: null,
      txBytes: null,
    });
    expect(msg.payload.label).toBe("PORT_ERROR");
  });
});

// The phase R-VPN-10 introduced. Before this was handled it fell through to the
// fault branch, and `detail` is null here, so a device that was merely between
// uplinks announced itself as "Fault" — a worse lie than the "Connected" that
// R-VPN-10 set out to fix, because it sends somebody looking for a broken
// configuration that is not broken.
describe("a valid membership with no path", () => {
  it("is named, and is not a fault", () => {
    const msg = messageFor({
      phase: "no-path",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: ["10.147.20.26/24"],
      interface: "ztuqliuo7y",
      detail: null,
      networkName: "somewhere",
      online: false,
      relayed: null,
      latencyMs: null,
      lastHeardMs: null,
      peerCount: 0,
      rxBytes: 0,
      txBytes: 0,
    });
    expect(msg.payload.label).toBe("Authorised, not reaching the network");
    expect(msg.payload.label).not.toMatch(/fault/i);
    expect(msg.payload.waiting).toBe(false);
  });

  // The mock's own example for this phase: "last heard from 4 min ago",
  // shown even though the membership has no path right now.
  it("shows how long ago it was last heard from, even with no path", () => {
    const msg = messageFor(
      {
        phase: "no-path",
        networkId: "9fef8a3bf9000001",
        deviceId: "9fef8a3bf9",
        addresses: ["10.147.20.26/24"],
        interface: "ztuqliuo7y",
        detail: null,
        networkName: "somewhere",
        online: false,
        relayed: null,
        latencyMs: null,
        lastHeardMs: NOW - 4 * 60_000,
        peerCount: 0,
        rxBytes: null,
        txBytes: null,
      },
      NOW,
    );
    expect(msg.payload.lastHeard).toBe("4 min ago");
  });
});

/**
 * What backs the word "connected" (R-VPN-10): direct-or-relayed, latency,
 * traffic and when the device was last heard from - each its own field, so
 * no widget has to know a mesh client's vocabulary or do arithmetic on a
 * byte counter. `NOW` is fixed and passed to `messageFor` explicitly so none
 * of this races the wall clock.
 */
describe("the fields behind the connection state (R-VPN-10)", () => {
  const connected: Parameters<typeof messageFor>[0] = {
    phase: "connected",
    networkId: "0cccb752f71441b7",
    deviceId: "9c0589e413",
    addresses: ["192.168.109.53/24"],
    interface: "ztabcdefgh",
    detail: null,
    networkName: "boydsoftprez's 1st network",
    online: true,
    relayed: false,
    latencyMs: 66,
    lastHeardMs: NOW - 42_000,
    peerCount: 1,
    rxBytes: 1_572_864, // 1.5 MiB
    txBytes: 414_720, // 405 KiB
  };

  it("names a direct path in words, not a boolean", () => {
    expect(messageFor(connected, NOW).payload.path).toBe("Direct");
  });

  it("names a relayed path", () => {
    expect(messageFor({ ...connected, relayed: true }, NOW).payload.path).toBe("Relayed");
  });

  it("leaves the path unknown, not guessed, when relayed is unknown", () => {
    expect(messageFor({ ...connected, relayed: null }, NOW).payload.path).toBeNull();
  });

  it("renders latency with its unit", () => {
    expect(messageFor(connected, NOW).payload.latency).toBe("66 ms");
  });

  // The distinction this whole feature protects: an unmeasured latency is
  // not the same fact as a measured zero. Printing "0 ms" for "we have no
  // idea" is the lie R-VPN-10 exists to stop.
  it("never renders an unknown latency as 0 ms", () => {
    const msg = messageFor({ ...connected, relayed: null, latencyMs: null }, NOW);
    expect(msg.payload.latency).toBeNull();
    expect(msg.payload.latency).not.toBe("0 ms");
  });

  it("renders traffic as both counters, formatted and joined", () => {
    expect(messageFor(connected, NOW).payload.traffic).toBe("1.5 MB in · 405 KB out");
  });

  it("has no traffic reading when either counter is unmeasured", () => {
    expect(messageFor({ ...connected, rxBytes: null }, NOW).payload.traffic).toBeNull();
    expect(messageFor({ ...connected, txBytes: null }, NOW).payload.traffic).toBeNull();
  });

  it("carries the network name through unchanged", () => {
    expect(messageFor(connected, NOW).payload.networkName).toBe("boydsoftprez's 1st network");
  });

  it("renders when the device was last heard from, relative to now", () => {
    expect(messageFor(connected, NOW).payload.lastHeard).toBe("42 s ago");
  });

  it("has no last-heard reading when nothing has ever been heard", () => {
    expect(messageFor({ ...connected, lastHeardMs: null }, NOW).payload.lastHeard).toBeNull();
  });

  // The Status page's one line: everything that backs "connected", in the
  // order an operator would ask for it.
  it("summarises the connection for the Status page", () => {
    expect(messageFor(connected, NOW).payload.summary).toBe("zerotier · direct · 66 ms · 192.168.109.53");
  });

  it("drops the subnet prefix from the address in the summary", () => {
    expect(messageFor(connected, NOW).payload.summary).not.toContain("/24");
  });

  it("omits unknown parts from the summary rather than printing them empty", () => {
    const msg = messageFor({ ...connected, relayed: null, latencyMs: null, addresses: [] }, NOW);
    expect(msg.payload.summary).toBe("zerotier");
  });

  it("is exactly 'not configured' when nothing is configured", () => {
    const msg = messageFor(
      {
        phase: "off",
        networkId: null,
        deviceId: null,
        addresses: [],
        interface: null,
        detail: null,
        networkName: null,
        online: false,
        relayed: null,
        latencyMs: null,
        lastHeardMs: null,
        peerCount: 0,
        rxBytes: null,
        txBytes: null,
      },
      NOW,
    );
    expect(msg.payload.summary).toBe("not configured");
  });
});

// The upgrade window, reproduced. A console newer than the daemon receives a
// state without the fields R-VPN-10 added, so they arrive `undefined` rather
// than `null`. The `=== null` guards waved them through into formatBytes and
// `.toFixed` threw — Node-RED does not contain that, so it exited, systemd
// restarted it, and the console crash-looped. Observed on a board, four
// restarts deep, with the daemon still on the previous build.
//
// The interface may render "unknown". It may not disappear.
describe("a state from a daemon older than this console", () => {
  const old = {
    phase: "connected",
    networkId: "0cccb752f71441b7",
    deviceId: "9c0589e413",
    addresses: ["192.168.109.53/24"],
    interface: "ztly52ge2a",
    detail: null,
  } as unknown as Parameters<typeof messageFor>[0];

  it("does not throw", () => {
    expect(() => messageFor(old)).not.toThrow();
  });

  it("renders the fields it does have, and reports the rest as unknown", () => {
    const msg = messageFor(old);
    expect(msg.payload.label).toBe("Connected");
    expect(msg.payload.address).toBe("192.168.109.53/24");
    expect(msg.payload.traffic).toBeNull();
    expect(msg.payload.latency).toBeNull();
    expect(msg.payload.lastHeard).toBeNull();
  });

  it("still produces a summary line for the status page", () => {
    const { summary, networkName } = messageFor(old).payload;
    expect(typeof summary).toBe("string");
    expect(summary).not.toMatch(/undefined|NaN|null/);
    // Absent, not undefined. The payload's own type says `string | null`, and a
    // field that arrives from an older daemon must be normalised on the way in
    // rather than handed to a widget as undefined.
    expect(networkName).toBeNull();
  });
});
