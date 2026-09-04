// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import type { SecretStore } from "../secrets/store.js";
import type { Config } from "../schema/config.js";
import type { Renderer } from "../apply/types.js";
import { mediamtxConfig } from "./config.js";

const UNIT = "mediamtx";

/**
 * Where the generated configuration lives, and why it is not under
 * `/etc/yonder` with everything else.
 *
 * The file carries the RTSP credential in clear, so it must not be readable by
 * any account but the one serving video — and `mediamtx.service` deliberately
 * runs as an unprivileged `yonder-media`, not as root. That rules out both of
 * the directories the daemon already writes: `/etc/yonder` is `0750 root:root`
 * because it holds `secrets.yaml`, and `/var/lib/yonder` is `0750 root:yonder`
 * because group `yonder` is the *socket* group — putting the media server in
 * it would hand a network-facing process the daemon's control socket (K-01),
 * which is a far larger grant than a config file.
 *
 * So the media server gets a directory of its own, `0750 root:yonder-media`,
 * and `yonder-core.service` names it in `ReadWritePaths`. That widening is one
 * narrow, purpose-made directory rather than a general loosening of the
 * sandbox, and `assert_daemon_can_write` in `50-mediamtx.sh` fails the install
 * if the unit and this constant ever drift apart — the check that exists
 * because a generated file outside the sandbox once left a board stuck in
 * setup mode with no way in.
 */
export const MEDIA_CONFIG_PATH = "/etc/mediamtx/mediamtx.yml";

/**
 * `0640`, not `0600`. Root writes it and `yonder-media` reads it; the group
 * comes from the setgid bit on the directory the installer creates, so nothing
 * here has to resolve a numeric gid. Nobody else on the device can read it at
 * all (R-SEC-10).
 */
const MODE = 0o640;

/**
 * What systemd says when the thing asked for is not on the device.
 *
 * Matched on the wording, as `remote/renderer.ts` matches it, because no exit
 * status separates "absent" from "refused" — and getting it wrong in either
 * direction costs a clearer or a vaguer message, never an action taken.
 */
const ABSENT = /not loaded|does not exist|not found|no such file/i;

/**
 * Turns the camera configuration into the media server's (ADR-0003).
 *
 * The credential is generated **once, per device**, exactly as the access
 * point's passphrase is: the configuration holds a reference, the value lands
 * in secrets.yaml at 0600, and the operator never types it because the receive
 * line resolves it and hands them the whole URL to copy. It inherits R-SEC-01
 * (no shared default), R-SEC-07 (never in a published image) and R-SEC-10
 * (never in a log, an error, or a support bundle) without further work.
 *
 * **The service follows the configuration.** No camera means nothing to serve,
 * and nothing to serve is not a reason to keep a listener open — so the unit
 * is stopped, disabled, and its configuration taken off the disk with the
 * credential inside it.
 *
 * **And it only ever touches what it started.** The generated file is the
 * record of that, so a device that has never had a camera is left entirely
 * alone — the same narrowness `RemoteRenderer` needed after a palette change
 * stopped a mesh client Yonder had never started.
 */
export class MediaRenderer implements Renderer {
  readonly name = "media";
  private readonly path: string;
  private readonly runner: CommandRunner;
  private readonly secrets: SecretStore;
  private readonly log: (line: string) => void;

  constructor(opts: {
    path?: string;
    runner?: CommandRunner;
    secrets: SecretStore;
    log?: (line: string) => void;
  }) {
    this.path = opts.path ?? MEDIA_CONFIG_PATH;
    this.runner = opts.runner ?? systemRunner;
    this.secrets = opts.secrets;
    this.log = opts.log ?? (() => {});
  }

  /**
   * `systemctl`, with its exit status read rather than discarded.
   *
   * `systemRunner` never rejects, deliberately, so a caller decides what a
   * failure means. Here a `restart` that failed is a console reporting a
   * configured camera over a picture that will never arrive, so it fails the
   * apply and says what systemd said.
   *
   * The one tolerated failure is a unit systemd has never heard of, and only
   * for `stop` and `disable`: a payload built without a media server is a
   * valid payload (R-CFG-08), and a device carrying no mediamtx must not fail
   * every later apply — including one that has nothing to do with video.
   */
  private async systemctl(args: string[], opts: { absentIsFine?: boolean } = {}): Promise<void> {
    const { code, stdout, stderr } = await this.runner(["systemctl", ...args, UNIT]);
    if (code === 0) return;
    const reason = said(stderr, stdout, code);
    if (opts.absentIsFine === true && ABSENT.test(reason)) {
      this.log(`media: ${UNIT} is not installed here, so it is already off`);
      return;
    }
    throw new Error(`systemctl ${args.join(" ")} ${UNIT} failed: ${reason}`);
  }

  async render(config: Config): Promise<void> {
    if (config.cameras.length === 0) {
      // Nothing configured and nothing of ours running: there is nothing to
      // do, and doing something anyway is how a service somebody else set up
      // goes away. A default device reaches this branch on every apply, and
      // the mesh renderer learned the hard way what happens when a renderer
      // acts on a service it has no record of having started.
      //
      // The generated file *is* that record — written with the first camera,
      // removed with the last — which is the same source of truth
      // 50-mediamtx.sh consults before it stops anything.
      if (!existsSync(this.path)) return;
      await this.systemctl(["stop"], { absentIsFine: true });
      await this.systemctl(["disable"], { absentIsFine: true });
      // Last, so a stop that failed leaves the file standing and the next
      // apply tries again — and so the installer's ownership check, which
      // reads exactly this path, still says the daemon owns a running service.
      unlinkDurable(this.path);
      return;
    }

    // Only now. A device with no camera generates no credential, which is what
    // makes R-SEC-07 true of a published image without anything having to
    // remember to strip one.
    const { value: rtspPassword } = this.secrets.ensure("rtsp_password", "password");
    const next = mediamtxConfig({ config, rtspPassword });
    const current = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
    if (current === next) {
      // An unchanged file is an unchanged server. Restarting anyway would drop
      // every viewer's picture on an apply that changed a different section.
      return;
    }
    writeFileDurable(this.path, next, MODE);
    // Enabled as well as started, and the pair matters. The installer ships
    // mediamtx off and nothing else on the device starts it, so a `restart`
    // alone gives video that survives until the next power cycle and no
    // further: the boot-time render finds this file unchanged and correctly
    // does nothing. `enable` is what makes the next boot bring it back.
    await this.systemctl(["enable"]);
    await this.systemctl(["restart"]);
    this.log(`media: ${config.cameras.length} camera(s) configured; ${UNIT} restarted`);
  }
}

/** Everything a command said about itself, or its exit status. */
function said(stderr: string, stdout: string, code: number): string {
  const lines = (stderr || stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length === 0 ? `exited ${code}` : lines.join("; ");
}
