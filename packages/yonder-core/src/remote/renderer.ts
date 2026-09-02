// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import type { Renderer } from "../apply/types.js";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import type { Config } from "../schema/config.js";
import { ZeroTierCli } from "./zerotier/cli.js";
import type { ZeroTierNetwork } from "./zerotier/parse.js";

const UNIT = "zerotier-one";

/**
 * Turns `remote.zerotier` into a running client on the right network.
 *
 * **Installing a client does not start one.** The Debian package enables and
 * starts itself, and a daemon with zero networks joined still holds live
 * sessions with ZeroTier's root servers — a board printed four of them,
 * unprompted, moments after the package landed. A device that talks to a
 * company's infrastructure because software is merely present contradicts the
 * first thing this project claims about itself, so the installer disables the
 * unit and this renderer is the only thing that starts it (R-VPN-08, R-VPN-05).
 */
export class RemoteRenderer implements Renderer {
  readonly name = "remote";

  private readonly cli: ZeroTierCli;
  private readonly run: CommandRunner;
  private readonly statePath: string;
  private readonly log: (line: string) => void;

  constructor(opts: {
    cli: ZeroTierCli;
    run: CommandRunner;
    /** Where the joined network is recorded, under /var/lib/yonder. */
    statePath: string;
    log?: (line: string) => void;
  }) {
    this.cli = opts.cli;
    this.run = opts.run;
    this.statePath = opts.statePath;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The network this renderer joined, on disk rather than in a field.
   *
   * It has to survive the process. A daemon restarts between a join and a leave
   * for entirely ordinary reasons - an upgrade, a reboot, a crash - and a
   * renderer that remembered this in memory would come back knowing nothing,
   * leave nothing, and strand the device on a mesh its configuration no longer
   * names. Recording it also keeps the leave narrow: Yonder removes what Yonder
   * joined, and a network an operator joined by hand stays theirs.
   */
  private owned(): string | null {
    try {
      const held = JSON.parse(readFileSync(this.statePath, "utf8")) as { network?: unknown };
      return typeof held.network === "string" ? held.network : null;
    } catch {
      // Absent or unreadable both mean the same thing: nothing is known to be
      // ours, so nothing is ours to leave.
      return null;
    }
  }

  private remember(network: string | null): void {
    if (network === null) unlinkDurable(this.statePath);
    else writeFileDurable(this.statePath, JSON.stringify({ network }) + "\n", 0o644);
  }

  private async systemctl(...args: string[]): Promise<void> {
    await this.run(["systemctl", ...args]);
  }

  async render(config: Config): Promise<void> {
    const { enabled, network_id } = config.remote.zerotier;
    const wanted = enabled && network_id !== null ? network_id : null;

    const held = this.owned();

    if (wanted === null) {
      // Leave only what we joined, then stop. A client that has gone
      // (uninstalled, or never was) fails listNetworks the same way it would
      // fail any other call, and there is nothing left to ask it to leave.
      if (held !== null) {
        try {
          for (const net of await this.cli.listNetworks()) {
            if (net.nwid === held) {
              this.log(`zerotier: leaving ${net.nwid}`);
              await this.cli.leave(net.nwid);
            }
          }
        } catch {
          /* no client to ask; the state file is still cleared below */
        }
      }
      this.remember(null);
      await this.systemctl("stop", UNIT);
      await this.systemctl("disable", UNIT);
      return;
    }

    // A network id that changed: leave the old one before joining the new, or
    // the device sits on both and the configuration describes neither.
    // Best-effort: a client that cannot honour this is about to be reported
    // as not installed below, which is the error that matters.
    if (held !== null && held !== wanted) {
      this.log(`zerotier: leaving ${held}`);
      await this.cli.leave(held).catch(() => {});
    }

    await this.systemctl("enable", "--now", UNIT);

    // Whether there is a client here at all is answered by the first thing we
    // actually need from it, not by a separate probe: a client that is
    // genuinely absent fails every subcommand the same way.
    let joined: ZeroTierNetwork[];
    try {
      joined = await this.cli.listNetworks();
    } catch {
      throw new Error(
        `zerotier is configured but the client is not installed on this device; ` +
          `re-run the installer with a payload that carries it`,
      );
    }
    if (!joined.some((n) => n.nwid === wanted)) {
      this.log(`zerotier: joining ${wanted}`);
      await this.cli.join(wanted);
    } else {
      this.log(`zerotier: already on ${wanted}`);
    }
    this.remember(wanted);

    // Deliberately not waited on. The next thing that happens is that a human
    // approves this device in a controller, which may be a minute or a week,
    // and a render is not the place to wait for a person (R-VPN-06).
  }
}
