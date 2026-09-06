// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyControls, capabilityKeyFor, CONTROL_NAMES } from "./controls.js";
import {
  advertised, gated, noCapabilities, notOffered, present,
  type CameraCapabilities, type ControlRange,
} from "./capability.js";
import { CONTROL_MAP } from "./probe/camera.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";

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
  // The real bench camera answers all ten of these too (both the probe and
  // this file's own write path know their V4L2 names now), but this hand
  // fixture keeps them `not-offered` because the tests below that use it
  // only ever exercise brightness, contrast and rotation; a test that needs
  // one of these ten present builds its own capabilities object instead of
  // widening this one.
  saturation: notOffered(), hue: notOffered(), autoWhiteBalance: notOffered(),
  gamma: notOffered(), gain: notOffered(), powerLineFrequency: notOffered(),
  sharpness: notOffered(), backlightCompensation: notOffered(),
  autoExposure: notOffered(), autoFocus: notOffered(),
  // The bench camera answers no flip control of any kind either — this pair
  // is the fixture's own answer rather than a convenience, and the flip
  // tests below build their own capabilities exactly as the note above says.
  horizontalFlip: notOffered(), verticalFlip: notOffered(),
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
  // Forward: every entry here must send the same V4L2 name the probe reads
  // for the same capability. `capabilityKeyFor` is the one place `exposureTime`
  // and `whiteBalanceTemperature` are translated to `exposure` and
  // `whiteBalance` — without it this loop would fail on those two entries
  // even though they are correct, since a config key is not always spelled
  // like its capability (Task 8's review; `controls.ts`'s own header
  // comment on `CONTROL_NAMES`).
  it("agrees with the probe's own mapping, so a control is never probed under one name and set under another", () => {
    const probed = Object.fromEntries(CONTROL_MAP) as Record<string, string>;
    for (const [configKey, v4l2Name] of Object.entries(CONTROL_NAMES)) {
      expect(probed[v4l2Name], `${configKey} -> ${v4l2Name}`).toBe(capabilityKeyFor(configKey));
    }
  });

  // Backward (resolution 2): every control the probe reads must have some
  // config field that writes it — the gap this whole task closes. Nothing
  // in the type system enforces this direction: `CONTROL_MAP` is a plain
  // array, not tied to the schema the way `CONTROL_NAMES`'s own `satisfies`
  // clause is, so only a test at this level would ever notice a v4l2 name
  // the probe reads reaching no field at all.
  //
  // Mutation-check (resolution 2): removing an entry from `CONTROL_NAMES`
  // reddens only this test, since the forward test above simply stops
  // checking a key it no longer iterates; removing an entry from
  // `CONTROL_MAP` reddens only the forward test above, since this loop
  // simply stops iterating that pair. Confirmed by hand — see the task
  // report.
  it("covers every control the probe reads, in the other direction too — a control an operator can see but never change is exactly the gap this task closes", () => {
    const written = new Set(Object.values(CONTROL_NAMES));
    for (const [v4l2Name, capabilityKey] of CONTROL_MAP) {
      expect(written.has(v4l2Name), `${capabilityKey} (${v4l2Name}) is probed but CONTROL_NAMES has no field that writes it`).toBe(true);
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
      reprobed: [],
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
    expect(result).toEqual({ applied: {}, refused: [], clamped: [], reprobed: [] });
    expect(calls).toEqual([]);
  });

  // --- The four new refusal reasons and the boolean encoding (R-CTL-11 …
  // R-CTL-14, R-UI-21). Resolution 4: four different sentences to an
  // operator, four separate tests, none sampled.

  /** A plain, ungated, non-menu range — reused wherever a test's fixture only needs "some real range". */
  const range: ControlRange = { min: 0, max: 3, step: 1, default: 0, current: 0, inactive: false };

  /** A boolean control's own range, as `--list-ctrls-menus` reports one with no explicit min/max (parse.ts defaults it to 0..1). */
  const boolRange: ControlRange = { min: 0, max: 1, step: 1, default: 1, current: 1, inactive: false };

  it("sends a switch as 1 or 0, which is what V4L2 takes", async () => {
    const calls: string[][] = [];
    const ok: CommandResult = { code: 0, stdout: "white_balance_automatic: 0\n", stderr: "" };
    const r = await applyControls({
      node: NODE,
      controls: { autoWhiteBalance: false },
      capabilities: { ...noCapabilities(), autoWhiteBalance: present(boolRange) },
      runner: async (argv) => { calls.push(argv); return ok; },
    });
    expect(calls.flat().join(" ")).toContain("white_balance_automatic=0");
    // Mutation-check: a version that skips converting the boolean before
    // `clampToRange` still happens to *send* the right digit — `Math.max`/
    // `Math.min` coerce `false` to `0` as a side effect of the arithmetic —
    // but `0 !== false` under strict inequality, so that version also
    // reports a spurious clamp for a value that was never out of range.
    // Asserting `clamped` is empty is what catches that version; the wire
    // check above alone does not.
    expect(r.clamped).toEqual([]);
  });

  /**
   * R-CTL-05, and rule 7 a second time. A mirror is a switch, not a
   * rotation, so it travels the same `1`/`0` road `autoWhiteBalance` does —
   * `horizontal_flip=true` is a command V4L2 refuses.
   */
  it("sends a mirror as 1 or 0, which is what V4L2 takes", async () => {
    const calls: string[][] = [];
    const ok: CommandResult = { code: 0, stdout: "horizontal_flip: 1\n", stderr: "" };
    const r = await applyControls({
      node: NODE,
      controls: { horizontalFlip: true },
      capabilities: { ...noCapabilities(), horizontalFlip: present(boolRange) },
      runner: async (argv) => { calls.push(argv); return ok; },
    });
    expect(calls.flat().join(" ")).toContain("horizontal_flip=1");
    // Same mutation as the switch test above: a version that reaches
    // `clampToRange` with the raw `true` still sends the right digit, and
    // reports a clamp for a value that was never out of range.
    expect(r.clamped).toEqual([]);
    // And the read-back is kept, so the write really did complete rather
    // than being refused on the way (which would leave `applied` empty and
    // the wire check above still green).
    expect(r.applied).toEqual({ horizontalFlip: 1 });
  });

  it("sends a flip as 1 or 0 too, under its own V4L2 name", async () => {
    // The pair is two controls, not one read twice: a mapping that sent
    // `horizontal_flip` for both would pass the test above on its own.
    const calls: string[][] = [];
    const ok: CommandResult = { code: 0, stdout: "vertical_flip: 0\n", stderr: "" };
    await applyControls({
      node: NODE,
      controls: { verticalFlip: false },
      capabilities: { ...noCapabilities(), verticalFlip: present(boolRange) },
      runner: async (argv) => { calls.push(argv); return ok; },
    });
    const wire = calls.flat().join(" ");
    expect(wire).toContain("vertical_flip=0");
    expect(wire).not.toContain("horizontal_flip");
  });

  // A runner that throws if it is ever called — used below where the whole
  // point is that a refused control never reaches the device (rule 2 and
  // rule 5 in controls.ts). `CommandRunner` never rejects in production
  // (net/runner.ts), but nothing stops a test double from throwing to fail
  // loudly if it is invoked when it should not be.
  const runner: CommandRunner = async (argv) => {
    throw new Error(`applyControls must not run v4l2-ctl for a refused control: ${argv.join(" ")}`);
  };

  it("refuses a gated control naming the setting that has charge", async () => {
    const r = await applyControls({
      node: NODE,
      controls: { exposureTime: 400 },
      capabilities: { ...noCapabilities(), exposure: gated(range, { id: "auto_exposure", label: "auto exposure" }) },
      runner,
    });
    expect(r.refused[0].reason).toContain("auto exposure");
    // Resolution 3: the exact phrasing, not merely that a refusal happened —
    // a mutant that refused for a different reason (or the wrong control)
    // must not pass this test.
    expect(r.refused[0].control).toBe("exposureTime");
    expect(r.applied).toEqual({});
  });

  it("refuses a menu id the device did not list", async () => {
    const caps: CameraCapabilities = {
      ...noCapabilities(),
      autoExposure: present({ ...range, menu: [{ id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" }] }),
    };
    const r = await applyControls({ node: NODE, controls: { autoExposure: 2 }, capabilities: caps, runner });
    expect(r.refused.map((x) => x.control)).toEqual(["autoExposure"]);
    // The reason names the value and reads differently from the other three
    // refusals — a mutant that reused "does not offer" or the gated
    // control's wording for this branch must not pass.
    expect(r.refused[0].reason).toContain("2");
    expect(r.refused[0].reason).not.toContain("does not offer");
    expect(r.applied).toEqual({});
  });

  // --- The re-probe (resolution 6): a gate control, once written, re-reads
  // exactly the keys it gates — not nothing, and not everything.

  /**
   * `autoExposure` present with the bench camera's own menu (Manual /
   * Aperture Priority); `exposure` gated by it, mirroring the bench state
   * before the write this test makes — `auto_exposure` in Aperture Priority,
   * `exposure_time_absolute` inactive, exactly `probe/camera.ts`'s own
   * fixture (`list-ctrls-menus-globalshutter.txt`).
   */
  const capsWithGates: CameraCapabilities = {
    ...noCapabilities(),
    autoExposure: present({
      min: 0, max: 3, step: 1, default: 3, current: 3, inactive: false,
      menu: [{ id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" }],
    }),
    exposure: gated(
      { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true },
      { id: "autoExposure", label: "auto exposure" },
    ),
  };

  /**
   * Answers the write (`auto_exposure=1`) and, separately, a `--list-ctrls-menus`
   * re-probe — the same two-call shape `reprobeGatedControls` makes: the set
   * first, one further read after. `exposure_time_absolute` in this reply
   * carries no `inactive` flag, the way the device would answer the instant
   * Manual Mode releases the shutter.
   */
  const runnerThatAnswersListCtrls: CommandRunner = async (argv) => {
    const joined = argv.join(" ");
    if (joined.includes("--set-ctrl=auto_exposure=1")) {
      return { code: 0, stdout: "auto_exposure: 1\n", stderr: "" };
    }
    if (joined.includes("--list-ctrls-menus")) {
      return {
        code: 0,
        stdout: [
          "                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=1 (Manual Mode)",
          "\t\t\t1: Manual Mode",
          "\t\t\t3: Aperture Priority Mode",
          "         exposure_time_absolute 0x009a0902 (int)    : min=1 max=10000 step=1 default=156 value=156 flags=has-min-max",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected argv: ${joined}` };
  };

  it("re-reads the gated controls after the gate changes", async () => {
    const r = await applyControls({
      node: NODE,
      controls: { autoExposure: 1 },
      capabilities: capsWithGates,
      runner: runnerThatAnswersListCtrls,
    });
    expect(r.reprobed).toContain("exposure");
  });

  it("re-probes only after the gate write itself, never before", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return runnerThatAnswersListCtrls(argv);
    };
    const r = await applyControls({ node: NODE, controls: { autoExposure: 1 }, capabilities: capsWithGates, runner });
    expect(calls).toHaveLength(2);
    expect(calls[0].join(" ")).toContain("--set-ctrl=auto_exposure=1");
    expect(calls[1].join(" ")).toContain("--list-ctrls-menus");
    expect(r.reprobed).toEqual(["exposure"]);
  });

  it("does not re-probe anything when the written control gates nothing", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "brightness: 10\n", stderr: "" };
    };
    const r = await applyControls({ node: NODE, controls: { brightness: 10 }, capabilities: BENCH_CAPS, runner });
    expect(r.reprobed).toEqual([]);
    // Only the write itself — a `--list-ctrls-menus` call here would mean
    // this re-probes every write, not only a gate's.
    expect(calls).toHaveLength(1);
  });

  it("names only the key the written control gates, not every control the re-read happens to answer", async () => {
    // A mutant that treats "everything `--list-ctrls-menus` reports" as
    // reprobed would pass the two tests above (both re-read exactly one
    // control) but must fail here: this reply also answers `whiteBalance`'s
    // and `focus`'s own V4L2 controls, gated by *different* settings
    // (`autoWhiteBalance`, `autoFocus`), neither of which was written.
    const runner: CommandRunner = async (argv) => {
      const joined = argv.join(" ");
      if (joined.includes("--set-ctrl=auto_exposure=1")) return { code: 0, stdout: "auto_exposure: 1\n", stderr: "" };
      if (joined.includes("--list-ctrls-menus")) {
        return {
          code: 0,
          stdout: [
            "                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=1 (Manual Mode)",
            "\t\t\t1: Manual Mode",
            "\t\t\t3: Aperture Priority Mode",
            "         exposure_time_absolute 0x009a0902 (int)    : min=1 max=10000 step=1 default=156 value=156 flags=has-min-max",
            "      white_balance_temperature 0x0098091a (int)    : min=2800 max=6500 step=1 default=4600 value=4600 flags=inactive, has-min-max",
            "                 focus_absolute 0x009a090a (int)    : min=0 max=1023 step=1 default=0 value=348 flags=inactive, has-min-max",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected argv: ${joined}` };
    };
    const r = await applyControls({ node: NODE, controls: { autoExposure: 1 }, capabilities: capsWithGates, runner });
    expect(r.reprobed).toEqual(["exposure"]);
  });
});
