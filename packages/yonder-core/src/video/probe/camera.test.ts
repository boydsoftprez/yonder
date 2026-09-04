// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCameras, isHardwareCodec, probeCamera, type ProbeOptions } from "./camera.js";
import type { ByPathEntry } from "./bypath.js";
import type { CommandRunner } from "../../net/runner.js";

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
    for (const key of ["zoom", "focus", "exposure", "whiteBalance", "brightness", "contrast"] as const) {
      expect(caps[key].state).toBe("present");
    }
    expect(caps.focus).toEqual({
      state: "present",
      // The fixture's focus_absolute line carries flags=inactive, has-min-max
      // — still a reading, not a fault (R-UI-21).
      value: { min: 0, max: 1023, step: 1, default: 0, current: 348, inactive: true },
    });
    // M5 fills these; M4 answers them honestly rather than guessing from the
    // pan_absolute and tilt_absolute this camera happens to list.
    expect(caps.aim.state).toBe("not-offered");
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

  it("fills rotation from `rotate`, with the device's reading, when it is implemented", async () => {
    const withRotate = `${fixture("list-ctrls-menus-globalshutter.txt")}
                         rotate 0x00980922 (int)    : min=0 max=270 step=90 default=0 value=90 flags=has-min-max`;
    const r = await bench({ runner: benchRunner({ "--list-ctrls-menus": withRotate }) });
    expect(r.found[0].capabilities.rotation).toEqual({
      state: "present",
      value: { min: 0, max: 270, step: 90, default: 0, current: 90, inactive: false },
    });
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
