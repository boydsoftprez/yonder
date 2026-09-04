// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/**
 * Whether an apply could cost the operator their way back to the device.
 *
 * The confirmation window exists for exactly one reason: a configuration
 * change can take the device off the air, and R-NET-07 and R-CFG-03 require it
 * to come back by itself when that happens. The window is the cost of that
 * guarantee, not a virtue in its own right.
 *
 * **Everything is reachable until proven otherwise.** This compares the whole
 * document with the parts that cannot affect reachability removed, rather than
 * listing the parts that can. A field added to the schema next year is then
 * treated as load-bearing by default: the failure mode of getting this wrong
 * in one direction is a palette that reverts itself, and in the other it is a
 * device nobody can reach. Only one of those is recoverable from a chair.
 *
 * `ui.theme` is the only exemption today, and it earned it the hard way:
 * R-CFG-11 removed the operator confirmation, so a theme change went pending
 * and reverted two minutes later with nothing on the console able to confirm
 * it. An operator chose a palette, watched it take, and watched it undo
 * itself.
 */
export function affectsReachability(previous: Config, next: Config): boolean {
  return JSON.stringify(withoutCosmetics(previous)) !== JSON.stringify(withoutCosmetics(next));
}

/**
 * Every key on a camera. Not derived — written down, so that adding a field to
 * the schema fails a test rather than silently acquiring a default.
 */
export const CAMERA_LEAVES = [
  "id", "name", "source", "device", "enabled", "autostart",
  "width", "height", "framerate", "codec", "bitrate_kbps",
  "preview", "controls", "outputs",
] as const;

/**
 * The camera leaves that cannot cost the operator their way back to the
 * device.
 *
 * The test for membership is not "is this cosmetic" but **"does changing this
 * alter what leaves the aircraft on the path the console is standing on"**.
 * The console reaches a flying aircraft over the same cellular uplink the
 * video leaves by, so an added output or a raised ceiling is spend on that
 * path — and nobody has yet measured what a saturated uplink does to a console
 * session on a board. R-VPN-07 requires an exemption to be earned by
 * measurement rather than by argument, so `bitrate_kbps` and `outputs` stay
 * load-bearing until somebody measures.
 *
 * `preview` is the one entry here that *is* egress on that path, and it is
 * exempt because the schema bounds it: `max(2000)` kb/s and `max(1280)` px
 * mean no reachable setting of it can saturate a link. The exemption is safe
 * because the range is. Widening either bound means removing `preview` from
 * this list in the same change — `reachability.test.ts` asserts the bound so
 * the two cannot drift apart quietly.
 *
 * Everything absent falls through to load-bearing, which is this file's whole
 * design: `id`, `name`, `device`, `enabled` and `autostart` all change what
 * the aircraft is doing or which hardware it is doing it with.
 */
export const CAMERA_EXEMPT_LEAVES = [
  "width", "height", "framerate", "codec", "preview", "controls",
] as const;

/** The document with the fields that cannot affect reachability removed. */
function withoutCosmetics(config: Config): unknown {
  const copy = structuredClone(config) as {
    ui: Record<string, unknown>;
    remote?: { zerotier?: Record<string, unknown> };
    cameras?: Record<string, unknown>[];
  };
  delete copy.ui.theme;
  // Joining a mesh only ever *adds* a path to this device; it cannot take away
  // the one the operator is using. Measured rather than assumed: on a board, a
  // join installed exactly one route - the mesh's own subnet - and left the
  // default route, the LAN route and the access-point route untouched. A
  // controller was then made to push a route overlapping the board's own LAN
  // and the client refused to install it.
  //
  // Only zerotier, and only because of that. Everything else here stays
  // load-bearing by default, which is this file's whole design: a second mesh
  // earns its own exemption with its own evidence, or does not get one
  // (R-VPN-07).
  //
  // Named field by field, not by subtree, for the same reason: `ui.theme` is a
  // leaf and so are these. Deleting `remote.zerotier` whole would hand the
  // exemption to every field added under it later, with nobody deciding it
  // should have one and nothing in this file changing for a reviewer to look
  // at. `allow_default` is the worked example waiting to happen — the one
  // ZeroTier knob that *can* replace the default route, which §4 says Yonder
  // never turns on — and it would have shipped kept, with no window and no
  // rollback timer. An unknown sibling falls through to load-bearing, which is
  // this file's whole design.
  //
  // Optional: a configuration parsed by this schema always has `remote`, but
  // this function is the one place a missing section would throw rather than
  // simply compare unequal, and throwing here fails an apply.
  const zerotier = copy.remote?.zerotier;
  if (zerotier !== undefined) {
    delete zerotier.enabled;
    delete zerotier.network_id;
  }
  // Named leaf by leaf, on each element, for the reason the ZeroTier note
  // above gives: `delete copy.cameras` would hand the exemption to every
  // field added under a camera later, with nobody deciding it should have
  // one and nothing in this file changing for a reviewer to look at.
  //
  // The array itself stays. Adding a camera, removing one, or reordering the
  // list is load-bearing: each is a different set of pipelines running on the
  // aircraft, and the count is what the uplink is shared between.
  for (const camera of copy.cameras ?? []) {
    for (const leaf of CAMERA_EXEMPT_LEAVES) delete camera[leaf];
  }
  return copy;
}
