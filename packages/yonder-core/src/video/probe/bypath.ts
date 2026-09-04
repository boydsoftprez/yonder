// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * A camera's identity, resolved from the socket it is plugged into (R-CAM-05).
 *
 * `/dev/video0` is whichever camera the kernel probed first this boot. Two
 * cameras swapped between sockets, or one unplugged and replugged, renumber
 * silently — and a configuration holding `/dev/video0` then points at a
 * different camera without anything having changed in the file. The kernel
 * already publishes the stable answer in `/dev/v4l/by-path/`, one symlink per
 * name pointing at the node that name currently means, so the work here is to
 * read that directory and invert it.
 *
 * **Nothing in this file throws** — the same rule the rest of `probe/` keeps.
 * A board with no `/dev/v4l/by-path` at all (no camera has ever been attached,
 * so udev has not created it) is an empty map and a visible fallback, not an
 * exception that takes the Cameras page down.
 *
 * ---
 *
 * **Three things the board taught us, recorded because none was obvious.**
 *
 * 1. **The kernel publishes more than one name for the same node.** This board
 *    lists both a `usb-` and a `usbv2-` form, and both point at `/dev/video0`:
 *
 *        platform-…-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0   -> ../../video0
 *        platform-…-pci-0000:01:00.0-usbv2-0:1.3:1.0-video-index0 -> ../../video0
 *
 *    Either would survive a reboot, so the requirement is not *which* one but
 *    that it is *the same one every time*. Directory order is not that: it is
 *    whatever the filesystem hands back. So the candidates are sorted and the
 *    first is taken. Deliberately a plain sort and **not `localeCompare`** —
 *    collation is locale-dependent, and a name that changed with the daemon's
 *    environment would reintroduce exactly the instability being removed here.
 *
 *    Sorting rather than ranking the prefixes because the set of alias forms
 *    is the kernel's to change: `usbv2-` did not exist on older kernels and
 *    something else may exist on the next one. A rule that needs no list
 *    cannot fall out of date with one. (On this board it happens to select the
 *    `usb-` form, since `-` sorts before `v`.)
 *
 * 2. **`-video-indexN` is not `/dev/videoN`.** `platform-fe00b840.mailbox-
 *    video-index3` points at `/dev/video16`. The index counts nodes within one
 *    interface, so the only way to know which node a name means is to follow
 *    the link — which is why this maps node to name rather than parsing either.
 *
 * 3. **A camera's identity is its capture node.** A UVC camera owns two nodes
 *    and publishes `-video-index0` for the capture node and `-video-index1`
 *    for the metadata node that answers no formats. Keying the map by the
 *    resolved node is what keeps those apart: the capture node is the one
 *    `camera.ts` accepts, so it is the one whose name is asked for. This is
 *    the same rule as one row per card, seen from the other end.
 */

/** Where udev publishes the stable names. */
export const BY_PATH_DIR = "/dev/v4l/by-path";

/** One entry of that directory, as the kernel wrote it. */
export interface ByPathEntry {
  /** The link's own name — the stable identity a configuration stores. */
  readonly name: string;
  /** Where it points, verbatim and usually relative: `../../video0`. */
  readonly target: string;
}

/**
 * Injected so a test resolves names from the recorded directory listing
 * without a `/dev` tree. The seam is the *directory reader*, not the resolver:
 * the selection rule above is the part worth testing, so it must not be the
 * part a test replaces.
 */
export type ByPathReader = () => readonly ByPathEntry[];

/**
 * The real directory.
 *
 * Absent, unreadable, or holding something that is not a symlink: an empty
 * list. A board that has never had a camera attached has no `/dev/v4l` at all,
 * and that is an ordinary state, not a fault.
 */
export const systemByPath = (dir: string = BY_PATH_DIR): ByPathEntry[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ByPathEntry[] = [];
  for (const name of names) {
    try {
      out.push({ name, target: readlinkSync(join(dir, name)) });
    } catch {
      // Not a symlink, or it vanished between the listing and the read. One
      // unreadable entry is not a reason to lose the others.
    }
  }
  return out;
};

/**
 * Every node that has a stable name, mapped to the one name it will be given.
 *
 * Pure: `posix.resolve` is string arithmetic, so this touches no filesystem
 * and a test can drive it from the recorded listing. posix rather than the
 * host's separator because these are Linux device paths wherever the tests run.
 */
export function byPathNames(
  entries: readonly ByPathEntry[],
  dir: string = BY_PATH_DIR,
): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const { name, target } of entries) {
    const node = posix.resolve(dir, target);
    const found = candidates.get(node);
    if (found) found.push(name);
    else candidates.set(node, [name]);
  }
  const out = new Map<string, string>();
  for (const [node, names] of candidates) {
    // See (1) above: sorted, so the answer is the same on every boot.
    out.set(node, [...names].sort()[0]);
  }
  return out;
}
