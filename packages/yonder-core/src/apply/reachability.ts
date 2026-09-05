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

/** The document with the fields that cannot affect reachability removed. */
function withoutCosmetics(config: Config): unknown {
  const copy = structuredClone(config) as {
    ui: Record<string, unknown>;
    remote?: { zerotier?: Record<string, unknown> };
    mavlink?: Record<string, unknown>;
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
  // A ground-station endpoint touches no interface, no route and no radio, so
  // it cannot take away the path the operator is reaching the device on —
  // which is the only thing the confirmation window exists to protect.
  //
  // The failure this prevents is specific and bad: the window reverts *and
  // reboots*, so an operator adjusting a port mid-flight over a marginal link
  // loses the video, the telemetry and the mesh a minute after touching
  // something that could not have cost them any of it (R-CFG-12, §5).
  //
  // Leaf by leaf, exactly as `remote.zerotier` above and for the same reason.
  // `mavlink.serial`, `mavlink.ingest` and `mavlink.tcp_server.port` are
  // deliberately absent, and each earns its absence on its own. The first
  // moves which wire the router opens, and the second opens an
  // unauthenticated command path to the vehicle (R-MAV-07); neither has been
  // shown to be safe to keep. The port is not like those two, and not like its
  // own sibling `tcp_server.enabled` either: it is a number the schema would
  // otherwise accept in full, and a value the schema accepts can still be a
  // port some other service on the device already holds. R-MAV-14 refuses
  // exactly one such collision — with `ui.port`, the console's own — which
  // leaves every other one for the window to catch, not the schema. A
  // validator is a narrower promise than a rollback.
  const mavlink = copy.mavlink;
  if (mavlink !== undefined) {
    delete mavlink.endpoints;
    delete mavlink.autocast;
    const tcp = mavlink.tcp_server as Record<string, unknown> | undefined;
    if (tcp !== undefined) {
      delete tcp.enabled;
    }
  }
  return copy;
}
