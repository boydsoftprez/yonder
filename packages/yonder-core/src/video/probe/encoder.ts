// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../../net/runner.js";

export type EncoderElement = "v4l2h264enc" | "x264enc" | "mpph264enc";

/**
 * Which encoder this board actually has (R-CAM-13, R-CAM-07).
 *
 * **Probed, never looked up.** R-CAM-06 is withdrawn because resolving this at
 * install time fails twice over: the installer seeds config.yaml only when
 * absent, so the value goes stale on upgrade, and an image build runs the
 * installer in a chroot on a build host, which would bake a build machine's
 * answer into a board's image.
 *
 * **The direction is the test.** A memory-to-memory node has an output side
 * (what you feed it) and a capture side (what it gives back). An encoder takes
 * raw in and gives H.264 out; the decoder K-40 records does the opposite. A
 * probe that only looked for a node mentioning H264 would pick the decoder,
 * which advertises MJPEG and cannot be started.
 */
export interface Encoder {
  /** The H.264 encoder. `pipeline.ts` and the launch-line readers key on it. */
  readonly element: EncoderElement;
  /** The H.265 encoder, where the board has one (R-CAM-08); null elsewhere. */
  readonly h265: "mpph265enc" | null;
  /** The hardware MJPEG decoder, where the board has one (spec §5); null elsewhere. */
  readonly decoder: "mppjpegdec" | null;
  /**
   * The hardware H.264 decoder, where the MPP registry exposes one.
   *
   * This is intentionally independent from both `element` and `decoder`:
   * MPP can register an encoder or JPEG decoder without registering a usable
   * H.264 decoder. Accessory video is already H.264, so `pipeline.ts` reads
   * this capability rather than guessing from either of those other elements.
   */
  readonly h264Decoder?: "mppvideodec" | null;
  /**
   * The node this board's encoder is on, or null where it is software.
   *
   * **Informational. It names the encoder; it does not select it.**
   * `v4l2h264enc`'s own `device` property is *readable only*: the
   * video4linux2 plugin scans the board's devices when it registers, binds an
   * element to each, and the property reports which node that element was
   * given. So `pipeline.ts` cannot pass this value on, and does not try —
   * setting it draws a GObject CRITICAL and is ignored. Selection is by
   * element *name*: the first device offering a codec takes the generic name
   * and any others take a per-device one, which is why this board carries
   * both `v4l2convert` (/dev/video12) and `v4l2video18convert`
   * (/dev/video18).
   *
   * On a board with one H.264 encoder — this one, where /dev/video11 is the
   * only node taking raw in and giving H.264 out — the probe's answer and
   * GStreamer's binding are the same node and nothing is lost. **On a board
   * with two they could differ, and this field would then name the encoder
   * the pipeline is not using.** Steering it would need the element name
   * `v4l2video<N>h264enc`, which `element` above cannot express. Said here,
   * where the field is defined, rather than left to be discovered.
   */
  readonly device: string | null;
  readonly hardware: boolean;
  readonly detail: string;
}

/**
 * The node Rockchip's MPP encoders open. Informational: nothing passes it to
 * an element. It is `0600 root:root` on Armbian, and a process that cannot
 * open it sees the plugin register its *decoders* and none of its encoders,
 * silently — so a probe run as anyone but root answers "no hardware encoder
 * found" on a board that has two. `yonder-core` runs as root; the installer
 * role that proves the plugin runs as root. Recorded here because the day
 * either stops being true, this is the string that will be wrong.
 */
export const MPP_DEVICE = "/dev/mpp_service";

const CANDIDATES = Array.from({ length: 8 }, (_, i) => `/dev/video${10 + i}`);
const RAW = /'(YU12|NV12|YUYV|NV21|YV12)'/;
const H264 = /'H264'/;

const SOFTWARE: Encoder = {
  element: "x264enc", h265: null, decoder: null, device: null, hardware: false,
  // What the probe knows, and no more: it found none. "This board offers no
  // hardware encoder" was printed to operators of a board with two (spec §8).
  detail: "software H.264 (x264enc) — no hardware encoder found",
};

const MPP: Encoder = {
  element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec", h264Decoder: "mppvideodec",
  device: MPP_DEVICE, hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};

/** Whether GStreamer's registry carries `element`: `--exists` exits 0 for yes, 1 for no. */
async function registered(runner: CommandRunner, element: string): Promise<boolean> {
  const answer = await runner(["gst-inspect-1.0", "--exists", element]);
  return answer.code === 0;
}

/**
 * The Rockchip arm. An RK3566 has no V4L2 memory-to-memory node at all — its
 * two encoders and its RGA block are reached through MPP and appear in
 * GStreamer only as the `rockchipmpp` plugin's elements — so the question is
 * put to the registry, not to /dev. Asked first: a board that registers
 * `mpph264enc` is a Rockchip board whatever else it carries.
 */
async function probeMpp(runner: CommandRunner): Promise<Encoder | null> {
  if (!(await registered(runner, "mpph264enc"))) return null;
  const h265 = (await registered(runner, "mpph265enc")) ? "mpph265enc" : null;
  const decoder = (await registered(runner, "mppjpegdec")) ? "mppjpegdec" : null;
  const h264Decoder = (await registered(runner, "mppvideodec")) ? "mppvideodec" : null;
  return {
    ...MPP, h265, decoder, h264Decoder,
    detail: h265 === null
      ? "hardware H.264 through Rockchip MPP (mpph264enc)"
      : MPP.detail,
  };
}

export async function probeEncoder(
  opts: { runner?: CommandRunner; override?: string } = {},
): Promise<Encoder> {
  if (opts.override) {
    const [element, device] = opts.override.split(":");
    if (element === "x264enc") {
      return { ...SOFTWARE, detail: "software H.264 (x264enc) — named by the operator" };
    }
    if (element === "mpph264enc") {
      return { ...MPP, h264Decoder: null, detail: "hardware H.264 and H.265 through Rockchip MPP — named by the operator, not probed" };
    }
    if (element === "v4l2h264enc" && device) {
      return {
        element: "v4l2h264enc", h265: null, decoder: null, device, hardware: true,
        detail: `hardware H.264 on ${device} — named by the operator, not probed`,
      };
    }
  }
  const runner = opts.runner ?? systemRunner;
  const mpp = await probeMpp(runner);
  if (mpp !== null) return mpp;
  for (const node of CANDIDATES) {
    const out = await runner(["v4l2-ctl", "-d", node, "--list-formats-out"]);
    if (out.code !== 0 || !RAW.test(out.stdout)) continue;
    const cap = await runner(["v4l2-ctl", "-d", node, "--list-formats"]);
    if (cap.code !== 0 || !H264.test(cap.stdout)) continue;
    return {
      element: "v4l2h264enc", h265: null, decoder: null, device: node, hardware: true,
      detail: `hardware H.264 on ${node} — raw in, H.264 out`,
    };
  }
  return SOFTWARE;
}
