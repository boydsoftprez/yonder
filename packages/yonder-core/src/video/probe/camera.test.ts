// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCameras, gateIfInactive, isHardwareCodec, probeCamera, type ProbeOptions } from "./camera.js";
import type { ByPathEntry } from "./bypath.js";
import type { CommandRunner } from "../../net/runner.js";
import type { CameraCapabilities, ControlRange } from "../capability.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

/** A runner that answers from the recorded fixtures and executes nothing. */
function benchRunner(overrides: Record<string, string> = {}): CommandRunner {
  // Matched on the argument after `-d`, not on a substring of the whole line:
  // "/dev/video1" is a prefix of ten other nodes this board carries, and the
  // camera's metadata node would otherwise answer for the HEVC decoder.
  const formats: Record<string, string> = {
    "/dev/video0": "list-formats-ext-globalshutter.txt",
    "/dev/video1": "list-formats-ext-video1.txt",
    "/dev/video19": "list-formats-ext-video19.txt",
  };
  return async (argv) => {
    const key = argv.join(" ");
    for (const [match, stdout] of Object.entries(overrides)) {
      if (key.includes(match)) return { code: 0, stdout, stderr: "" };
    }
    if (key.includes("--list-devices")) {
      return { code: 0, stdout: fixture("list-devices.txt"), stderr: "" };
    }
    const device = argv[argv.indexOf("-d") + 1] ?? "";
    if (key.includes("--list-formats-ext") && formats[device]) {
      return { code: 0, stdout: fixture(formats[device]), stderr: "" };
    }
    if (key.includes("--list-ctrls-menus") && device === "/dev/video0") {
      return { code: 0, stdout: fixture("list-ctrls-menus-globalshutter.txt"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "no such device" };
  };
}

/** The recorded `ls -l /dev/v4l/by-path/`, as the reader would return it. */
function recordedByPath(): ByPathEntry[] {
  return fixture("by-path.txt")
    .split("\n")
    .flatMap((line) => {
      const m = /(\S+) -> (\S+)\s*$/.exec(line);
      return m ? [{ name: m[1], target: m[2] }] : [];
    });
}

/**
 * Detection answering only from the recorded fixtures.
 *
 * **Both seams are supplied here, always.** Leaving `byPath` unset would let
 * `systemByPath()` read the host's real /dev/v4l/by-path, so a test would pass
 * or fail according to what is plugged into the machine running it.
 */
const bench = (opts: ProbeOptions = {}) =>
  detectCameras({ runner: benchRunner(), byPath: recordedByPath, ...opts });

/**
 * One camera's capabilities, probed from an arbitrary `--list-ctrls-menus`
 * dump — `benchRunner`'s own `overrides` seam, the way the rotation test
 * below already substitutes one, rather than a second runner built to do
 * the same thing a second way.
 */
const capabilitiesFrom = async (listCtrls: string): Promise<CameraCapabilities> => {
  const r = await bench({ runner: benchRunner({ "--list-ctrls-menus": listCtrls }) });
  return r.found[0].capabilities;
};

describe("detectCameras", () => {
  it("finds the camera and reports what it can do", async () => {
    const r = await bench();
    expect(r.found).toHaveLength(1);
    expect(r.found[0].device).toBe("/dev/video0");
    expect(r.found[0].card).toBe("Global Shutter Camera: Global S");
    expect(r.found[0].capabilities.formats.state).toBe("present");
  });

  it("offers only the compressed modes, and every size the camera named", async () => {
    // R-CAM-02. The camera lists MJPG and YUYV at ten sizes each; only the
    // ten MJPG modes are flyable, and a page that offered the other ten would
    // be offering five frames a second as a video link.
    const r = await bench();
    const formats = r.found[0].capabilities.formats;
    expect(formats.state).toBe("present");
    if (formats.state !== "present") return;
    expect(formats.value).toHaveLength(10);
    expect(new Set(formats.value.map((f) => f.fourcc))).toEqual(new Set(["MJPG"]));
    expect(formats.value[0]).toEqual({
      fourcc: "MJPG", width: 1920, height: 1080, rates: [90, 60, 30, 25, 20, 15, 10, 5],
    });
  });

  it("fills a capability from the control that answers it, with the device's reading", async () => {
    // R-CTL-04 and R-CTL-10: focus_absolute fills `focus`, and it carries what
    // the camera says now — 348 — not the factory default of 0.
    const r = await bench();
    const caps = r.found[0].capabilities;
    for (const key of ["zoom", "brightness", "contrast"] as const) {
      expect(caps[key].state).toBe("present");
    }
    // `focus_absolute` carries `flags=inactive` on this camera: real and in
    // range, gated by `focus_automatic_continuous` (`autoFocus`), not absent
    // and not a fault (R-UI-21). `exposure` and `whiteBalance` are gated the
    // same way — exhaustively covered by "the bench camera's controls" below.
    expect(caps.focus).toEqual({
      state: "gated",
      by: { id: "autoFocus", label: "auto focus" },
      // The fixture's focus_absolute line carries flags=inactive, has-min-max
      // — still a reading, not a fault (R-UI-21).
      value: { min: 0, max: 1023, step: 1, default: 0, current: 348, inactive: true },
    });
    // R-CAM-14: pan_absolute and tilt_absolute, full range, no motor behind
    // either — advertised, not a guess dressed up as `present`. `recording`
    // and `stills` are M5's to fill; M4 answers them honestly rather than
    // guessing.
    expect(caps.aim.state).toBe("advertised");
    expect(caps.recording.state).toBe("not-offered");
    expect(caps.stills.state).toBe("not-offered");
  });

  /**
   * R-CTL-05: `rotate` is a standard V4L2 control, but this bench camera's
   * own `--list-ctrls-menus` output carries no such line — many UVC cameras
   * do not implement it. Absence must read as `not-offered`, never as a
   * silent fallback to rotating in the pipeline (video/controls.ts).
   */
  it("reports rotation not-offered on a camera that does not implement it", async () => {
    const r = await bench();
    expect(r.found[0].capabilities.rotation.state).toBe("not-offered");
  });

  /**
   * The same camera, the same session, `auto_exposure` switched to Manual
   * Mode and switched back — recorded rather than edited. Two lines differ
   * that matter: `auto_exposure` reads 1, and `exposure_time_absolute` has
   * lost `flags=inactive`. (`focus_absolute`'s value moved too; that is a
   * live autofocus reading, not a gate.)
   *
   * **This is the state the other fixture cannot express.** In it all three
   * gate-eligible controls are permanently inactive, so *the device says this
   * control is inactive* and *this control has a gate configured* are
   * perfectly correlated, and no test drawn from it alone can tell the two
   * apart — which is how `gateIfInactive` shipped with that branch uncovered.
   * `gateIfInactive`'s own unit tests build the state by hand and remain the
   * precise guard; this one proves the whole path agrees with a real camera.
   */
  it("leaves the shutter live when the camera is actually in Manual Mode", async () => {
    const r = await bench({ runner: benchRunner({
      "--list-ctrls-menus": fixture("list-ctrls-menus-globalshutter-manual.txt"),
    }) });
    const caps = r.found[0].capabilities;
    expect(caps.exposure.state).toBe("present");
    // The other two are still held, so this is not the whole gate switched off.
    expect(caps.whiteBalance.state).toBe("gated");
    expect(caps.focus.state).toBe("gated");
  });

  it("fills rotation from `rotate`, with the device's reading, when it is implemented", async () => {
    const withRotate = `${fixture("list-ctrls-menus-globalshutter.txt")}
                         rotate 0x00980922 (int)    : min=0 max=270 step=90 default=0 value=90 flags=has-min-max`;
    const r = await bench({ runner: benchRunner({ "--list-ctrls-menus": withRotate }) });
    expect(r.found[0].capabilities.rotation).toEqual({
      state: "present",
      value: { min: 0, max: 270, step: 90, default: 0, current: 90, inactive: false },
    });
  });

  /**
   * R-CTL-05. A mirror and a flip are each their own switch, never a
   * rotation: 180° is both flips together, and neither flip alone is any
   * rotation at all. `horizontal_flip` and `vertical_flip` are V4L2's own
   * names for them (`V4L2_CID_HFLIP` 0x00980914 and `V4L2_CID_VFLIP`
   * 0x00980915), so a camera that implements either fills its capability the
   * same way `rotate` fills `rotation`.
   */
  it("carries a mirror and a flip the device answers", async () => {
    const withFlips = `${fixture("list-ctrls-menus-globalshutter.txt")}
                horizontal_flip 0x00980914 (bool)   : default=0 value=1
                  vertical_flip 0x00980915 (bool)   : default=0 value=0`;
    const r = await bench({ runner: benchRunner({ "--list-ctrls-menus": withFlips }) });
    expect(r.found[0].capabilities.horizontalFlip.state).toBe("present");
    expect(r.found[0].capabilities.verticalFlip.state).toBe("present");
    // The two are separate answers, not one switch read twice: the device
    // says the mirror is on and the flip is off, and a probe that read either
    // name for both keys would report the same reading twice.
    if (r.found[0].capabilities.horizontalFlip.state !== "present") throw new Error("narrowing");
    if (r.found[0].capabilities.verticalFlip.state !== "present") throw new Error("narrowing");
    expect(r.found[0].capabilities.horizontalFlip.value.current).toBe(1);
    expect(r.found[0].capabilities.verticalFlip.value.current).toBe(0);
  });

  it("says this camera has neither, because it does not", async () => {
    // The bench ELP answers no flip control of any kind — that is the recorded
    // fixture, not an assumption, and it is why Task 44 exists.
    const r = await bench();
    expect(r.found[0].capabilities.horizontalFlip.state).toBe("not-offered");
    expect(r.found[0].capabilities.verticalFlip.state).toBe("not-offered");
  });

  it("rejects the board's own JPEG decoder, with the reason", async () => {
    // K-40: /dev/video10 advertises MJPEG, cannot be started, and looks like a
    // camera to everything that asks. An operator who is not told why it
    // vanished will go looking for it.
    const r = await bench();
    const decoder = r.rejected.find((x) => x.device.includes("video10"));
    expect(decoder).toBeDefined();
    expect(decoder!.reason).toContain("hardware codec");
  });

  it("rejects the board's HEVC decoder by its card, not by its formats", async () => {
    // rpi-hevc-dec matches neither "codec" nor "decoder" nor "isp". Before the
    // pattern was widened it reached format probing and was rejected for
    // offering only raw frames — a true sentence that sends an operator
    // looking for a camera setting on a hardware decoder.
    const r = await bench();
    const hevc = r.rejected.find((x) => x.card.includes("hevc"));
    expect(hevc).toBeDefined();
    expect(hevc!.reason).toContain("hardware codec");
    expect(hevc!.reason).not.toContain("raw frames");
  });

  it("rejects the board's ISP by its card, and says which it is", async () => {
    // `bcm2835-isp` is a codec block. Left to reach format probing it is
    // rejected too, and for a more confusing reason — this asserts the reason
    // an operator actually reads, which is the half R-CAM-12 is about. `isp`
    // was one of the two alternatives no test exercised.
    const r = await bench();
    const isp = r.rejected.find((x) => x.card === "bcm2835-isp");
    expect(isp).toBeDefined();
    expect(isp!.reason).toContain("hardware codec");
    // Not "could not read this device's formats", which is what it falls to
    // when the card test misses it — true, and about the wrong thing.
    expect(isp!.reason).not.toContain("could not read");
  });

  it("reports one row per card, so a camera's metadata node is not a rejection", async () => {
    // A UVC camera owns two nodes and the second answers no formats. A
    // rejection sitting beside the camera that was just found reads as
    // "something went wrong with your camera" when nothing did.
    const r = await bench();
    const cameraCard = r.found[0].card;
    expect(r.rejected.some((x) => x.card === cameraCard)).toBe(false);
    // Five cards, sixteen nodes, one camera: five rows, never sixteen.
    expect(r.found.length + r.rejected.length).toBe(5);
  });

  it("rejects a camera that offers no compressed format", async () => {
    // R-CAM-02 is compressed sources. A raw-only camera at a rate too slow to
    // fly is a rejection with a reason, not an empty page.
    const rawOnly = [
      "ioctl: VIDIOC_ENUM_FMT",
      "\t[0]: 'YUYV' (YUYV 4:2:2)",
      "\t\tSize: Discrete 640x480",
      "\t\t\tInterval: Discrete 0.200s (5.000 fps)",
    ].join("\n");
    const r = await bench({ runner: benchRunner({ "--list-formats-ext": rawOnly }) });
    expect(r.found).toHaveLength(0);
    const raw = r.rejected.find((x) => x.reason.includes("compressed"));
    expect(raw).toBeDefined();
    // The reason names what it did offer, so an operator can tell a raw camera
    // from one that answered nothing at all.
    expect(raw!.reason).toContain("YUYV");
  });

  it("never throws — a failed probe is a rejection", async () => {
    const dead: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(bench({ runner: dead })).resolves.toMatchObject({ found: [] });
    const r = await bench({ runner: dead });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toContain("boom");
  });

  it("carries the by-path name, so the configured camera survives a reboot", async () => {
    // R-CAM-05. /dev/video0 is whichever camera the kernel probed first this
    // boot; the by-path name is the socket it is plugged into. This is the
    // name the recorded listing holds for this camera, and the one a
    // configuration stores.
    const r = await bench();
    expect(r.found[0].byPath).toBe(
      "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    );
    expect(r.found[0].byPathStable).toBe(true);
    // Not the enumeration number, which is the whole point of the requirement.
    expect(r.found[0].byPath).not.toContain("/dev/video");
  });

  it("says so when it falls back to the enumeration number", async () => {
    // A camera with no entry under /dev/v4l/by-path can still be streamed, but
    // its identity moves on the next boot. Reporting that as an ordinary
    // by-path name — a string that looks just as authoritative — is the silent
    // absence R-UI-20 forbids.
    const r = await bench({ byPath: () => [] });
    expect(r.found[0].byPath).toBe("/dev/video0");
    expect(r.found[0].byPathStable).toBe(false);
  });
});

/**
 * **The card test decides whether a camera exists at all**, so both directions
 * matter and one of them is worse: a codec let through reaches format probing
 * and is rejected there with a true sentence, while a camera rejected here is
 * invisible and the operator is told, falsely, that it is a hardware codec —
 * which sends them looking in the wrong place entirely (R-CAM-12's "and why").
 */
describe("telling a codec block from a camera by its card (K-40)", () => {
  it("knows the board's own codec blocks", () => {
    // The first four are recorded from this board's `v4l2-ctl --list-devices`
    // and sit in the fixture beside this file; the rest are the same shape —
    // a driver name one of whose words is the function it performs.
    for (const card of [
      "bcm2835-codec-decode", "bcm2835-isp", "rpi-hevc-dec", "bcm2835-codec",
      "bcm2835-codec-encode", "rpi-video-decoder", "some-encoder", "unicam-isp",
    ]) {
      expect(isHardwareCodec(card), card).toBe(true);
    }
  });

  it("accepts a camera whose name merely contains those letters", () => {
    // Every one of these was rejected *as a codec*, with that reason, by the
    // unanchored substring pattern this replaced. `Display` contains `isp`.
    for (const card of [
      "Studio Display", "LG Display Camera", "Dell Display Camera",
      "USB Camera (H.264 Encoder)", "HD Pro Webcam C920",
      "Global Shutter Camera: Global S",
      // The CSI capture node on Rockchip — the Radxa boards the roadmap names.
      "rkisp1_mainpath", "rkisp1-statistics",
    ]) {
      expect(isHardwareCodec(card), card).toBe(false);
    }
  });

  it("lets a whole camera through the probe, not just the predicate", async () => {
    // The predicate is where the rule lives; this is the rule reaching the
    // page. A card with a space in it is a product name whatever letters it
    // carries, so it goes on to be probed like any other camera.
    for (const card of ["USB Camera (H.264 Encoder)", "Studio Display"]) {
      const out = await probeCamera("/dev/video0", card, {
        runner: benchRunner(), byPath: recordedByPath,
      });
      expect("capabilities" in out, card).toBe(true);
    }
  });
});

describe("probeCamera", () => {
  it("re-probes one camera without listing the board again", async () => {
    const seen: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      seen.push(argv);
      return benchRunner()(argv);
    };
    const out = await probeCamera("/dev/video0", "Global Shutter Camera: Global S", {
      runner, byPath: recordedByPath,
    });
    expect("capabilities" in out).toBe(true);
    expect(seen.some((argv) => argv.includes("--list-devices"))).toBe(false);
  });

  it("returns a rejection rather than throwing when the device has gone", async () => {
    const dead: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "No such file" });
    const out = await probeCamera("/dev/video7", "Some Camera", {
      runner: dead, byPath: recordedByPath,
    });
    expect("capabilities" in out).toBe(false);
    expect((out as { reason: string }).reason).toContain("No such file");
  });
});

const listCtrls = fixture("list-ctrls-menus-globalshutter.txt");

describe("the bench camera's controls", () => {
  // All ten, not a sample of them. Task 5 added the keys defaulting to
  // `not-offered`, which asserts *this camera does not have it* — false for
  // every one of these, and said on a page an operator reads. Any key this
  // task fails to map keeps telling that lie, so the guard has to name each.
  it("fills the ten controls that had no home", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    for (const k of ["gain", "backlightCompensation", "gamma", "sharpness", "saturation",
      "hue", "powerLineFrequency", "autoExposure", "autoWhiteBalance", "autoFocus"]) {
      expect(caps[k].state).toBe("present");
    }
  });
  it("reports the pan and tilt it advertises with no motor behind them", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    expect(caps.aim.state).toBe("advertised");
    if (caps.aim.state !== "advertised") throw new Error("narrowing");
    expect(caps.aim.reason).toMatch(/pan/i);
  });
  it("gates the three controls an automatic mode has charge of, keeping their range", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    for (const k of ["exposure", "whiteBalance", "focus"]) expect(caps[k].state).toBe("gated");
    if (caps.exposure.state !== "gated") throw new Error("narrowing");
    expect(caps.exposure.by.label).toBe("auto exposure"); expect(caps.exposure.value.max).toBe(10000);
  });
  it("keeps only the menu ids the device listed", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    if (caps.autoExposure.state !== "present") throw new Error("narrowing");
    expect(caps.autoExposure.value.menu?.map((m) => m.id)).toEqual([1, 3]);
  });
  // Resolution #3: `by.id` is the gating *capability* key, never the V4L2
  // control name — nothing downstream should ever have to map back to
  // `auto_exposure`. The brief's own test above checks `by.label` for
  // `exposure` alone; this checks `by.id` for all three gated controls, since
  // a label-only check would still pass an implementation that put the raw
  // V4L2 name (or the wrong control's key) in `id`.
  it("names each gate by its own capability key, all three, never the V4L2 name", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    if (caps.exposure.state !== "gated") throw new Error("narrowing");
    if (caps.whiteBalance.state !== "gated") throw new Error("narrowing");
    if (caps.focus.state !== "gated") throw new Error("narrowing");
    expect(caps.exposure.by.id).toBe("autoExposure");
    expect(caps.whiteBalance.by.id).toBe("autoWhiteBalance");
    expect(caps.focus.by.id).toBe("autoFocus");
  });
});

/**
 * **Fix round 1 (coordinator review).** A mutation caught what the tests
 * above did not: drop the `range.inactive` test from `gateIfInactive`'s
 * condition — gating whenever a key merely *has* a gate configured — and
 * every test above, and every test in `controls.test.ts`, stays green. The
 * one recorded fixture cannot tell the two conditions apart: `exposure`,
 * `whiteBalance` and `focus` are the only gate-eligible keys, and all three
 * are permanently `inactive` in it, so "has a gate" and "is inactive" are
 * perfectly correlated in the only device state this repository holds.
 *
 * **This state is built by hand, not read from the fixture, because the
 * fixture cannot supply it** — every gate-eligible control it carries is
 * always inactive. Do not "tidy" this back onto `capabilitiesFrom` or the
 * committed fixture: that fixture is real recorded output and is left
 * untouched deliberately (see its own file). A second capture from the
 * board, taken with `auto_exposure` in Manual Mode, is the better evidence
 * and should replace this hand-built range the next time the bench is
 * reachable — this is a stand-in for that, not a preference for one.
 */
describe("gateIfInactive", () => {
  it("leaves a gate-eligible control present when the device does not report it inactive", () => {
    // A shutter genuinely live and adjustable right now: the same shape as
    // the fixture's own exposure_time_absolute line, but with `inactive:
    // false` — the state auto_exposure in Manual Mode would produce, and the
    // one condition the committed fixture never exercises.
    const liveShutter: ControlRange = {
      min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: false,
    };
    expect(gateIfInactive(liveShutter, "exposure")).toEqual({ state: "present", value: liveShutter });
  });

  it("still gates the same control once the device reports it inactive", () => {
    // The direction the fixture-derived tests above already prove, repeated
    // here at the unit level so both branches of the same condition are
    // exercised beside each other rather than one living only in the
    // fixture-derived suite and the other only here.
    const heldShutter: ControlRange = {
      min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true,
    };
    expect(gateIfInactive(heldShutter, "exposure")).toEqual({
      state: "gated",
      by: { id: "autoExposure", label: "auto exposure" },
      value: heldShutter,
    });
  });
});
