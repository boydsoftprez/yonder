// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CAMERA_SETTING_KEYS, SETTING_LEAF, setCameraSettings } from "./settings.js";
import { CAMERA_EXEMPT_LEAVES } from "../apply/reachability.js";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../schema/config.js";

const BY_PATH = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0";

function withCamera(): Config {
  return ConfigSchema.parse({
    ...structuredClone(DEFAULT_CONFIG),
    cameras: [{
      id: "front",
      name: "Front camera",
      source: "usb",
      device: BY_PATH,
      outputs: [{ kind: "rtp", host: "192.168.77.20", port: 5600 }],
    }],
  });
}

describe("setCameraSettings", () => {
  it("sets the named field on the named camera and touches nothing else", () => {
    const before = withCamera();
    const result = setCameraSettings(before, "front", { framerate: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cameras[0]?.framerate).toBe(25);
    expect(result.config.cameras[0]?.width).toBe(before.cameras[0]?.width);
    expect(result.config.network).toEqual(before.network);
  });

  /**
   * The rule `ui/theme.ts` records the reason for: a change node stores and
   * reads flow context by reference, so an apply that mutated what it read
   * left a cache holding a value the device did not have after a revert.
   */
  it("never mutates the configuration it was given", () => {
    const before = withCamera();
    const snapshot = JSON.stringify(before);
    setCameraSettings(before, "front", { framerate: 25, bitrate_kbps: 3000 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("reaches into the preview, which is a different leaf from the main bitrate", () => {
    const result = setCameraSettings(withCamera(), "front", { preview_bitrate_kbps: 300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cameras[0]?.preview.bitrate_kbps).toBe(300);
    expect(result.config.cameras[0]?.bitrate_kbps).toBe(2000);
  });

  it("refuses a camera that is not configured", () => {
    const result = setCameraSettings(withCamera(), "nose", { framerate: 25 });
    expect(result).toEqual({ ok: false, error: 'no camera is configured with the id "nose"' });
  });

  it("refuses a request that names nothing", () => {
    expect(setCameraSettings(withCamera(), "front", {}).ok).toBe(false);
    expect(setCameraSettings(withCamera(), "front", undefined).ok).toBe(false);
  });

  /**
   * Named, not "anything in the schema". `device` is a different camera and
   * `outputs` is a different consumer; neither is a setting of this one, and
   * neither is something to change from a slider while an aircraft is flying.
   */
  it("refuses a key that is not a setting, and says which are", () => {
    const result = setCameraSettings(withCamera(), "front", { device: "/dev/video9" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"device" is not a setting');
    expect(result.error).toContain("framerate");
  });

  it("refuses a value of the wrong shape before it becomes a Zod issue nobody can read", () => {
    expect(setCameraSettings(withCamera(), "front", { framerate: "25" }))
      .toEqual({ ok: false, error: "framerate must be a whole number" });
    expect(setCameraSettings(withCamera(), "front", { framerate: 24.5 }))
      .toEqual({ ok: false, error: "framerate must be a whole number" });
    expect(setCameraSettings(withCamera(), "front", { enabled: "yes" }))
      .toEqual({ ok: false, error: "enabled must be true or false" });
  });

  it("takes a boolean, which is the one setting that is not a number", () => {
    const result = setCameraSettings(withCamera(), "front", { autostart: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cameras[0]?.autostart).toBe(true);
  });

  /**
   * **The reason the Setup deck can promise what it promises.**
   *
   * Every settable key is either exempt — kept, no countdown — or it is not,
   * and the confirmation window arms. A key that belonged to neither
   * outcome would be a control whose confirmation behaviour nobody had
   * decided, which is K-32 on the camera page.
   *
   * **Resolved through `SETTING_LEAF`, not by comparing the key itself
   * against `CAMERA_EXEMPT_LEAVES`.** `preview_bitrate_kbps` is a setting
   * key, never a `Camera` leaf — the leaf it actually writes is `preview` —
   * so a bare `exempt.has(key)` can never be true for it regardless of
   * what `CAMERA_EXEMPT_LEAVES` contains, and a test built on that
   * comparison stops proving anything for this one key: it was passing
   * because `preview_bitrate_kbps` could never appear in `kept` at all, not
   * because the code correctly puts it in `held`. Routing through the
   * mapping restores the dependency: put `preview` back in
   * `CAMERA_EXEMPT_LEAVES` and this test goes red, because
   * `preview_bitrate_kbps` resolves to that leaf and would move into `kept`.
   */
  it("settles every settable key on one side or the other of the exempt list", () => {
    const exempt = new Set<string>(CAMERA_EXEMPT_LEAVES);
    const kept = CAMERA_SETTING_KEYS.filter((k) => exempt.has(SETTING_LEAF[k]));
    const held = CAMERA_SETTING_KEYS.filter((k) => !exempt.has(SETTING_LEAF[k]));
    expect([...kept]).toEqual(["width", "height", "framerate"]);
    expect([...held]).toEqual(["bitrate_kbps", "enabled", "autostart", "preview_bitrate_kbps"]);
  });
});

it("rejects reducing capture below the unchanged held preview", () => {
  const before = withCamera();
  before.cameras[0].preview.size = "1280x720";
  expect(setCameraSettings(before, "front", { width: 640, height: 360 }))
    .toMatchObject({ ok: false, error: expect.stringContaining("larger") });
  expect(before.cameras[0].width).toBe(1280);
});
