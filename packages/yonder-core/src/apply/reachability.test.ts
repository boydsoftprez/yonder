// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { affectsReachability, CAMERA_EXEMPT_LEAVES, CAMERA_LEAVES } from "./reachability.js";
import { ConfigSchema, DEFAULT_CONFIG, type Camera, type Config } from "../schema/config.js";

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
  it("exempts resolution, rate, codec and image controls", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ width: 1920, height: 1080 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ framerate: 15 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ codec: "h264" }))).toBe(false);
    expect(affectsReachability(before, withCamera({ controls: { brightness: 20 } }))).toBe(false);
  });

  /**
   * **The load-bearing change this task makes.** A preview whose ceiling now
   * reaches 4000 kb/s is egress on the same path the console is reached
   * over, so it can no longer be kept without a countdown — R-NET-07 is the
   * requirement, and the old exemption assumed at most 2000 kb/s.
   */
  it("preview is no longer exempt from the reachability comparison", () => {
    expect(CAMERA_EXEMPT_LEAVES).not.toContain("preview");
    const withPreview = (preview: Record<string, unknown>) => withCamera({ preview });
    expect(affectsReachability(
      withPreview({ ceiling_kbps: 2000 }),
      withPreview({ ceiling_kbps: 4000 }),
    )).toBe(true);
  });

  it("controls stays exempt — a brightness change cannot cost you the aircraft", () => {
    expect(CAMERA_EXEMPT_LEAVES).toContain("controls");
  });

  it("keeps bitrate, outputs and stream load-bearing — they are egress on the console's own path", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ bitrate_kbps: 8000 }))).toBe(true);
    expect(affectsReachability(before, withCamera({
      outputs: [{ kind: "rtp", host: "192.168.1.50", port: 5600 }],
    }))).toBe(true);
    expect(affectsReachability(before, withCamera({ stream: { mode: "adaptive" } }))).toBe(true);
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
      "accessory_mount", "autostart", "bitrate_kbps", "codec", "controls", "device", "enabled",
      "framerate", "gimbal_presets", "height", "id", "image", "name", "outputs", "preview", "source", "stream", "width",
    ]);
    // Mount geometry is optional, absent for existing USB configurations, and
    // load-bearing: changing a physical safety certificate must never be exempted.
    expect(Object.keys(withCamera().cameras[0]).sort()).toEqual([...CAMERA_LEAVES].filter(key => !['accessory_mount','gimbal_presets'].includes(key)).sort());
    expect([...CAMERA_EXEMPT_LEAVES].sort()).toEqual([
      "codec", "controls", "framerate", "gimbal_presets", "height", "image", "width",
    ]);
  });

  it("refuses a subtree exemption for cameras", () => {
    // `delete copy.cameras` would hand the exemption to every field added
    // later, with nobody deciding it should have one. The proof it was not
    // done that way: a load-bearing leaf still registers.
    expect(affectsReachability(withCamera(), withCamera({ bitrate_kbps: 3000 }))).toBe(true);
  });
});

/**
 * Coordinator resolution 4: this is the test that has to survive the plan.
 * Its job is that a field added to `Camera` later cannot quietly inherit an
 * exemption nobody chose for it — so the enumeration side comes from the
 * schema, not from a copy of `CAMERA_LEAVES` that could itself go stale.
 */
describe("camera leaf enumeration", () => {
  const realLeaves = Object.keys(withCamera({gimbal_presets:{revision:0,slots:[]}}).cameras[0]).sort();

  /**
   * The leaves this file affirmatively calls load-bearing — not "whatever
   * `CAMERA_EXEMPT_LEAVES` does not mention", which would make the check
   * below tautological and unable to fail. Naming them means a leaf sitting
   * in neither this array nor `CAMERA_EXEMPT_LEAVES` fails the test below,
   * by name.
   */
  const LOAD_BEARING = [
    "id", "name", "source", "device", "enabled", "autostart",
    "bitrate_kbps", "outputs", "stream", "preview",
  ];

  it("classifies every camera leaf, and names any it has not decided about", () => {
    const unclassified = realLeaves.filter(
      (leaf) => !(CAMERA_EXEMPT_LEAVES as readonly string[]).includes(leaf) && !LOAD_BEARING.includes(leaf),
    );
    expect(unclassified).toEqual([]);

    // And neither side names a leaf the schema does not actually have —
    // `CAMERA_EXEMPT_LEAVES` and `LOAD_BEARING` are each accountable to
    // `realLeaves`, not only to each other.
    for (const leaf of [...CAMERA_EXEMPT_LEAVES, ...LOAD_BEARING]) {
      expect(realLeaves, `"${leaf}" is classified but is not a real camera leaf`).toContain(leaf);
    }
  });

  /**
   * The behavioural half. Not merely omitted from the two lists above —
   * genuinely absent from both, simulating a field `Camera` grows tomorrow
   * before anyone has touched this file for it. `withoutCosmetics` only
   * ever deletes what `CAMERA_EXEMPT_LEAVES` names, so a leaf nobody has
   * classified still arms the confirmation window, which is the actual
   * safety property the enumeration test above exists to protect.
   */
  it("an unknown sibling — one this file has never classified at all — is load-bearing", () => {
    const before = withCamera();
    const after = withCamera() as Config & { cameras: (Camera & { somethingNew?: unknown })[] };
    after.cameras[0].somethingNew = { invented: "later" };
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
