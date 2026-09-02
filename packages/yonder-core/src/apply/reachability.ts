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
    remote?: Record<string, unknown>;
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
  // Optional: a configuration parsed by this schema always has `remote`, but
  // this function is the one place a missing section would throw rather than
  // simply compare unequal, and throwing here fails an apply.
  delete copy.remote?.zerotier;
  return copy;
}
