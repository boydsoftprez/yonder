// SPDX-License-Identifier: GPL-3.0-or-later
import type { Renderer } from "../apply/types.js";
import type { Camera, Config } from "../schema/config.js";
import { RTSP_BASE } from "../media/ports.js";
import { noCapabilities } from "./capability.js";
import { compose } from "./pipeline.js";
import type { Encoder } from "./probe/encoder.js";
import type { Supervisor } from "./supervisor.js";

/**
 * Making the running pipelines match the configuration that was applied
 * (R-VID-07, R-CFG-03).
 *
 * **This is K-48's fix.** An operator changed a camera's bitrate on Setup,
 * pressed Apply and confirmed it. `config.yaml` took the new value and the
 * console said `confirmed`, and `gst-launch-1.0` went on running
 * `video_bitrate=100000` on both branches — same pid, no restart, twenty
 * seconds later. `pipeline.ts` bakes the rate into the launch line, so a
 * respawn is the only way a new value reaches the encoder, and nothing
 * performed one. An apply was silently a no-op for the picture, which is
 * worse than refusing the change.
 *
 * **Why a respawn and not a live retune.** `EncoderChannel` exists
 * (`video/encoder.ts`) and it is right: on this board every retune answers
 * `notControllable`, because `gst-launch-1.0` reads its pipeline from argv
 * and then takes no instruction — no property interface, no socket, no stdin
 * protocol — and `v4l2h264enc`'s controls are per-open-handle, so no outside
 * process can reach the encoder either (K-53). The program that would answer
 * is not in this repository, and the GStreamer composer is being replaced by
 * ffmpeg besides, so building one now would be thrown away. A respawn is the
 * sanctioned path and it survives that pivot untouched: the spec's own
 * control table says *the current implementation respawns* for a fixed
 * bitrate and *pipeline respawn on Apply* for a resolution.
 *
 * **Why a `Renderer` and not a hook on the apply route.** The apply engine
 * drives renderers inside validate → snapshot → apply → confirm-or-revert, so
 * being one is what buys the confirmation window and the rollback for
 * nothing: a change that is not confirmed takes the pipeline back with it,
 * which is R-CFG-03 applied to the picture. A camera left on a bitrate the
 * operator did not keep is a camera the rollback did not reach.
 *
 * **It relays; it decides nothing** (R-CMD-04, R-CMD-05). It restarts what
 * the operator applied and it never chooses a value, never starts a camera
 * that is not running, and never stops one for any reason but to start it
 * again a line later.
 *
 * **Composer-agnostic, deliberately.** This file does not know which fields
 * of a camera reach the launch line. It composes the line the new
 * configuration implies and compares it, token for token, against the line
 * the running pipeline was actually started with. Differ, restart; same,
 * leave it entirely alone. Add a field to the launch line tomorrow and this
 * keeps working with no edit here — and, just as important, a field that
 * reaches no launch line (`name`) costs nobody a picture.
 */
export interface PipelineRendererOptions {
  /**
   * The one supervisor this process owns. Given, never constructed here: a
   * second supervisor would hold no handle to any running pipeline and would
   * therefore find every camera stopped and do nothing at all — the silent
   * no-op K-48 already is, rebuilt one layer up.
   */
  supervisor: Supervisor;
  /**
   * Which encoder this board has (R-CAM-13). The same injected probe
   * `POST /cameras/:id/run` composes with, so the line this file builds for a
   * camera and the line a Start would build for it cannot differ by their
   * encoder.
   */
  encoder: () => Promise<Encoder>;
  /** Where a pipeline publishes. Defaults to the constant the start route
   *  spends, because a second answer here would restart every camera on every
   *  apply for ever — see the note on `render`. */
  rtspBase?: string;
  log?: (line: string) => void;
}

export class PipelineRenderer implements Renderer {
  readonly name = "video";
  private readonly supervisor: Supervisor;
  private readonly encoder: () => Promise<Encoder>;
  private readonly rtspBase: string;
  private readonly log: (line: string) => void;

  constructor(opts: PipelineRendererOptions) {
    this.supervisor = opts.supervisor;
    this.encoder = opts.encoder;
    this.rtspBase = opts.rtspBase ?? RTSP_BASE;
    this.log = opts.log ?? (() => {});
  }

  /**
   * **The comparison is the whole design.** `supervisor.argv(id)` is the line
   * a running pipeline was actually started with — not a copy of the
   * configuration, which is the mistake K-48 is made of: every file that
   * answered from `config.yaml` agreed with `config.yaml` and was wrong about
   * the encoder. `compose()` builds the line this configuration implies. The
   * two are either equal or they are not, and nothing here has to know which
   * field moved.
   *
   * **Equality has to be exact, and cheaply so.** The two lines are built by
   * the same function from the same constants, so an unchanged configuration
   * yields an identical argv and no camera moves. That is why `rtspBase`
   * defaults to the value the start route spends rather than being restated:
   * a second answer to *where does a pipeline publish* would make every apply
   * differ from every running line, and every apply would drop every
   * camera's picture — on an aircraft, for a Wi-Fi change.
   *
   * **A camera with no running pipeline is left exactly as it is.** Start and
   * Stop are runtime actions that survive no apply (R-CTL-01): a
   * configuration change must never put a camera on the air that the operator
   * took off it. `argv()` is null for a camera that is stopped, and *also*
   * null in the gap between a failed spawn and its retry — so a camera that
   * is in backoff when an apply lands keeps climbing its old ladder. That is
   * the narrow case this seam does not reach; it is recorded in K-48 rather
   * than papered over here.
   *
   * **Nothing in this file may fail an apply.** Renderers run in sequence and
   * a failure stops the ones behind it, so this one is last and it swallows
   * what it cannot do — an encoder that will not answer, a configuration
   * `compose()` refuses to build, a spawner that will not spawn. Rule 6: the
   * console is how an operator fixes a device and video is not, and a camera
   * that could not be restarted must never be the reason a network change
   * cannot be applied. Every one of them is said out loud instead.
   */
  async render(config: Config): Promise<void> {
    // Nothing is probed and nothing is composed for a board with no pipeline
    // running — which is every board at start-up, where `renderCurrent()`
    // runs this before anything has ever been started. A `v4l2-ctl` sweep on
    // every apply, to answer a question about no cameras, is a cost with no
    // reader.
    //
    // The line each one is running is taken here, in one pass, rather than
    // read again inside the loop. Two cameras cannot share an id — the schema
    // refuses it, because mediamtx takes one publisher per path — so a
    // restart below can only ever move the entry it names, and a second read
    // would be a guard against a case that cannot arise and that no test
    // could turn red.
    const running = config.cameras
      .map((camera) => ({ camera, current: this.supervisor.argv(camera.id) }))
      .filter((r): r is { camera: Camera; current: readonly string[] } => r.current !== null);
    if (running.length === 0) return;

    let encoder: Encoder;
    try {
      encoder = await this.encoder();
    } catch (e) {
      // Reported, not raised. Without the board's encoder there is no line to
      // compare against, so the honest outcome is that the pipelines are left
      // running what they were running — the same answer as "nothing changed",
      // and said in words so it is not mistaken for one.
      this.log(
        `video: this board's encoder could not be read (${(e as Error).message}), `
        + `so ${running.length} running pipeline(s) were left as they are`,
      );
      return;
    }

    for (const { camera, current } of running) {
      let next: string[];
      try {
        next = compose({
          camera,
          // This renderer probes no camera — a device round trip per apply,
          // inside the confirmation window, to re-derive what the Setup page
          // already shows the operator — so it has no capability set to offer
          // and says so rather than inventing one.
          //
          // **That was free until R-CTL-05, and it is not any more.**
          // `compose()` now reads `capabilities` as well as `refuse()` does:
          // it composes a `videoflip` for a camera whose *sensor* cannot turn
          // the picture, and none for one whose sensor can. The start route
          // composes with what it probed; this composes with `noCapabilities`,
          // which claims the camera offers nothing. For a camera that really
          // offers no `horizontal_flip`, `vertical_flip` or `rotate` — every
          // camera on the bench today — the two agree and nothing is wrong.
          // For a camera that offers one of the three and has it set, they do
          // not: this line carries a board correction the running line does
          // not, so the pipeline is restarted once for a configuration that
          // did not change, and comes back turning the picture twice — once
          // at the sensor, once on the board.
          //
          // The fix is a capability answer both composers share, and it is
          // not this task's to choose: probing here costs a v4l2 sweep inside
          // an apply, and an apply that hangs is the failure R-CFG-03 and
          // R-NET-07 exist to prevent. Until then this is a known defect with
          // no camera on the bench that can reach it, recorded rather than
          // papered over. `pipeline.test.ts` pins the disagreement so that it
          // cannot become invisible.
          capabilities: noCapabilities(),
          encoder,
          rtspBase: this.rtspBase,
        });
      } catch (e) {
        // `compose()` throws on a configuration it will not build — an SRT
        // output is the one that exists today, refused before composition
        // because it would listen with no password on it (R-SEC-13). That
        // camera keeps the pipeline it has; every other camera is still
        // considered, and the apply still succeeds, because a video output
        // this build cannot serve must not cost an operator their network.
        this.log(
          `video: ${camera.id}'s configuration could not be composed `
          + `(${(e as Error).message}), so its pipeline was left as it is`,
        );
        continue;
      }

      if (same(current, next)) continue;

      try {
        // Stop, then start, and in that order: the supervisor's own start
        // returns without doing anything for a camera it considers running,
        // so a start alone would be the silent no-op this file exists to end.
        this.supervisor.stop(camera.id);
        this.supervisor.start(camera.id, next);
      } catch (e) {
        // The stop has already happened, so this camera is now off the air
        // and stays off until somebody presses Start. That is a worse outcome
        // than not having tried, and it is still better than a failed apply:
        // it costs one picture rather than the operator's way back in.
        this.log(
          `video: ${camera.id} was stopped for its new settings and could not be `
          + `started again (${(e as Error).message}); start it from the camera page`,
        );
        continue;
      }
      this.log(`video: ${camera.id}'s settings changed, so its pipeline was restarted`);
    }
  }
}

/** Two launch lines, token for token. */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}
