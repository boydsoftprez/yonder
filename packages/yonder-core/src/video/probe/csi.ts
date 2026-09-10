// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../../net/runner.js";
import { noCapabilities, present } from "../capability.js";
import type { Detection, Rejection } from "./camera.js";

/** R-CAM-01, R-CAM-14: read sensor timing and verify ISP output sizes.
 * Candidate sizes come from the active sensor and are retained only when
 * non-mutating TRY_FMT returns that exact NV12 mode. Auxiliary nodes are not cameras.
 */
export async function probeRockchipCsi(
  node: string, card: string, runner: CommandRunner, names: ReadonlyMap<string, string>,
): Promise<Detection | Rejection> {
  const reject = (reason: string): Rejection => ({ device: node, card, reason });
  const info = await runner(["v4l2-ctl", "-d", node, "--info"]);
  if (info.code !== 0 || !/Card type\s*:\s*rkisp(?:1)?_mainpath\s*$/m.test(info.stdout)) {
    return reject("this is an auxiliary ISP node, not the CSI camera's main capture path");
  }
  const bus = /Bus info\s*:\s*(platform:[\w.-]+)/.exec(info.stdout)?.[1];
  if (!bus) return reject("the CSI capture device did not identify its media bus");
  const graph = await runner(["media-ctl", "-d", bus, "-p"]);
  const sensors = graph.stdout.split(/^- entity /m).filter((s) => /subtype Sensor\b/.test(s));
  if (graph.code !== 0 || sensors.length !== 1 || !/\[ENABLED\]/.test(sensors[0])) {
    return reject("the CSI media graph must have one connected sensor before capture can start");
  }
  const interval = /fmt:[^\s/]+\/(\d+)x(\d+)@(\d+)\/(\d+)/.exec(sensors[0]);
  const measuredFps = interval ? Number(interval[4]) / Number(interval[3]) : NaN;
  // Sensor timing is reported as a rational interval, whose clock granularity can
  // produce rates such as 29.97 or 29.9856 for the nominal 30 fps configuration.
  const fps = Math.round(measuredFps);
  if (!Number.isFinite(measuredFps) || fps < 1 || fps > 60 ||
      Math.abs(measuredFps - fps) / fps > 0.001) {
    return reject("the CSI sensor did not report a supported nominal frame rate");
  }
  const format = await runner(["v4l2-ctl", "-d", node, "--get-fmt-video"]);
  const size = /Width\/Height\s*:\s*(\d+)\/(\d+)/.exec(format.stdout);
  const pixel = /Pixel Format\s*:\s*'(NV12|NM12)'/.exec(format.stdout);
  if (format.code !== 0 || !size || !pixel) {
    return reject("prepare an NV12 capture mode on the CSI image processor before adding this camera");
  }
  const stable = names.get(node);
  const formats = [{ fourcc: 'NV12', width: Number(size[1]), height: Number(size[2]), rates: [fps] }];
  // Full sensor field and reduced copies. These are queries, not assumed
  // capabilities: some drivers round/clamp unsupported dimensions.
  const nativeWidth = Number(interval![1]);
  const nativeHeight = Number(interval![2]);
  for (const ratio of [1, 2 / 3, 1 / 3]) {
    const width = Math.floor(nativeWidth * ratio / 8) * 8;
    const height = Math.floor(nativeHeight * ratio / 8) * 8;
    if (width < 160 || height < 90 || width > 3840 || height > 2160 ||
        formats.some(f => f.width === width && f.height === height)) continue;
    const tried = await runner(['v4l2-ctl', '-d', node,
      `--try-fmt-video=width=${width},height=${height},pixelformat=NV12`]);
    const actual = /Width\/Height\s*:\s*(\d+)\/(\d+)/.exec(tried.stdout);
    if (tried.code === 0 && actual && Number(actual[1]) === width && Number(actual[2]) === height &&
        /Pixel Format\s*:\s*'(NV12|NM12)'/.test(tried.stdout)) {
      formats.push({ fourcc: 'NV12', width, height, rates: [fps] });
    }
  }
  return {
    device: node, card: sensors[0].split("\n")[0].replace(/^\d+:\s*/, "").replace(/ \(.*$/, ""),
    source: "csi", byPath: stable ?? node, byPathStable: stable !== undefined,
    capabilities: { ...noCapabilities(), formats: present(formats) },
  };
}
