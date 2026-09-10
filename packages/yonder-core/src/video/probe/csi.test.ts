// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeRockchipCsi } from "./csi.js";
import type { CommandRunner } from "../../net/runner.js";

const graph = readFileSync(new URL("./fixtures/seekerhd-media.txt", import.meta.url), "utf8");
const format = readFileSync(new URL("./fixtures/seekerhd-format.txt", import.meta.url), "utf8");
const names = new Map([["/dev/video0", "platform-rkisp-vir0-video-index0"]]);
function runner(media = graph, mode = format, card = "rkisp_mainpath"): CommandRunner {
  return async (argv) => {
    const attempt = /width=(\d+),height=(\d+)/.exec(argv.join(' '));
    const tried = attempt ? mode.replace(/(Width\/Height\s*:\s*)\d+\/\d+/, `$1${attempt[1]}/${attempt[2]}`) : mode;
    return { code: 0, stderr: "", stdout:
    argv.includes("--info") ? `Card type : ${card}\nBus info : platform:rkisp-vir0\n`
      : argv[0] === "media-ctl" ? media : tried };
  };
}
describe("Rockchip CSI discovery from the SeekerHD board", () => {
  it("offers the current mode and exact ISP-verified full-field sizes at the sensor rate", async () => {
    const result = await probeRockchipCsi("/dev/video0", "rkisp_mainpath", runner(), names);
    expect(result).toMatchObject({ source: "csi", byPathStable: true,
      capabilities: { formats: { state: "present", value: [
        { fourcc: "NV12", width: 1280, height: 720, rates: [30] },
        { fourcc: "NV12", width: 1920, height: 1080, rates: [30] },
        { fourcc: "NV12", width: 640, height: 360, rates: [30] },
      ] } } });
  });
  it('does not offer a size the ISP clamps or refuses', async () => {
    const normal = runner();
    const clamped: CommandRunner = argv => argv.some(a => a.startsWith('--try-fmt-video='))
      ? Promise.resolve({ code: 0, stdout: format, stderr: '' }) : normal(argv);
    const result = await probeRockchipCsi('/dev/video0', 'rkisp_mainpath', clamped, names);
    expect(result).toMatchObject({ capabilities: { formats: { value: [
      { fourcc: 'NV12', width: 1280, height: 720, rates: [30] },
    ] } } });
  });
  it('keeps reduced modes available after native 1080p becomes the current output', async () => {
    const native = format.replace('1280/720', '1920/1080');
    const result = await probeRockchipCsi('/dev/video0', 'rkisp_mainpath', runner(graph, native), names);
    expect(result).toMatchObject({ capabilities: { formats: { value: [
      { width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 640, height: 360 },
    ] } } });
  });
  it.each([
    ['NTSC-derived 29.97 fps', '1001/30000'],
    ['HDR timing of 4952376/148500000', '4952376/148500000'],
  ])('advertises %s as nominal 30 fps', async (_name, interval) => {
    const timedGraph = graph.replaceAll('4950000/148500000', interval);
    const result = await probeRockchipCsi('/dev/video0', 'rkisp_mainpath', runner(timedGraph), names);
    expect(result).toMatchObject({ capabilities: { formats: { value: [
      { fourcc: 'NV12', width: 1280, height: 720, rates: [30] },
      { fourcc: 'NV12', width: 1920, height: 1080, rates: [30] },
      { fourcc: 'NV12', width: 640, height: 360, rates: [30] },
    ] } } });
  });
  it.each([
    ['a non-nominal 25.5 fps interval', '2/51'],
    ['a rate outside the nominal tolerance', '1000/29969'],
  ])('rejects %s', async (_name, interval) => {
    const timedGraph = graph.replaceAll('4950000/148500000', interval);
    const result = await probeRockchipCsi('/dev/video0', 'rkisp_mainpath', runner(timedGraph), names);
    expect(result).toHaveProperty('reason', expect.stringContaining('nominal frame rate'));
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
