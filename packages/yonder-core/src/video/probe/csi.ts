// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../../net/runner.js";
import { noCapabilities, present } from "../capability.js";
import type { Detection, Rejection } from "./camera.js";

/** R-CAM-01, R-CAM-14: expose the ISP's configured mode, read from hardware.
 * CSI media setup owns sensor timing and ISP scaling. This first integration
 * offers only that prepared mode, rather than inventing discrete modes from
 * the ISP's stepwise size range. Auxiliary raw/metadata nodes are not cameras.
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
  const interval = /fmt:[^\s/]+\/\d+x\d+@(\d+)\/(\d+)/.exec(sensors[0]);
  const fps = interval ? Number(interval[2]) / Number(interval[1]) : NaN;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    return reject("the CSI sensor did not report a supported integer frame rate");
  }
  const format = await runner(["v4l2-ctl", "-d", node, "--get-fmt-video"]);
  const size = /Width\/Height\s*:\s*(\d+)\/(\d+)/.exec(format.stdout);
  const pixel = /Pixel Format\s*:\s*'(NV12|NM12)'/.exec(format.stdout);
  if (format.code !== 0 || !size || !pixel) {
    return reject("prepare an NV12 capture mode on the CSI image processor before adding this camera");
  }
  const stable = names.get(node);
  return {
    device: node, card: sensors[0].split("\n")[0].replace(/^\d+:\s*/, "").replace(/ \(.*$/, ""),
    source: "csi", byPath: stable ?? node, byPathStable: stable !== undefined,
    capabilities: { ...noCapabilities(), formats: present([{
      fourcc: "NV12", width: Number(size[1]), height: Number(size[2]), rates: [fps],
    }]) },
  };
}
