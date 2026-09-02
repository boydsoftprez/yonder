// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import { writeFileDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import { redactText } from "../net/runner.js";
import type { AdminCredential } from "./credential.js";
import { consolePaths, renderSettings, THEME_FILE, type ConsolePaths } from "./settings.js";
import { themeCss, themeName } from "./theme.js";

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
 * It writes two files — `settings.js` and the generated `theme.css` — and
 * restarts the console. It writes nothing else and it restarts nothing else. In particular it must **never**
 * restart `yonder-core` (R-SEC-12): the console is the internet-adjacent
 * surface and the daemon is what holds the network up, and a console that can
 * take the daemon with it is rule 6 broken through the side door. The constructor refuses a
 * unit name that looks like the daemon's, so that is a failure at start-up
 * rather than a discovery in the field.
 */

/**
 * The mode the generated files are written with. Neither carries a secret —
 * one is a description of the console and the other is a palette — and both
 * are read by a console running as a different account.
 */
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
    const wantedTheme = themeCss(themeName(config.ui.theme));

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
    const themePath = join(this.paths.publicDir, THEME_FILE);
    const settingsChanged = !existsSync(this.paths.settings)
      || readFileSync(this.paths.settings, "utf8") !== wanted;
    const themeChanged = !existsSync(themePath)
      || readFileSync(themePath, "utf8") !== wantedTheme;

    if (!settingsChanged && !themeChanged) {
      this.log("console: settings.js and theme.css are already what this configuration asks for");
      return;
    }

    // The palette, generated (R-UI-07). The directory is created rather than
    // required: it did not exist before this milestone, so a device upgraded
    // into this build has a console tree with no public/ in it.
    if (themeChanged) {
      this.log(`console: writing ${themePath}`);
      mkdirSync(this.paths.publicDir, { recursive: true });
      writeFileDurable(themePath, wantedTheme, SETTINGS_MODE);
    }

    // **Only `settings.js` costs a restart**, and the distinction is the whole
    // reason the palette is a separate file.
    //
    // `settings.js` is read once, by `require`, when Node-RED starts, so a
    // change to it is only in force after a restart — and a restart logs the
    // operator out (K-18). `theme.css` is served off disk by `httpStatic` on
    // every request, so a new one is in force at the operator's next page
    // load with nothing bounced.
    //
    // That matters more than it looks. A theme change goes through the apply
    // engine like everything else, which means it has to be confirmed from the
    // other side within the window or it reverts (R-CFG-03). If choosing a
    // theme restarted the console, the operator would be signed out by their
    // own change and would have to sign back in and confirm before the timer
    // ran out — so the ordinary case would be a theme that reverted.
    if (!settingsChanged) {
      this.log("console: the palette changed and nothing else, so the console is left running");
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
