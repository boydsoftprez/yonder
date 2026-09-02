// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../../net/runner.js";
import {
  parseInfo,
  parseNetworks,
  parsePeers,
  type ZeroTierInfo,
  type ZeroTierNetwork,
  type ZeroTierPeer,
} from "./parse.js";

/**
 * `zerotier-cli` lives in /usr/sbin and reads a 0600 token owned by its own
 * user, so it needs root. `yonder-core` already runs as root — its unit sets
 * `Group=yonder` and no `User=` — and the console, which runs as `yonder`,
 * reaches all of this through the daemon socket and holds no privilege of its
 * own. Nothing here needs a sudoers entry, and nothing should acquire one.
 */
const BIN = "zerotier-cli";

export class ZeroTierCliError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly code: number,
  ) {
    super(message);
    this.name = "ZeroTierCliError";
  }
}

export class ZeroTierCli {
  constructor(
    private readonly run: CommandRunner,
    private readonly trace: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.trace(argv.join(" "));
    const { code, stdout, stderr } = await this.run(argv);
    if (code !== 0) {
      const said = (stderr || stdout).trim().split("\n")[0] ?? "";
      throw new ZeroTierCliError(
        said === "" ? `${argv.join(" ")} exited ${code}` : said,
        argv,
        code,
      );
    }
    return stdout;
  }

  async info(): Promise<ZeroTierInfo> {
    return parseInfo(await this.exec([BIN, "-j", "info"]));
  }

  async listNetworks(): Promise<ZeroTierNetwork[]> {
    return parseNetworks(await this.exec([BIN, "-j", "listnetworks"]));
  }

  async listPeers(): Promise<ZeroTierPeer[]> {
    return parsePeers(await this.exec([BIN, "-j", "listpeers"]));
  }

  async join(nwid: string): Promise<void> {
    await this.exec([BIN, "join", nwid]);
  }

  async leave(nwid: string): Promise<void> {
    await this.exec([BIN, "leave", nwid]);
  }

  /**
   * Whether there is a client here at all. A board installed before ZeroTier
   * was carried in the payload has none, and the renderer must say so rather
   * than fail with a shell error.
   */
  async installed(): Promise<boolean> {
    try {
      await this.info();
      return true;
    } catch {
      return false;
    }
  }
}
