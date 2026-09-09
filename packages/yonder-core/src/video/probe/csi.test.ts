// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeRockchipCsi } from "./csi.js";
import type { CommandRunner } from "../../net/runner.js";

const graph = readFileSync(new URL("./fixtures/seekerhd-media.txt", import.meta.url), "utf8");
const format = readFileSync(new URL("./fixtures/seekerhd-format.txt", import.meta.url), "utf8");
const names = new Map([["/dev/video0", "platform-rkisp-vir0-video-index0"]]);
function runner(media = graph, mode = format, card = "rkisp_mainpath"): CommandRunner {
  return async (argv) => ({ code: 0, stderr: "", stdout:
    argv.includes("--info") ? `Card type : ${card}\nBus info : platform:rkisp-vir0\n`
      : argv[0] === "media-ctl" ? media : mode });
}
describe("Rockchip CSI discovery from the SeekerHD board", () => {
  it("reads the prepared NV12 mode and sensor timing without inventing sizes", async () => {
    const result = await probeRockchipCsi("/dev/video0", "rkisp_mainpath", runner(), names);
    expect(result).toMatchObject({ source: "csi", byPathStable: true,
      capabilities: { formats: { state: "present", value: [
        { fourcc: "NV12", width: 1280, height: 720, rates: [30] },
      ] } } });
  });
  it("rejects an ISP with no connected sensor", async () => {
    const result = await probeRockchipCsi("/dev/video0", "rkisp_mainpath",
      runner(graph.replace("subtype Sensor", "subtype Unknown")), names);
    expect(result).toHaveProperty("reason", expect.stringContaining("one connected sensor"));
  });
  it("rejects raw Bayer and auxiliary capture nodes", async () => {
    for (const fake of [runner(graph, format.replace(/NM12|NV12/g, "RG10")), runner(graph, format, "rkisp_selfpath")]) {
      expect(await probeRockchipCsi("/dev/video0", "rkisp_mainpath", fake, names)).toHaveProperty("reason");
    }
  });
});
