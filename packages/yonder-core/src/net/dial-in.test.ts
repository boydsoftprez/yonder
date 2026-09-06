// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { answerableAddresses } from "./dial-in.js";

describe("answerableAddresses", () => {
  it("answers every address the device holds, radio first and mesh after", () => {
    expect(answerableAddresses({
      local: [{ device: "eth0", address: "192.168.1.8/24" }],
      mesh: ["10.147.17.42/24"],
      modemDevice: null,
    }).map((a) => a.address)).toEqual(["192.168.1.8", "10.147.17.42"]);
  });

  /**
   * The one that matters. Nothing dials in to a device behind the carrier's
   * NAT — `video/outputs.ts` states the rule and this applies it to the
   * address, so an RTSP URL is never built from one.
   */
  it("marks the modem's own address as one nothing can dial in to", () => {
    const out = answerableAddresses({
      local: [
        { device: "wwan0", address: "100.72.14.9/30" },
        { device: "eth0", address: "192.168.1.8/24" },
      ],
      mesh: [],
      modemDevice: "wwan0",
    });
    expect(out).toEqual([
      { address: "100.72.14.9", dialIn: false },
      { address: "192.168.1.8", dialIn: true },
    ]);
  });

  it("marks every mesh address dialable, because that is what a mesh is for", () => {
    const out = answerableAddresses({
      local: [{ device: "wwan0", address: "100.72.14.9/30" }],
      mesh: ["10.147.17.42/24"],
      modemDevice: "wwan0",
    });
    expect(out.filter((a) => a.dialIn).map((a) => a.address)).toEqual(["10.147.17.42"]);
  });

  /**
   * The access point is not a `PathName` and never appears in the reach
   * monitor's paths, so a rule written as "only ethernet and wifi_client are
   * dialable" would exclude the one address every device answers on before it
   * has joined anything — which is where an operator meets a board for the
   * first time.
   */
  it("keeps the access point's own address dialable", () => {
    const out = answerableAddresses({
      local: [{ device: "wlan0", address: "192.168.77.1/24" }],
      mesh: [],
      modemDevice: "wwan0",
    });
    expect(out).toEqual([{ address: "192.168.77.1", dialIn: true }]);
  });

  it("excludes nothing when no interface has been named for the modem", () => {
    // `null` is *nothing has been read yet*, not *everything is a modem*. A
    // board printing no address at all for the first seconds after a start
    // would be the worse failure, and a modem with no interface name holds no
    // IPv4 address for nmcli to report anyway.
    const out = answerableAddresses({
      local: [{ device: "eth0", address: "192.168.1.8" }],
      mesh: [],
      modemDevice: null,
    });
    expect(out).toEqual([{ address: "192.168.1.8", dialIn: true }]);
  });

  it("drops an empty address rather than answering one nobody can use", () => {
    expect(answerableAddresses({
      local: [{ device: "eth0", address: "" }],
      mesh: [""],
      modemDevice: null,
    })).toEqual([]);
  });

  it("takes an address with no prefix length as it stands", () => {
    expect(answerableAddresses({
      local: [{ device: "eth0", address: "192.168.1.8" }],
      mesh: [],
      modemDevice: null,
    })[0]?.address).toBe("192.168.1.8");
  });
});
