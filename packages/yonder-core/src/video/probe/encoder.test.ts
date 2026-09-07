// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { probeEncoder } from "./encoder.js";
import type { CommandRunner } from "../../net/runner.js";

const HARDWARE_OUT = [
  "ioctl: VIDIOC_ENUM_FMT",
  "\tType: Video Output Multiplanar",
  "\t[0]: 'YU12' (Planar YUV 4:2:0)",
].join("\n");
const HARDWARE_CAP = [
  "ioctl: VIDIOC_ENUM_FMT",
  "\tType: Video Capture Multiplanar",
  "\t[0]: 'H264' (H.264, compressed)",
].join("\n");

function runner(
  nodes: Record<string, { out: string; cap: string }>,
  registered: readonly string[] = [],
): CommandRunner {
  return async (argv) => {
    const key = argv.join(" ");
    if (argv[0] === "gst-inspect-1.0" && argv[1] === "--exists") {
      const ok = registered.includes(argv[2]);
      return { code: ok ? 0 : 1, stdout: "", stderr: "" };
    }
    for (const [node, answer] of Object.entries(nodes)) {
      if (!key.includes(node)) continue;
      if (key.includes("--list-formats-out")) return { code: 0, stdout: answer.out, stderr: "" };
      if (key.includes("--list-formats")) return { code: 0, stdout: answer.cap, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "No such file or directory" };
  };
}

it("finds Rockchip's MPP encoders through the GStreamer registry, both codecs and the decoder (R-HW-03)", async () => {
  const e = await probeEncoder({ runner: runner({}, ["mpph264enc", "mpph265enc", "mppjpegdec"]) });
  expect(e).toEqual({
    element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec",
    device: "/dev/mpp_service", hardware: true,
    detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
  });
});

it("reports H.264 alone when the H.265 element is not registered", async () => {
  const e = await probeEncoder({ runner: runner({}, ["mpph264enc", "mppjpegdec"]) });
  expect(e).toMatchObject({ element: "mpph264enc", h265: null, decoder: "mppjpegdec" });
  expect(e.detail).toBe("hardware H.264 through Rockchip MPP (mpph264enc)");
});

it("asks the registry before sweeping V4L2 nodes, so a Rockchip board never falls through to software", async () => {
  const asked: string[] = [];
  const inner = runner({}, ["mpph264enc"]);
  const e = await probeEncoder({ runner: async (argv) => { asked.push(argv[0]); return inner(argv); } });
  expect(e.element).toBe("mpph264enc");
  expect(asked).not.toContain("v4l2-ctl");
});

it("says it found no hardware encoder, never that the board has none (spec §8)", async () => {
  const e = await probeEncoder({ runner: runner({}) });
  expect(e).toMatchObject({ element: "x264enc", h265: null, decoder: null, hardware: false });
  expect(e.detail).toContain("no hardware encoder found");
  expect(e.detail).not.toContain("offers no");
});

it("lets an operator name the MPP encoder explicitly, bypassing the probe (R-CAM-13)", async () => {
  const e = await probeEncoder({ runner: runner({}), override: "mpph264enc" });
  expect(e).toMatchObject({
    element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec", device: "/dev/mpp_service", hardware: true,
  });
  expect(e.detail).toContain("named by the operator");
});

it("finds the board's hardware H.264 encoder and names the node", async () => {
  const e = await probeEncoder({
    runner: runner({ "/dev/video11": { out: HARDWARE_OUT, cap: HARDWARE_CAP } }),
  });
  expect(e).toMatchObject({ element: "v4l2h264enc", device: "/dev/video11", hardware: true });
});

it("falls back to software where the board has no encoder (R-HW-02)", async () => {
  const e = await probeEncoder({ runner: runner({}) });
  expect(e).toMatchObject({ element: "x264enc", device: null, hardware: false, h265: null, decoder: null });
  expect(e.detail).toContain("software");
});

it("never mistakes the decoder for an encoder", async () => {
  // K-40: /dev/video10 takes JPEG in and gives raw out. An encoder takes raw
  // in and gives H.264 out. The direction is the whole test, and a probe that
  // only looked for "a node that mentions H264" would pick a decoder that
  // cannot be started.
  const decoder = {
    out: "\tType: Video Output Multiplanar\n\t[0]: 'JPEG' (JFIF JPEG, compressed)",
    cap: "\tType: Video Capture Multiplanar\n\t[0]: 'YU12' (Planar YUV 4:2:0)",
  };
  const e = await probeEncoder({ runner: runner({ "/dev/video10": decoder }) });
  expect(e.hardware).toBe(false);
});

it("lets an operator name one explicitly, bypassing the probe (R-CAM-13)", async () => {
  const e = await probeEncoder({ runner: runner({}), override: "v4l2h264enc:/dev/video11" });
  expect(e).toMatchObject({ element: "v4l2h264enc", device: "/dev/video11", hardware: true });
  expect(e.detail).toContain("named by the operator");
});

it("never throws when no video node exists at all", async () => {
  const dead: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await expect(probeEncoder({ runner: dead })).resolves.toMatchObject({ hardware: false });
});
