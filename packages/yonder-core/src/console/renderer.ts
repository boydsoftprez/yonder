// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import { writeFileDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import { redactText } from "../net/runner.js";
import type { AdminCredential } from "./credential.js";
import { consolePaths, renderSettings, type ConsolePaths } from "./settings.js";

/**
 * The console, as a renderer.
 *
 * A sibling of `NetworkRenderer`: same interface, same injected
 * `CommandRunner`, same rule that nothing shells out except a renderer. Being
 * a `Renderer` is what puts `ui.*` inside M0's validate → snapshot → apply →
 * confirm-or-revert cycle without a line of new rollback machinery — a
 * console change that leaves the device unusable is reverted by the same
 * timer that reverts a network change (R-CFG-03).
 *
 * It does two things: write `settings.js`, and restart the console. It writes
 * nothing else and it restarts nothing else. In particular it must **never**
 * restart `yonder-core`: the console is the internet-adjacent surface and the
 * daemon is what holds the network up, and a console that can take the daemon
 * with it is rule 6 broken through the side door. The constructor refuses a
 * unit name that looks like the daemon's, so that is a failure at start-up
 * rather than a discovery in the field.
 */

/** The mode settings.js is written with. It carries no secret; it is read by the console. */
const SETTINGS_MODE = 0o644;

export interface ConsoleRendererOptions {
  runner: CommandRunner;
  /** Decides `provisioned`. The renderer never reads the hash, only whether there is one. */
  credential: AdminCredential;
  paths?: Partial<ConsolePaths>;
  log?: (line: string) => void;
}

export class ConsoleRenderer implements Renderer {
  readonly name = "console";
  private readonly runner: CommandRunner;
  private readonly credential: AdminCredential;
  private readonly paths: ConsolePaths;
  private readonly log: (line: string) => void;

  constructor(opts: ConsoleRendererOptions) {
    this.runner = opts.runner;
    this.credential = opts.credential;
    this.paths = consolePaths(opts.paths);
    this.log = opts.log ?? (() => {});
    if (/yonder-core/.test(this.paths.unit)) {
      throw new Error(
        `the console renderer will not restart ${this.paths.unit}: `
        + "a console that can take the configuration daemon down with it is a device nobody can reach",
      );
    }
  }

  async render(config: Config): Promise<void> {
    const wanted = renderSettings(config, {
      provisioned: this.credential.isSet(),
      paths: this.paths,
    });

    // A device where the console was never installed — 30-console.sh did not
    // run, or ran on a board whose node was too old — must still be able to
    // apply a network change. Failing here would fail every apply for ever,
    // and the thing it would take with it is the operator's only way to fix
    // the network. Loud, and skipped.
    const dir = dirname(this.paths.settings);
    if (!existsSync(dir)) {
      this.log(`console: ${dir} is not there, so there is no console to configure; skipping`);
      return;
    }

    // Compared before writing, and this is not an optimisation. Writing
    // unconditionally would restart the console on every apply and on every
    // start-up render, which means every network change logs the operator out
    // of the console they made it from — and start-up alone would bounce the
    // console each time yonder-core restarted. The text is a pure function of
    // the configuration and of whether a password is set, so equality here is
    // exactly "nothing about the console has changed".
    if (existsSync(this.paths.settings) && readFileSync(this.paths.settings, "utf8") === wanted) {
      this.log("console: settings.js is already what this configuration asks for");
      return;
    }

    this.log(`console: writing ${this.paths.settings}`);
    writeFileDurable(this.paths.settings, wanted, SETTINGS_MODE);
    await this.restart();
  }

  /**
   * Restart the console.
   *
   * A failure here fails the render, and so fails the apply, and so rolls the
   * configuration back — which is the right outcome: a console that will not
   * start is a device an operator cannot reach, and the previous
   * configuration is one that worked. The network renderer runs *before* this
   * one, so by the time this can fail the network is already settled and the
   * rollback returns it to what it was rather than leaving it unrendered.
   */
  private async restart(): Promise<void> {
    const argv = ["systemctl", "restart", this.paths.unit];
    this.log(`console: ${argv.join(" ")}`);
    const result = await this.runner(argv);
    if (result.code !== 0) {
      // Redacted by value against the argv, the same way NmcliError's
      // messages are. This argv carries no secret, but the mechanism is the
      // mechanism and a future argv might.
      const detail = redactText(result.stderr.trim() || result.stdout.trim(), argv);
      throw new Error(
        `could not restart ${this.paths.unit} (exit ${result.code})`
        + (detail === "" ? "" : `: ${detail}`),
      );
    }
  }
}
