// SPDX-License-Identifier: GPL-3.0-or-later
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readFileSync } from "node:fs";
import { StateCoordinatorError } from "../state/coordinator.js";

export const MANAGED_MARKERS = ["/etc/yonder-storage-prototype.conf", "/etc/yonder-pi-storage-prototype.conf", "/etc/yonder-storage-layout.conf"];

export function managedImageTarget(): "rpi" | "radxa-zero3w" | "radxa-rock5c" | "conventional" {
  if (existsSync("/etc/yonder-storage-layout.conf")) {
    const raw = rootFile("/etc/yonder-storage-layout.conf", 4096, 0);
    const target = /^TARGET=(rpi|radxa-zero3w|radxa-rock5c)$/m.exec(raw)?.[1];
    if (!target) unavailable();
    return target as "rpi" | "radxa-zero3w" | "radxa-rock5c";
  }
  if (existsSync("/etc/yonder-pi-storage-prototype.conf")) return "rpi";
  if (existsSync("/etc/yonder-storage-prototype.conf")) {
    const raw = rootFile("/etc/yonder/bench-image", 4096, 0);
    const target = /^target=(radxa-zero3w|radxa-rock5c)$/m.exec(raw)?.[1];
    if (!target) unavailable();
    return target as "radxa-zero3w" | "radxa-rock5c";
  }
  return "conventional";
}

function unavailable(): never {
  throw new StateCoordinatorError("STATE_UNAVAILABLE", "managed storage mode could not be verified");
}

function rootFile(path: string, maximum: number, uid: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o022) !== 0
      || stat.size < 1 || stat.size > maximum) unavailable();
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size) unavailable();
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}

/** PID 1's namespace matters: ProtectSystem makes the helper's own root read-only. */
export function observeStorageMode(input: {
  markers?: string[]; modePath?: string; mountInfoPath?: string; ownerUid?: number;
} = {}): "protected" | "maintenance" {
  try {
    const markers = (input.markers ?? MANAGED_MARKERS).filter(existsSync);
    if (!markers.length) return "protected"; // Conventional installs have no managed boot operation.
    const uid = input.ownerUid ?? 0;
    const layouts = markers.map((path) => rootFile(path, 4096, uid));
    const pi = markers.some((path) => path.endsWith("yonder-pi-storage-prototype.conf"))
      || layouts.some((layout) => /^TARGET=rpi$/m.test(layout));
    const raw = rootFile(input.modePath ?? "/run/yonder-storage-mode", 32, uid);
    if (raw !== "protected\n" && raw !== "maintenance\n") unavailable();
    const mode = raw === "protected\n" ? "protected" : "maintenance";
    const expected = mode === "protected" ? "ro" : "rw";
    const lines = readFileSync(input.mountInfoPath ?? "/proc/1/mountinfo", "utf8").split("\n");
    for (const target of pi ? ["/", "/boot/firmware"] : ["/"]) {
      const mounts = lines.map((line) => line.split(" - ")[0].split(" "))
        .filter((fields) => fields[4] === target);
      if (mounts.length !== 1) unavailable();
      const options = new Set(mounts[0][5]?.split(","));
      if (!options.has(expected) || options.has(expected === "ro" ? "rw" : "ro")) unavailable();
    }
    return mode;
  } catch { return unavailable(); }
}
