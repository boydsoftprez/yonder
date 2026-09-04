// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { affectsReachability, CAMERA_EXEMPT_LEAVES, CAMERA_LEAVES } from "./reachability.js";
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

const CAMERA = {
  id: "cam0", name: "Nose", source: "usb" as const, device: "usb-0000:01:00.0-1.3",
};
function withCamera(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [{ ...CAMERA, ...overrides }],
  });
}

describe("camera leaves", () => {
  it("exempts resolution, rate, codec, preview and image controls", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ width: 1920, height: 1080 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ framerate: 15 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ codec: "h264" }))).toBe(false);
    expect(affectsReachability(before, withCamera({ preview: { width: 320, bitrate_kbps: 200 } }))).toBe(false);
    expect(affectsReachability(before, withCamera({ controls: { brightness: 20 } }))).toBe(false);
  });

  it("keeps bitrate and outputs load-bearing — they are egress on the console's own path", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ bitrate_kbps: 8000 }))).toBe(true);
    expect(affectsReachability(before, withCamera({
      outputs: [{ kind: "rtp", host: "192.168.1.50", port: 5600 }],
    }))).toBe(true);
  });

  it("keeps adding and removing a camera load-bearing", () => {
    const none = ConfigSchema.parse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    });
    expect(affectsReachability(none, withCamera())).toBe(true);
  });

  it("keeps identity, device, enabled and autostart load-bearing", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ name: "Tail" }))).toBe(true);
    expect(affectsReachability(before, withCamera({ device: "usb-0000:01:00.0-1.4" }))).toBe(true);
    expect(affectsReachability(before, withCamera({ enabled: false }))).toBe(true);
    expect(affectsReachability(before, withCamera({ autostart: true }))).toBe(true);
  });

  // The K-32 prevention, and the whole reason this file lists leaves rather
  // than subtrees. A field added to Camera next year is load-bearing by
  // default — which is right — but nobody would have *decided* that. This
  // fails the moment the shape changes, and the fix is to add the new key to
  // one of the two lists on purpose.
  it("forces a decision when the camera schema grows a field", () => {
    expect([...CAMERA_LEAVES].sort()).toEqual([
      "autostart", "bitrate_kbps", "codec", "controls", "device", "enabled",
      "framerate", "height", "id", "name", "outputs", "preview", "source", "width",
    ]);
    expect(Object.keys(withCamera().cameras[0]).sort()).toEqual([...CAMERA_LEAVES].sort());
    expect([...CAMERA_EXEMPT_LEAVES].sort()).toEqual([
      "codec", "controls", "framerate", "height", "preview", "width",
    ]);
  });

  // The preview's exemption is earned by its bound, not by argument. If the
  // ceiling moves, this fails and `preview` has to leave the exempt list.
  it("holds the preview to the bound its exemption rests on", () => {
    const tooFast = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{ ...CAMERA, preview: { bitrate_kbps: 2001 } }],
    });
    expect(tooFast.success).toBe(false);
  });

  it("refuses a subtree exemption for cameras", () => {
    // `delete copy.cameras` would hand the exemption to every field added
    // later, with nobody deciding it should have one. The proof it was not
    // done that way: a load-bearing leaf still registers.
    expect(affectsReachability(withCamera(), withCamera({ bitrate_kbps: 3000 }))).toBe(true);
  });
});
