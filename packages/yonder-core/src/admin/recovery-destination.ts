// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync } from "node:fs";
import type { RecoveryDestinationReconciler } from "../recovery/service.js";
import { RecoveryImportError } from "../recovery/import.js";
import { runSensitiveProcess } from "./sensitive-process.js";
import { isSupportedPasswordHash } from "../console/password.js";
import { ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { MEDIA_OBSERVER_SECRET } from "../media/config.js";

export interface RecoveryHardware {
  apCapable: boolean;
  interfaces: ReadonlySet<string>;
  cameras: ReadonlySet<string>;
  serial: ReadonlySet<string>;
}
function directory(path: string): string[] {
  try { return readdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Read-only capability query; never scans UARTs, starts a camera or changes a connection. */
export async function readRecoveryHardware(): Promise<RecoveryHardware> {
  const result = await runSensitiveProcess({ command: "/usr/bin/nmcli",
    args: ["--terse", "--fields", "GENERAL.DEVICE,WIFI-PROPERTIES.AP", "device", "show"], maxOutputBytes: 64 * 1024 });
  const devices = directory("/dev");
  return {
    apCapable: /^WIFI-PROPERTIES\.AP:yes$/m.test(result.stdout.toString("utf8")),
    interfaces: new Set(directory("/sys/class/net")),
    cameras: new Set([...directory("/dev/v4l/by-path"), ...devices.filter(name => /^video[0-9]+$/.test(name)).map(name => `/dev/${name}`)]),
    serial: new Set([...devices.filter(name => /^(tty(S|AMA|USB|ACM)[0-9]+|serial[0-9]+)$/.test(name)).map(name => `/dev/${name}`),
      ...directory("/dev/serial/by-id").map(name => `/dev/serial/by-id/${name}`),
      ...directory("/dev/serial/by-path").map(name => `/dev/serial/by-path/${name}`)]),
  };
}

function validPsk(value: string | undefined): value is string {
  return typeof value === "string" && (/^[\x20-\x7e]{8,63}$/.test(value) || /^[a-fA-F0-9]{64}$/.test(value));
}

/** Keep exact hardware identities; absent devices are retained but cannot start automatically. */
export function destinationReconciler(observe: () => Promise<RecoveryHardware> = readRecoveryHardware): RecoveryDestinationReconciler {
  return async ({ incoming, destination, source, destinationSource }) => {
    const hardware = await observe();
    if (!hardware.apCapable) throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    const state = structuredClone(incoming);
    if (!isSupportedPasswordHash(state.secrets[ADMIN_PASSWORD_SECRET])) throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    const changedBoard = source.board !== destinationSource.board;
    const ap = state.config.network.ap;
    if (!validPsk(state.secrets[ap.psk.secret])) {
      const previous = destination.config.network.ap;
      const password = destination.secrets[previous.psk.secret];
      if (!validPsk(password)) throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
      let reference = "recovery_ap_psk";
      for (let index = 0; Object.hasOwn(state.secrets, reference); index++) reference = `recovery_ap_psk_${index}`;
      state.secrets = { ...state.secrets, [reference]: password };
      state.config.network.ap = { ...structuredClone(previous), psk: { secret: reference } };
    }
    state.config.network.ap.enabled = true;
    state.config.network.ap.fallback.enabled = true;
    // A missing reference can abort all native network rendering before the
    // setup AP is installed. Reject it before staging any active generation.
    const requireReferences = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(requireReferences); return; }
      const fields = value as Record<string, unknown>;
      if (Object.keys(fields).length === 1 && typeof fields.secret === "string"
        && typeof state.secrets[fields.secret] !== "string") throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
      Object.values(fields).forEach(requireReferences);
    };
    requireReferences(state.config);
    const client = state.config.network.client;
    if (client.ssid !== null && client.psk !== null && !validPsk(state.secrets[client.psk.secret]))
      throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    if (state.config.cameras.length > 0 && !state.secrets.rtsp_password)
      throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    if (state.config.cameras.some(camera => camera.outputs.some(output => output.kind === "rtsp" && output.enabled))
      && !state.secrets[MEDIA_OBSERVER_SECRET]) throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    let unavailableCameras = 0;
    for (const camera of state.config.cameras) {
      // Accessory availability requires the running daemon's USB owner. The
      // helper deliberately does not open another USB session during restore.
      if (!hardware.cameras.has(camera.device) || (changedBoard && (camera.source === "csi" || camera.device.startsWith("/dev/video")))) {
        unavailableCameras++;
        camera.autostart = false;
      }
    }
    const device = state.config.mavlink.serial.device;
    const unavailableUarts = (device !== "auto" && !hardware.serial.has(device))
      || (changedBoard && !device.startsWith("/dev/serial/by-id/")) ? 1 : 0;
    if (unavailableUarts) state.config.mavlink.autocast = false;
    const modem = state.config.network.modem;
    const unavailableNetworkInterfaces = modem.mode === "appliance" && modem.interface !== null
      && !hardware.interfaces.has(modem.interface) ? 1 : 0;
    if (unavailableNetworkInterfaces) modem.enabled = false;
    return { state, compatibility: { unavailableCameras, unavailableUarts,
      unavailableNetworkInterfaces, apFallbackReachable: true } };
  };
}
