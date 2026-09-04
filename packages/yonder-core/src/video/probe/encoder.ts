// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../../net/runner.js";

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
  readonly element: "v4l2h264enc" | "x264enc";
  readonly device: string | null;
  readonly hardware: boolean;
  readonly codec: "h264";
  readonly detail: string;
}

/** The M2M nodes worth asking. Cheap: each is two ioctls against a node. */
const CANDIDATES = Array.from({ length: 8 }, (_, i) => `/dev/video${10 + i}`);

const RAW = /'(YU12|NV12|YUYV|NV21|YV12)'/;
const H264 = /'H264'/;

const SOFTWARE: Encoder = {
  element: "x264enc", device: null, hardware: false, codec: "h264",
  detail: "software H.264 (x264enc) — this board offers no hardware encoder",
};

export async function probeEncoder(
  opts: { runner?: CommandRunner; override?: string } = {},
): Promise<Encoder> {
  // R-CAM-13's escape hatch: "An operator may name one explicitly to bypass
  // the probe." Written `element:device`, or bare `x264enc`.
  if (opts.override) {
    const [element, device] = opts.override.split(":");
    if (element === "x264enc") {
      return { ...SOFTWARE, detail: "software H.264 (x264enc) — named by the operator" };
    }
    if (element === "v4l2h264enc" && device) {
      return {
        element: "v4l2h264enc", device, hardware: true, codec: "h264",
        detail: `hardware H.264 on ${device} — named by the operator, not probed`,
      };
    }
  }

  const runner = opts.runner ?? systemRunner;
  for (const node of CANDIDATES) {
    const out = await runner(["v4l2-ctl", "-d", node, "--list-formats-out"]);
    if (out.code !== 0 || !RAW.test(out.stdout)) continue;
    const cap = await runner(["v4l2-ctl", "-d", node, "--list-formats"]);
    if (cap.code !== 0 || !H264.test(cap.stdout)) continue;
    return {
      element: "v4l2h264enc", device: node, hardware: true, codec: "h264",
      detail: `hardware H.264 on ${node} — raw in, H.264 out`,
    };
  }
  return SOFTWARE;
}
