// SPDX-License-Identifier: GPL-3.0-or-later
import type { Renderer } from "../apply/types.js";
import type { Camera, Config } from "../schema/config.js";
import { RTSP_BASE } from "../media/ports.js";
import { noCapabilities } from "./capability.js";
import { compose, refuse, encodeControl, encodesIn, type EncodeName } from "./pipeline.js";
import type { Encoder } from "./probe/encoder.js";
import type { EncoderChannel } from "./encoder.js";
import type { Supervisor } from "./supervisor.js";

/** Apply and rollback reach the running picture through the same renderer
 * (R-CTL-03, R-CFG-03). Bitrate-only edits prefer the shared live channel;
 * unavailable control and structural pipeline changes retain the respawn path.
 * A video failure is reported without blocking a network repair. */
export interface VideoApplyReport {
  outcome: "unchanged" | "retuned" | "restarted" | "failed";
  interruption: string[];
  continuous?: boolean;
  detail?: string;
}

export interface PipelineRendererOptions {
  accessory?: (identity: string) => import('./accessory/source.js').AccessoryInput | undefined;
  /**
   * The one supervisor this process owns. Given, never constructed here: a
   * second supervisor would hold no handle to any running pipeline and would
   * therefore find every camera stopped and do nothing at all — the silent
   * no-op K-48 already is, rebuilt one layer up.
   */
  supervisor: Supervisor;
  channel?: EncoderChannel;
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
  private readonly channel?: EncoderChannel;
  private rendering = false;
  get busy(): boolean { return this.rendering; }
  private reports = new Map<string, VideoApplyReport>();

  report(id: string): VideoApplyReport | undefined { return this.reports.get(id); }
  private readonly encoder: () => Promise<Encoder>;
  private readonly rtspBase: string;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: PipelineRendererOptions) {
    this.supervisor = opts.supervisor;
    this.channel = opts.channel;
    this.encoder = opts.encoder;
    this.rtspBase = opts.rtspBase ?? RTSP_BASE;
    this.log = opts.log ?? (() => {});
  }

  /** Compare composed structure with the retained recipe, and changed rates
   * with the host's observed values. Adopt a recipe only after it takes effect,
   * so later applies, rollback and crash recovery all refer to the same rate. */
  async render(config: Config): Promise<void> {
    this.rendering = true;
    try { await this.renderPipelines(config); }
    finally { this.rendering = false; }
  }

  private async renderPipelines(config: Config): Promise<void> {
    this.reports = new Map(config.cameras.map((c) => [c.id, { outcome: "unchanged", interruption: [] }]));
    await this.channel?.settled();
    // Nothing is probed and nothing is composed for a board with no pipeline
    // running — which is every board at start-up, where `renderCurrent()`
    // runs this before anything has ever been started. A `v4l2-ctl` sweep on
    // every apply, to answer a question about no cameras, is a cost with no
    // reader.
    //
    // Capture each recipe after earlier live commands have settled.
    const running = config.cameras
      .map((camera) => ({ camera, current: this.supervisor.recipe(camera.id) }))
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
      for (const { camera } of running) this.reports.set(camera.id, {
        outcome: "failed", interruption: [], detail: `could not read the encoder: ${(e as Error).message}`,
      });
      return;
    }

    for (const { camera, current } of running) {
      let next: string[];
      try {
        if (camera.source === 'accessory') {
          const refusal = refuse({ camera, capabilities: noCapabilities(), encoder, rtspBase: this.rtspBase, accessory: this.opts.accessory?.(camera.device) });
          if (refusal) throw new Error(refusal);
        }
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
          // **And the console now says out loud which of the two it thinks
          // is turning the picture** (R-CTL-15): the camera deck draws
          // Mirror, Flip and Rotation on every camera and names the sensor
          // beside a control the sensor will carry, from the *probed*
          // capabilities. So on a camera that offers one of the three, the
          // page reads "the camera turns this itself" while the line this
          // renderer would compose on the next apply turns it a second time
          // on the board. The disagreement did not change; what changed is
          // that an operator can now read one half of it.
          //
          // The fix is a capability answer both composers share, and it is
          // not this task's to choose: probing here costs a v4l2 sweep inside
          // an apply, and an apply that hangs is the failure R-CFG-03 and
          // R-NET-07 exist to prevent. Until then this is a known defect with
          // no camera on the bench that can reach it, recorded rather than
          // papered over. `pipeline.test.ts` pins the disagreement so that it
          // cannot become invisible.
          capabilities: noCapabilities(),
          accessory: this.opts.accessory?.(camera.device),
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
        this.reports.set(camera.id, { outcome: "failed", interruption: [], detail: `could not compose the pipeline: ${(e as Error).message}` });
        continue;
      }

      // An operator Stop during the encoder probe still wins. Crash backoff
      // retains a recipe so apply and rollback can correct its next retry.
      if (this.supervisor.recipe(camera.id) === null) continue;
      const targetRates = encodesIn(next);
      const observed = this.channel?.inForce(camera.id);
      const fixedRateDiffers = observed != null && (["stream", "preview"] as const).some((branch) =>
        camera[branch].mode === "fixed" && targetRates[branch] !== null && observed[branch] !== targetRates[branch]);
      if (same(current, next) && !fixedRateDiffers) continue;
      if (this.channel !== undefined && same(withRates(current, encodesIn(next)), next)) {
        const generation = this.supervisor.generation(camera.id);
        let accepted = true;
        let continuous = true;
        const target = encodesIn(next);
        try {
          for (const branch of ["stream", "preview"] as const) {
            const wanted = target[branch];
            // An unchanged adaptive policy owns its current observed rate.
            if (camera[branch].mode !== "fixed" && encodesIn(current)[branch] === wanted) continue;
            if (wanted === null || this.channel.inForce(camera.id)?.[branch] === wanted) continue;
            const ack = await this.channel.retune(camera, branch, wanted);
            if ("notControllable" in ack || ack.observed !== wanted) { accepted = false; break; }
            continuous &&= ack.continuous;
          }
        } catch (e) {
          accepted = false;
          this.log(`video: ${camera.id} could not retune (${(e as Error).message}); trying its new launch line`);
        }
        // A Stop/crash during the request must never be turned into a Start.
        if (this.supervisor.recipe(camera.id) === null) {
          this.reports.set(camera.id, { outcome: "failed", interruption: ["the pipeline stopped before its settings could be applied"] });
          continue;
        }
        if (generation !== this.supervisor.generation(camera.id)) accepted = false;
        if (accepted) {
          this.supervisor.adoptArgv(camera.id, next);
          this.reports.set(camera.id, { outcome: "retuned", continuous,
            interruption: continuous ? [] : ["the encoder reported a break in the picture"],
          });
          this.log(`video: ${camera.id}'s running encoder accepted its new bitrate`);
          continue;
        }
      }

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
        this.reports.set(camera.id, { outcome: "failed", interruption: ["the picture stopped and could not be restarted"], detail: (e as Error).message });
        continue;
      }
      this.reports.set(camera.id, { outcome: "restarted", interruption: ["restarts the picture"], detail: "new pipeline started; waiting for the supervisor to observe it running" });
      this.log(`video: ${camera.id}'s settings changed, so its pipeline was restarted`);
    }
  }
}

/** Two launch lines, token for token. */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

/** Replace only the known bitrate property of each named encode. All other
 * tokens still have to match exactly; codec/source/preview-size edits restart. */
function withRates(argv: readonly string[], rates: { stream: number | null; preview: number | null }): string[] {
  const next = [...argv];
  for (const branch of ["stream", "preview"] as EncodeName[]) {
    const rate = rates[branch];
    if (rate === null) continue;
    const set = encodeControl(argv, branch, rate);
    if (set === null) continue;
    const start = next.indexOf(`name=${set.element}`);
    for (let i = start + 1; start >= 0 && i < next.length && next[i] !== "!"; i++) {
      if (next[i].startsWith(`${set.property}=`)) next[i] = `${set.property}=${set.value}`;
    }
  }
  return next;
}
