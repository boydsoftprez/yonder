// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, ConfigSchema } from "../schema/config.js";
import type { DurableState } from "../state/types.js";
import { destinationReconciler, type RecoveryHardware } from "./recovery-destination.js";
import { hashPassword } from "../console/password.js";
const adminHash = hashPassword("fixture-console-password");
const source = { version: "2026.9.0", board: "radxa-zero3w" as const, configSchemaVersion: 1 as const };
function fixture() {
  const state: DurableState = { config: structuredClone(DEFAULT_CONFIG), secrets: { ap_psk: "fixture-ap-password", admin_password: adminHash, rtsp_password: "fixture-media-password" }, linuxOwner: null, zeroTier: null };
  const hardware: RecoveryHardware = { apCapable: true, interfaces: new Set(["wlan0", "usb0"]), cameras: new Set(["stable-camera"]), serial: new Set(["/dev/ttyS1"]) };
  return { state, hardware, run: (incoming = state, destination = state) => destinationReconciler(async () => hardware)({ incoming, destination, source, destinationSource: source }) };
}
describe("destination recovery policy", () => {
  it("retains compatible settings and never changes input state", async () => {
    const f = fixture(), before = structuredClone(f.state);
    expect((await f.run()).state).toEqual(f.state);
    expect(f.state).toEqual(before);
  });
  it("retains absent hardware identities while disabling automatic use", async () => {
    const f = fixture();
    f.state.config = ConfigSchema.parse({ ...f.state.config,
      cameras: [{ id: "front", name: "Front", source: "usb", device: "missing-camera", autostart: true }],
      mavlink: { ...f.state.config.mavlink, serial: { device: "/dev/ttyS9", baud: 115200 } },
      network: { ...f.state.config.network, modem: { enabled: true, mode: "appliance", interface: "absent0" } } });
    const result = await f.run();
    expect(result.state.config.cameras[0]).toMatchObject({ device: "missing-camera", autostart: false });
    expect(result.state.config.mavlink).toMatchObject({ serial: { device: "/dev/ttyS9" }, autocast: false });
    expect(result.state.config.network.modem).toMatchObject({ interface: "absent0", enabled: false });
    expect(result.compatibility).toMatchObject({ unavailableCameras: 1, unavailableUarts: 1, unavailableNetworkInterfaces: 1 });
  });
  it("preserves a usable setup AP without overwriting unrelated imported secrets", async () => {
    const f = fixture(), incoming = structuredClone(f.state);
    incoming.config.network.ap.enabled = false; incoming.config.network.ap.fallback.enabled = false;
    incoming.secrets = { ...incoming.secrets, ap_psk: "bad", recovery_ap_psk: "other-fixture-secret" };
    const result = await f.run(incoming);
    const ap = result.state.config.network.ap;
    expect(ap.enabled && ap.fallback.enabled).toBe(true);
    expect(result.state.secrets[ap.psk.secret]).toBe("fixture-ap-password");
    expect(result.state.secrets.recovery_ap_psk).toBe("other-fixture-secret");
    expect(incoming.config.network.ap.enabled).toBe(false);
  });
  it("rejects a destination without observed AP capability or usable recovery credentials", async () => {
    const f = fixture(); f.hardware.apCapable = false;
    await expect(f.run()).rejects.toThrow("not compatible");
    f.hardware.apCapable = true; f.state.secrets = {};
    await expect(f.run()).rejects.toThrow("not compatible");
  });
  it("does not treat identical UART enumeration on another board as the original device", async () => {
    const f = fixture(); f.state.config.mavlink.serial.device = "/dev/ttyS1";
    const result = await destinationReconciler(async () => f.hardware)({ incoming: f.state, destination: f.state,
      source, destinationSource: { ...source, board: "radxa-rock5c" } });
    expect(result.state.config.mavlink.serial.device).toBe("/dev/ttyS1");
    expect(result.state.config.mavlink.autocast).toBe(false);
    expect(result.compatibility.unavailableUarts).toBe(1);
  });
  it("rejects absent or malformed administrator hashes and unresolved network secrets", async () => {
    const f = fixture();
    for (const secrets of [{ ap_psk: "fixture-ap-password" }, { ...f.state.secrets, admin_password: "invalid-password-hash" }]) {
      await expect(f.run({ ...f.state, secrets })).rejects.toThrow("not compatible");
    }
    f.state.config.network.client = { ssid: "saved-network", psk: { secret: "missing_wifi_password" } };
    await expect(f.run()).rejects.toThrow("not compatible");
  });
});
