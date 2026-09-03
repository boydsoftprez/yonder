// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageFor } from "./state.js";

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
});
