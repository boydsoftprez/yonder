// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { Renderer } from "../apply/types.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import { systemReader, type FileReader } from "./read.js";

/**
 * `system.hostname` made real (R-CFG-08, and what makes `<hostname>.local`
 * a name that exists).
 *
 * The key has been in the schema since M0, defaults to `yonder`, and until now
 * was read by nothing — a configuration key that does nothing is worse than an
 * absent one, because it invites an operator to set it and expect an effect.
 *
 * It matters for this milestone because of what an operator has to do after
 * joining a Wi-Fi network: the access point goes away, the device takes a DHCP
 * address on the new network, and they have to find it again. A name is the
 * only answer to that which does not involve a router's admin page. Avahi
 * publishes the system hostname over mDNS, so setting the system hostname is
 * the half of that this daemon owns.
 *
 * **A renderer, so it inherits apply and rollback** rather than being set once
 * at install and drifting from the file that claims to decide it. It runs on
 * every start-up render too, which is what makes a board whose hostname was
 * changed by something else come back to what the configuration says.
 */

/** Where the static hostname lives on every system this runs on. */
export const HOSTNAME_FILE = "/etc/hostname";

export interface HostnameRendererOptions {
  runner?: CommandRunner;
  read?: FileReader;
  log?: (line: string) => void;
  /** Overrides HOSTNAME_FILE. Test-only. */
  hostnameFile?: string;
}

export class HostnameRenderer implements Renderer {
  readonly name = "hostname";
  private readonly runner: CommandRunner;
  private readonly read: FileReader;
  private readonly log: (line: string) => void;
  private readonly hostnameFile: string;

  constructor(opts: HostnameRendererOptions = {}) {
    this.runner = opts.runner ?? systemRunner;
    this.read = opts.read ?? systemReader;
    this.log = opts.log ?? (() => {});
    this.hostnameFile = opts.hostnameFile ?? HOSTNAME_FILE;
  }

  /**
   * **Never fails a render**, and that is a deliberate trade rather than an
   * oversight.
   *
   * Renderers run in sequence and a failure stops the ones behind it and rolls
   * the apply back (K-19). If this one could fail, a board with no
   * `hostnamectl` — or one where systemd-hostnamed is not running — would have
   * every network change it will ever be sent rejected, because of a name. A
   * device that cannot be reconfigured is the failure rule 6 is about; a
   * device with the wrong name is an inconvenience. So a refusal is logged,
   * lands in the activity log the console shows, and the render carries on.
   *
   * The cost is that a hostname that could not be set is a silent-ish success:
   * the configuration says one name and the system has another. That is
   * visible in the log and on the status page, which is where an operator
   * looking for their device by name would go next.
   */
  async render(config: Config): Promise<void> {
    const wanted = config.system.hostname;
    const current = (this.read(this.hostnameFile) ?? "").trim();

    // Idempotent by comparison rather than by hoping the command is. Setting
    // the hostname is cheap but not free — systemd-hostnamed signals the
    // change and NetworkManager may re-send it over DHCP — and this runs on
    // every apply and every start-up render.
    if (current === wanted) {
      this.log(`hostname: already ${wanted}`);
      return;
    }

    // Safe on a command line by construction: the schema holds this to
    // /^[a-z0-9][a-z0-9-]{0,62}$/, so it cannot be a flag, a path or a second
    // argument. Stated here, where the value is used, rather than left to a
    // reader to go and check.
    this.log(`hostname: setting ${current === "" ? "(unset)" : current} to ${wanted}`);
    const result = await this.runner(["hostnamectl", "set-hostname", wanted]);
    if (result.code !== 0) {
      this.log(
        `hostname: could not set it to ${wanted} (hostnamectl exited ${result.code}); `
        + "the device will still be reachable by address",
      );
    }
  }
}
