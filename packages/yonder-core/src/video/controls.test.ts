// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyControls, CONTROL_NAMES } from "./controls.js";
import { advertised, notOffered, present, type CameraCapabilities } from "./capability.js";
import { CONTROL_MAP } from "./probe/camera.js";
import type { CommandRunner } from "../net/runner.js";

const NODE = "/dev/video0";

/**
 * The bench camera's own answer, straight off the committed fixture
 * (`probe/fixtures/list-ctrls-menus-globalshutter.txt`): brightness
 * min=-64 max=64, contrast min=0 max=95, and no `rotate` line at all.
 */
const BENCH_CAPS: CameraCapabilities = {
  formats: notOffered(), zoom: notOffered(), focus: notOffered(), exposure: notOffered(),
  whiteBalance: notOffered(),
  brightness: present({ min: -64, max: 64, step: 1, default: 0, current: 0, inactive: false }),
  contrast: present({ min: 0, max: 95, step: 1, default: 0, current: 0, inactive: false }),
  rotation: notOffered(),
  aim: notOffered(), recording: notOffered(), stills: notOffered(),
  // Not part of this bench fixture (or of `CONTROL_MAP`, still): the ten
  // controls video/capability.ts modelled without yet teaching the probe or
  // the write path their V4L2 names.
  saturation: notOffered(), hue: notOffered(), autoWhiteBalance: notOffered(),
  gamma: notOffered(), gain: notOffered(), powerLineFrequency: notOffered(),
  sharpness: notOffered(), backlightCompensation: notOffered(),
  autoExposure: notOffered(), autoFocus: notOffered(),
};

/**
 * A fake device that actually holds state: `--set-ctrl` updates `store`,
 * `--get-ctrl` reads it back. Used where a test cares that the read-back is
 * real rather than an echo of what was sent.
 */
function fakeDevice(store: Record<string, number>): CommandRunner {
  return async (argv) => {
    const joined = argv.join(" ");
    const set = /--set-ctrl=([a-z_]+)=(-?\d+)/.exec(joined);
    if (set) store[set[1]] = Number(set[2]);
    const get = /--get-ctrl=([a-z_]+)/.exec(joined);
    if (get) return { code: 0, stdout: `${get[1]}: ${store[get[1]] ?? 0}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected argv: ${joined}` };
  };
}

describe("CONTROL_NAMES", () => {
  it("agrees with the probe's own mapping, so a control is never probed under one name and set under another", () => {
    const probed = Object.fromEntries(CONTROL_MAP) as Record<string, string>;
    for (const [capabilityKey, v4l2Name] of Object.entries(CONTROL_NAMES)) {
      expect(probed[v4l2Name], `${capabilityKey} -> ${v4l2Name}`).toBe(capabilityKey);
    }
  });
});

describe("applyControls", () => {
  it("clamps to the range the device reported, never the schema's bound, and says so", async () => {
    // R-CTL-04. The schema allows brightness -100..100 because it must accept
    // every camera; this bench camera reports -64..64, and sending 100 is a
    // command it will not hold.
    const store = { brightness: 0 };
    const result = await applyControls({
      node: NODE,
      controls: { brightness: 100 },
      capabilities: BENCH_CAPS,
      runner: fakeDevice(store),
    });
    expect(result.applied).toEqual({ brightness: 64 });
    expect(result.clamped).toEqual([{ control: "brightness", requested: 100, sent: 64 }]);
    expect(result.refused).toEqual([]);
  });

  it("clamps below the minimum exactly as it clamps above the maximum", async () => {
    const store = { contrast: 0 };
    const result = await applyControls({
      node: NODE,
      controls: { contrast: -50 },
      capabilities: BENCH_CAPS,
      runner: fakeDevice(store),
    });
    expect(result.applied).toEqual({ contrast: 0 });
    expect(result.clamped).toEqual([{ control: "contrast", requested: -50, sent: 0 }]);
  });

  it("does not clamp a value already inside the device's range", async () => {
    const store = { brightness: 0 };
    const result = await applyControls({
      node: NODE,
      controls: { brightness: 20 },
      capabilities: BENCH_CAPS,
      runner: fakeDevice(store),
    });
    expect(result.applied).toEqual({ brightness: 20 });
    expect(result.clamped).toEqual([]);
  });

  it("refuses a control the device does not offer, with a reason, and never attempts it", async () => {
    // Rule 2: `capabilities.rotation.state === "not-offered"` is the answer
    // already, so this must not run v4l2-ctl to find out.
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await applyControls({
      node: NODE,
      controls: { rotation: 90 },
      capabilities: BENCH_CAPS,
      runner,
    });
    expect(result.refused).toEqual([
      { control: "rotation", reason: expect.stringContaining("not") as unknown as string },
    ]);
    expect(result.applied).toEqual({});
    expect(calls).toEqual([]);
  });

  it("refuses rotation specifically when the device does not offer it (R-CTL-05)", async () => {
    // Rotation is not a V4L2 given: many UVC cameras do not implement it, and
    // this must read as an ordinary refusal rather than a special case that
    // falls back to rotating in the pipeline.
    const result = await applyControls({
      node: NODE,
      controls: { rotation: 180 },
      capabilities: BENCH_CAPS,
      runner: fakeDevice({}),
    });
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].control).toBe("rotation");
    expect(result.applied.rotation).toBeUndefined();
  });

  it("applies rotation like any other control once the device actually offers it", async () => {
    const store = { rotate: 0 };
    const caps: CameraCapabilities = {
      ...BENCH_CAPS,
      rotation: present({ min: 0, max: 270, step: 90, default: 0, current: 0, inactive: false }),
    };
    const result = await applyControls({
      node: NODE,
      controls: { rotation: 90 },
      capabilities: caps,
      runner: fakeDevice(store),
    });
    expect(result.applied).toEqual({ rotation: 90 });
    expect(result.refused).toEqual([]);
  });

  it("refuses a control the device advertises but does not honour, with the capability's own reason", async () => {
    const caps: CameraCapabilities = {
      ...BENCH_CAPS,
      brightness: advertised("acknowledged at every value tried; the sensor never changed"),
    };
    const result = await applyControls({
      node: NODE,
      controls: { brightness: 10 },
      capabilities: caps,
      runner: fakeDevice({}),
    });
    expect(result.refused).toEqual([
      { control: "brightness", reason: "acknowledged at every value tried; the sensor never changed" },
    ]);
  });

  it("turns a non-zero exit from the runner into a refusal rather than throwing", async () => {
    // Rule 3, and the same rule as probe/: a non-zero exit is a result.
    const runner: CommandRunner = async () => (
      { code: 1, stdout: "", stderr: "VIDIOC_S_CTRL: failed: Invalid argument" }
    );
    await expect(applyControls({
      node: NODE,
      controls: { brightness: 10 },
      capabilities: BENCH_CAPS,
      runner,
    })).resolves.toEqual({
      applied: {},
      refused: [{ control: "brightness", reason: expect.stringContaining("Invalid argument") as unknown as string }],
      clamped: [],
    });
  });

  it("reads back what the device now says, not what was sent, when the two differ", async () => {
    // R-CTL-10: the reading must be real. Here the device is given a value
    // inside its own range and simply chooses to hold a different one — the
    // read-back must surface that rather than echoing the command.
    const runner: CommandRunner = async (argv) => {
      const joined = argv.join(" ");
      // Set and get run in one invocation (see controls.ts), so a device
      // that snaps an accepted value to its own grid answers both in the
      // same reply: the write succeeds, and the read-back names the grid
      // value rather than the 30 that was sent.
      if (joined.includes("--set-ctrl=contrast=30") && joined.includes("--get-ctrl=contrast")) {
        return { code: 0, stdout: "contrast: 28\n", stderr: "" };
      }
      throw new Error(`unexpected argv: ${joined}`);
    };
    const result = await applyControls({
      node: NODE,
      controls: { contrast: 30 },
      capabilities: BENCH_CAPS,
      runner,
    });
    expect(result.applied).toEqual({ contrast: 28 });
    // 30 was inside range: the discrepancy is the device's own doing, not a
    // clamp this code applied.
    expect(result.clamped).toEqual([]);
  });

  it("refuses when the device accepts the write but answers nothing readable", async () => {
    const runner: CommandRunner = async (argv) => {
      if (argv.join(" ").includes("--set-ctrl")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "not a number\n", stderr: "" };
    };
    const result = await applyControls({
      node: NODE,
      controls: { brightness: 10 },
      capabilities: BENCH_CAPS,
      runner,
    });
    expect(result.applied).toEqual({});
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].control).toBe("brightness");
  });

  it("treats every requested control independently: one applied, one refused, in the same call", async () => {
    const store = { brightness: 0 };
    const result = await applyControls({
      node: NODE,
      controls: { brightness: 10, rotation: 90 },
      capabilities: BENCH_CAPS,
      runner: fakeDevice(store),
    });
    expect(result.applied).toEqual({ brightness: 10 });
    expect(result.refused).toEqual([{ control: "rotation", reason: expect.stringContaining("not") as unknown as string }]);
  });

  it("sends v4l2-ctl the node, the control name from CONTROL_NAMES, and the clamped value", async () => {
    const seen: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "brightness: 64\n", stderr: "" };
    };
    await applyControls({
      node: NODE,
      controls: { brightness: 999 },
      capabilities: BENCH_CAPS,
      runner,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("-d");
    expect(seen[0]).toContain(NODE);
    expect(seen[0].some((a) => a === "--set-ctrl=brightness=64")).toBe(true);
    expect(seen[0].some((a) => a === "--get-ctrl=brightness")).toBe(true);
  });

  it("does nothing and asks nothing when no control is requested", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
    const result = await applyControls({ node: NODE, controls: {}, capabilities: BENCH_CAPS, runner });
    expect(result).toEqual({ applied: {}, refused: [], clamped: [] });
    expect(calls).toEqual([]);
  });
});
