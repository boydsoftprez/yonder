// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { affectsReachability } from "./reachability.js";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../schema/config.js";

const base = (): Config => structuredClone(DEFAULT_CONFIG);

/**
 * The predicate the confirmation window turns on.
 *
 * Getting this wrong in one direction is a palette that reverts itself. In the
 * other it is a device nobody can reach. Only one of those is recoverable from
 * a chair, so the bias is stated in the tests as well as in the code.
 */
describe("affectsReachability", () => {
  it("is false for a change that is only the interface's appearance", () => {
    const before = base();
    const after = base();
    after.ui.theme = "night";
    expect(affectsReachability(before, after)).toBe(false);
  });

  it("is false for no change at all", () => {
    expect(affectsReachability(base(), base())).toBe(false);
  });

  it("is true for anything that moves the radio", () => {
    const after = base();
    after.network.client.ssid = "hangar-2g";
    expect(affectsReachability(base(), after)).toBe(true);
  });

  it("is true for the access point", () => {
    const after = base();
    after.network.ap.enabled = false;
    expect(affectsReachability(base(), after)).toBe(true);
  });

  it("is true for the port the console is served on", () => {
    // Changing it does not take the device off the air, but it does take the
    // operator's open page off it, which is the same thing from a chair.
    const after = base();
    after.ui.port = 8080;
    expect(affectsReachability(base(), after)).toBe(true);
  });

  it("is true for the name the device answers to", () => {
    const after = base();
    after.system.hostname = "elsewhere";
    expect(affectsReachability(base(), after)).toBe(true);
  });

  /**
   * The bias, asserted. Everything is reachable until proven otherwise, so a
   * field nobody has thought about yet is load-bearing by default rather than
   * silently exempt.
   */
  it("is true for a field it has never heard of", () => {
    const after = base() as Config & { somethingNew?: unknown };
    after.somethingNew = { invented: "later" };
    expect(affectsReachability(base(), after as Config)).toBe(true);
  });

  it("still sees a network change made alongside a theme change", () => {
    const after = base();
    after.ui.theme = "night";
    after.network.client.ssid = "hangar-2g";
    expect(affectsReachability(base(), after)).toBe(true);
  });

  // A mesh join only ever adds a path. Measured on a board: joining installed one
  // route for the mesh's own subnet, the default route and the LAN route were
  // untouched, and a controller pushing 10.0.252.0/25 - overlapping the network
  // the board was reached on - was refused by the client itself. So there is
  // nothing for a confirmation window to guarantee (R-CFG-12, R-VPN-07).
  it("does not hold a zerotier join", () => {
    const before = ConfigSchema.parse({
      version: 1,
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
    });
    const after = { ...before, remote: { zerotier: { enabled: true, network_id: "9fef8a3bf9000001" } } };
    expect(affectsReachability(before, after)).toBe(false);
  });

  // Each mesh earns this separately. Everything is load-bearing until measured,
  // and `tailscale up` installs packet-filter rules nobody has measured yet.
  it("holds a change to any other part of remote", () => {
    const before = ConfigSchema.parse({
      version: 1,
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
    });
    const after = structuredClone(before) as Config & { remote: { tailscale?: unknown } };
    after.remote.tailscale = { enabled: true };
    expect(affectsReachability(before, after)).toBe(true);
  });

  // The exemption is two named fields, not the subtree they sit in. A field
  // added under `remote.zerotier` next year - `allow_default` is the one that
  // would actually hurt, because it is the knob that can replace the default
  // route - must not inherit a kept-not-held apply from its neighbours with
  // nobody deciding it should.
  it("holds a field added under remote.zerotier that nobody has measured", () => {
    const before = ConfigSchema.parse({
      version: 1,
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
    });
    const after = structuredClone(before) as Config & {
      remote: { zerotier: Record<string, unknown> };
    };
    after.remote.zerotier.allow_default = true;
    expect(affectsReachability(before, after)).toBe(true);
  });
});

describe("mavlink (R-CFG-12, R-MAV-03)", () => {
  const withMav = (mavlink: Config["mavlink"]): Config => ({ ...DEFAULT_CONFIG, mavlink });

  it("adding a ground station is kept, not held", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, endpoints: [{ name: "gcs0", host: "10.147.20.8", port: 14550 }] });
    expect(affectsReachability(before, after)).toBe(false);
  });

  it("turning the tcp server off is kept", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: false, port: 5760 } });
    expect(affectsReachability(before, after)).toBe(false);
  });

  it("autocast is kept", () => {
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), withMav({ ...DEFAULT_CONFIG.mavlink, autocast: false }))).toBe(false);
  });

  // The port is not like `enabled`: the schema accepts any value in range, and
  // a value the schema accepts can still be a port some other service on the
  // device already holds. R-MAV-14 only refuses the one collision it can see
  // - with `ui.port`, the console's own - so a bind failure against sshd,
  // mediamtx or the mesh client is invisible to the schema and would
  // otherwise ship kept. Still held, on purpose.
  it("moving the tcp server's port is still held", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: 5761 } });
    expect(affectsReachability(before, after)).toBe(true);
  });

  // The exemption is earned per leaf. These two are not exempt and must not
  // become so by sitting next to ones that are.
  it("pinning the serial port is still held", () => {
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 57600 } });
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), after)).toBe(true);
  });

  it("opening ingest to the network is still held (R-MAV-07)", () => {
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, ingest: { loopback_only: false } });
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), after)).toBe(true);
  });

  // The exemption is three named leaves, not the subtree they sit in - the
  // same regression `remote.zerotier` guards against above. A field added
  // directly under `mavlink`, or under `mavlink.tcp_server` specifically,
  // must not inherit a kept-not-held apply from its neighbours with nobody
  // deciding it should.
  it("holds a field added directly under mavlink that nobody has measured", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = structuredClone(before) as Config & { mavlink: Record<string, unknown> };
    after.mavlink.somethingNew = { invented: "later" };
    expect(affectsReachability(before, after)).toBe(true);
  });

  it("holds a field added under mavlink.tcp_server that nobody has measured", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = structuredClone(before) as Config & {
      mavlink: { tcp_server: Record<string, unknown> };
    };
    after.mavlink.tcp_server.somethingNew = true;
    expect(affectsReachability(before, after)).toBe(true);
  });
});
