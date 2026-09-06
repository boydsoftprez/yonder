// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { unlinkDurable, writeFileDurable } from "../fs/durable.js";
import { MAVLINK_BAUDS } from "../schema/config.js";

/**
 * The port and speed that worked last time — state, never configuration (§3).
 *
 * R-MAV-13: a probe's answer is remembered as a hint that is tried first and
 * discarded when it fails, so replacing a flight controller heals on the next
 * boot rather than needing a file edited. That is the reasoning R-CAM-06 was
 * withdrawn for, applied to a serial port: writing a probed value into
 * config.yaml fails twice over, because the installer seeds config.yaml only
 * when it is absent (so the value goes stale on upgrade) and an image built
 * in a chroot on a build host would bake that build machine's answer into
 * every board flashed from it. So this is a cache under /var/lib/yonder that
 * an operator never edits and nothing reads as truth.
 *
 * Every read failure here returns `undefined` rather than throwing. A hint is
 * an optimisation on the path to telemetry starting at all (R-MAV-08): the
 * worst a bad one may cost is one wasted read before the ordinary sweep, so a
 * corrupt file, a truncated one, a wrong shape, or a baud nothing sweeps for
 * must all degrade the same way — never to a failed boot. A hint naming a
 * device that no longer exists degrades the same way too, but not by any
 * check in this file: this module only ever touches the state file, never the
 * serial device itself ("this file does filesystem I/O only"), so a vanished
 * port is invisible here and is instead just an ordinary failure the next
 * detect() attempt reports.
 *
 * Written and removed the way every other state file in this package is —
 * through writeFileDurable/unlinkDurable (fs/durable.ts): a fresh temp file,
 * fsync, atomic rename, fsync the directory, so a power cut leaves either the
 * whole old hint or the whole new one, never a torn file that readHint would
 * then have to treat as corrupt anyway. remote/renderer.ts's own record of
 * which mesh network it joined is the closest sibling to this file — an
 * unauthoritative fact about the world, cached under /var/lib/yonder in
 * exactly this style — and this matches that rather than the apply journal's
 * heavier, logging discard: nothing here is safety-critical enough to warrant
 * a warning, and nothing depends on a bad file being actively removed rather
 * than merely ignored, because the next successful probe overwrites it.
 */

export interface LinkHint {
  device: string;
  baud: number;
}

/**
 * 0750, matching the installer's mode for /var/lib/yonder itself
 * (installer/roles/10-base.sh: `ensure_dir /var/lib/yonder 0750`). This is
 * only ever reached when the hint's directory does not already exist; the
 * ordinary case is that the installer created it at install time and this
 * mkdir is a no-op.
 */
const HINT_DIR_MODE = 0o750;

export function readHint(path: string): LinkHint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  // Only null needs catching explicitly. Every other non-object JSON value —
  // a bare string, number or boolean — survives destructuring (JS boxes a
  // primitive rather than throwing) and comes out as `device: undefined`,
  // which the type check below already rejects; null is the one primitive
  // that destructuring throws on, and the one for which `typeof x` lies
  // ("object"). A `typeof parsed !== "object"` clause here once stood beside
  // this line and was deleted: every JSON value it caught, the checks below
  // already caught the same way, so no test could tell the two versions
  // apart (see hint.test.ts's "bare top-level primitive" case).
  if (parsed === null) return undefined;
  const { device, baud } = parsed as Record<string, unknown>;
  if (typeof device !== "string" || device.length === 0) return undefined;
  if (typeof baud !== "number" || !(MAVLINK_BAUDS as readonly number[]).includes(baud)) return undefined;
  return { device, baud };
}

export function writeHint(path: string, hint: LinkHint): void {
  // writeFileDurable fsyncs the containing directory, so it has to exist
  // first — config/defaults.ts's seedConfigIfAbsent creates /etc/yonder for
  // the same reason before it writes config.yaml into a fresh one.
  mkdirSync(dirname(path), { recursive: true, mode: HINT_DIR_MODE });
  // 0644: a port and a baud rate are not a secret.
  writeFileDurable(path, `${JSON.stringify(hint)}\n`, 0o644);
}

export function forgetHint(path: string): void {
  unlinkDurable(path);
}
