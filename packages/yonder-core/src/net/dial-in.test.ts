// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { answerableAddresses } from "./dial-in.js";

/**
 * The two device maps the daemon passes, in the two shapes it passes them:
 * `devices` names the modem as the net port its bytes leave by, `alsoKnownAs`
 * as the control port NetworkManager binds the address to. `pathsHolding` and
 * `pathsDown` take the identical pair.
 */
const AUTO = {
  devices: { ethernet: "eth0", modem: "wwan0" },
  alsoKnownAs: { ethernet: "eth0", modem: "cdc-wdm0" },
  apAddress: "192.168.77.1/24",
};

describe("answerableAddresses", () => {
  it("answers every address the device holds, radio first and mesh after", () => {
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "eth0", address: "192.168.1.8/24" }],
      mesh: ["10.147.17.42/24"],
    })).toEqual([
      { address: "192.168.1.8", path: "lan" },
      { address: "10.147.17.42", path: "mesh" },
    ]);
  });

  /**
   * **The finding this file exists for, and the one a flag could not express.**
   *
   * NetworkManager binds the modem's address to the *control* port and
   * ModemManager names the *net* port. Comparing an address's device against
   * one of those alone is trivially true, so the CGNAT address came back
   * dialable on every board in auto mode — which is the flying case.
   */
  it("knows the modem's address by the control port NetworkManager binds", () => {
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "cdc-wdm0", address: "10.31.95.33/30" }],
      mesh: [],
    })).toEqual([{ address: "10.31.95.33", path: "cellular" }]);
  });

  it("and by the net port ModemManager names, so neither name is the only one", () => {
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "wwan0", address: "10.31.95.33/30" }],
      mesh: [],
    })).toEqual([{ address: "10.31.95.33", path: "cellular" }]);
  });

  /**
   * An appliance modem is named as the adapter it is, so both maps carry the
   * same name and there is nothing to reconcile — but the answer must be the
   * same, or the reconciliation would be doing the work rather than the
   * comparison.
   */
  it("names an appliance modem's address cellular too, where there is one name", () => {
    expect(answerableAddresses({
      devices: { ethernet: "eth0", modem: "usb0" },
      alsoKnownAs: { ethernet: "eth0", modem: "usb0" },
      apAddress: "192.168.77.1/24",
      local: [{ device: "usb0", address: "10.31.95.33/30" }],
      mesh: [],
    })).toEqual([{ address: "10.31.95.33", path: "cellular" }]);
  });

  /**
   * **The access point is its own path, not a LAN.** The default `wifiMode` is
   * `ap`, so `wlan0` permanently holds `192.168.77.1` and `activeIpv4()`
   * reports it — first, ahead of the mesh's. Folding it into `lan` would let
   * a verdict that rests on the mesh print an address no mesh peer can reach,
   * which is what a flat dialable flag did.
   */
  it("keeps the access point's own address apart from a LAN's", () => {
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "wlan0", address: "192.168.77.1/24" }],
      mesh: ["10.147.17.42"],
    })).toEqual([
      { address: "192.168.77.1", path: "access-point" },
      { address: "10.147.17.42", path: "mesh" },
    ]);
  });

  it("calls the radio's address a LAN's when it is a client rather than serving", () => {
    expect(answerableAddresses({
      devices: { ethernet: "eth0", wifi_client: "wlan0" },
      alsoKnownAs: { ethernet: "eth0", wifi_client: "wlan0" },
      apAddress: "192.168.77.1/24",
      local: [{ device: "wlan0", address: "192.168.1.50/24" }],
      mesh: [],
    })).toEqual([{ address: "192.168.1.50", path: "lan" }]);
  });

  it("attributes an address on an interface no path names to nothing at all", () => {
    // A second NIC, a container bridge. Something may be able to dial it;
    // nothing here has established what, so it must never stand in for a path
    // a verdict rests on.
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "docker0", address: "172.17.0.1/16" }],
      mesh: [],
    })).toEqual([{ address: "172.17.0.1", path: "unattributed" }]);
  });

  /**
   * `fixtures/device-show-ip4.txt` — a real capture — leads with `lo` holding
   * `127.0.0.1/8`. Without this the *first* address this device claims to
   * answer on is loopback, which is both the fallback the stream address
   * prints and the first thing `alternatives` lists.
   */
  it("drops loopback, which is neither arrived on nor dialable", () => {
    expect(answerableAddresses({
      ...AUTO,
      local: [
        { device: "lo", address: "127.0.0.1/8" },
        { device: "eth0", address: "192.168.1.8/24" },
      ],
      mesh: [],
    })).toEqual([{ address: "192.168.1.8", path: "lan" }]);
  });

  it("answers one address once, however many readings report it", () => {
    // The mesh's own interface is reported by nmcli as well, holding the same
    // address the mesh reports. Two entries for one address would be one
    // address with two different answers.
    expect(answerableAddresses({
      ...AUTO,
      local: [{ device: "ztabcdef01", address: "10.147.17.42/24" }],
      mesh: ["10.147.17.42/24"],
    })).toEqual([{ address: "10.147.17.42", path: "mesh" }]);
  });

  it("drops an empty address rather than answering one nobody can use", () => {
    expect(answerableAddresses({
      ...AUTO, local: [{ device: "eth0", address: "" }], mesh: [""],
    })).toEqual([]);
  });

  it("takes an address with no prefix length as it stands", () => {
    expect(answerableAddresses({
      ...AUTO, local: [{ device: "eth0", address: "192.168.1.8" }], mesh: [],
    })[0]?.address).toBe("192.168.1.8");
  });

  it("works with no second name given, because one is not always needed", () => {
    expect(answerableAddresses({
      devices: { ethernet: "eth0" }, apAddress: "192.168.77.1/24",
      local: [{ device: "eth0", address: "192.168.1.8/24" }], mesh: [],
    })).toEqual([{ address: "192.168.1.8", path: "lan" }]);
  });
});
