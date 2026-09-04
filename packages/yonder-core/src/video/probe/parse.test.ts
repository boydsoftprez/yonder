// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFormats, parseControls, parseDevices } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseFormats", () => {
  const formats = parseFormats(fixture("list-formats-ext-globalshutter.txt"));

  it("reads every discrete size under every pixel format", () => {
    // The recorded fixture offers two pixel formats at ten sizes each.
    expect(formats).toHaveLength(20);
    expect(new Set(formats.map((f) => f.fourcc))).toEqual(new Set(["MJPG", "YUYV"]));
    expect(formats.filter((f) => f.fourcc === "MJPG")).toHaveLength(10);
    expect(formats.filter((f) => f.fourcc === "YUYV")).toHaveLength(10);
  });

  it("keeps a size with the format it was listed under", () => {
    // A size line inherits the last `[n]: 'FOURCC'` above it. Getting this
    // wrong attributes MJPG's ninety frames a second to the raw format that
    // manages five, and the picker then offers a mode that does not exist.
    const mjpg = formats.find((f) => f.fourcc === "MJPG" && f.width === 1920 && f.height === 1080);
    expect(mjpg?.rates).toEqual([90, 60, 30, 25, 20, 15, 10, 5]);
    const yuyv = formats.find((f) => f.fourcc === "YUYV" && f.width === 1920 && f.height === 1080);
    expect(yuyv?.rates).toEqual([5]);
  });

  it("keeps rates largest first, so a picker's first entry is the best one", () => {
    for (const f of formats) {
      expect([...f.rates]).toEqual([...f.rates].sort((a, b) => b - a));
    }
  });

  it("converts an interval to a rate, not the other way round", () => {
    // v4l2-ctl prints "Interval: Discrete 0.033s (30.000 fps)". The rate is
    // the parenthesised figure; deriving 1/0.033 gives 30.3 and a picker that
    // offers a rate the camera never named.
    const mjpg = formats.filter((f) => f.fourcc === "MJPG");
    for (const f of mjpg) for (const r of f.rates) expect(Number.isInteger(r)).toBe(true);
    // 1/0.011 is 90.9 and 1/0.017 is 58.8. Neither is a rate this camera named.
    const rates = new Set(mjpg.flatMap((f) => [...f.rates]));
    expect([...rates].sort((a, b) => b - a)).toEqual([90, 60, 30, 25, 20, 15, 10, 5]);
  });

  it("returns an empty list rather than throwing on output it cannot read", () => {
    expect(parseFormats("")).toEqual([]);
    expect(parseFormats("VIDIOC_ENUM_FMT: failed: Inappropriate ioctl for device")).toEqual([]);
  });

  it("returns an empty list for a node that answers a type and no formats", () => {
    // /dev/video1 is the camera's own metadata node. It is not a failure and
    // it is not a camera, and it must not be either one by exception.
    expect(parseFormats(fixture("list-formats-ext-video1.txt"))).toEqual([]);
  });

  /**
   * **A fourcc is four bytes, and several real ones end in a space.**
   * `'Y16 '`, `'Y12 '`, `'Y10 '` are what a thermal or greyscale camera
   * reports. `\w{4}` matched none of them, so the block was skipped whole —
   * and its sizes stayed in `pending` for the next format that parsed to
   * collect, which is how a 160x120 *greyscale* mode reached the operator's
   * picker labelled MJPG, passed the compressed-format filter as flyable, and
   * was accepted by `refuse()` as a size this camera offers. The only report
   * a start then gave was `Internal data stream error`.
   */
  const greyscaleThenMjpeg = [
    "ioctl: VIDIOC_ENUM_FMT",
    "\tType: Video Capture",
    "",
    "\t[0]: 'Y16 ' (16-bit Greyscale)",
    "\t\tSize: Discrete 160x120",
    "\t\t\tInterval: Discrete 0.111s (9.000 fps)",
    "\t[1]: 'MJPG' (Motion-JPEG, compressed)",
    "\t\tSize: Discrete 640x480",
    "\t\t\tInterval: Discrete 0.033s (30.000 fps)",
  ].join("\n");

  it("reads a fourcc with a trailing space, rather than skipping the format", () => {
    expect(parseFormats(greyscaleThenMjpeg)).toEqual([
      { fourcc: "Y16 ", width: 160, height: 120, rates: [9] },
      { fourcc: "MJPG", width: 640, height: 480, rates: [30] },
    ]);
  });

  it("never lends one format's sizes to the next one", () => {
    // The same input with a fourcc nothing could read: its sizes belong to no
    // format and are dropped, rather than arriving under the format below.
    const unreadable = greyscaleThenMjpeg.replace("'Y16 '", "'ABC'");
    expect(parseFormats(unreadable)).toEqual([
      { fourcc: "MJPG", width: 640, height: 480, rates: [30] },
    ]);
  });

  it("returns an empty list for formats listed with no size beneath them", () => {
    // The HEVC decoder lists four pixel formats and no size under any of them.
    // A format with no size is not a capture mode.
    expect(parseFormats(fixture("list-formats-ext-video19.txt"))).toEqual([]);
  });
});

describe("parseControls", () => {
  const controls = parseControls(fixture("list-ctrls-menus-globalshutter.txt"));

  it("reads every control the camera listed, under both its headings", () => {
    // Eighteen: eleven under User Controls, seven under Camera Controls. The
    // headings and the menu item lines beneath a menu control are not controls.
    expect(controls.size).toBe(18);
    expect([...controls.keys()]).toContain("zoom_absolute");
    expect([...controls.keys()]).toContain("brightness");
    expect(controls.has("User")).toBe(false);
    expect(controls.has("Camera")).toBe(false);
  });

  it("reads a range control's bounds and its current value", () => {
    const b = controls.get("brightness");
    expect(b).toBeDefined();
    expect(b!.min).toBeLessThan(b!.max);
    expect(b!.step).toBeGreaterThan(0);
    expect(b).toEqual({ min: -64, max: 64, step: 1, default: 0, current: 0 });
  });

  it("reads a negative bound as negative", () => {
    // pan_absolute runs to -648000. A digits-only bound regex reads 648000.
    expect(controls.get("pan_absolute")).toEqual({
      min: -648000, max: 648000, step: 3600, default: 0, current: 0,
    });
  });

  it("reads the current value from the device, never the default", () => {
    // R-CTL-10: a control shows what the camera reports, not what was sent.
    // v4l2-ctl prints `value=` for the reading and `default=` for the factory
    // setting, and they differ on any camera anyone has touched. This camera's
    // focus has been moved: it reads 348 against a default of 0.
    for (const range of controls.values()) {
      expect(Number.isFinite(range.current)).toBe(true);
    }
    const focus = controls.get("focus_absolute");
    expect(focus!.current).toBe(348);
    expect(focus!.default).toBe(0);
  });

  it("reads a control that carries no bounds at all", () => {
    // A bool prints only default= and value=. It is a control, not a parse
    // failure, and dropping it would hide a switch the camera offers.
    expect(controls.get("white_balance_automatic")).toEqual({
      min: 0, max: 1, step: 1, default: 1, current: 1,
    });
  });

  it("returns an empty map rather than throwing on unreadable output", () => {
    expect(parseControls("").size).toBe(0);
    expect(parseControls("VIDIOC_QUERYCTRL: failed: Inappropriate ioctl").size).toBe(0);
  });
});

describe("parseDevices", () => {
  const devices = parseDevices(fixture("list-devices.txt"));

  it("groups every node under the card that owns it", () => {
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) {
      expect(d.card).not.toBe("");
      expect(d.nodes.every((n) => n.startsWith("/dev/"))).toBe(true);
    }
  });

  it("reads the five cards this board reports", () => {
    expect(devices.map((d) => d.card)).toEqual([
      "bcm2835-codec-decode",
      "bcm2835-isp",
      "rpi-hevc-dec",
      "Global Shutter Camera: Global S",
      "bcm2835-codec",
    ]);
  });

  it("keeps a card name that contains a colon of its own", () => {
    // "Global Shutter Camera: Global S (usb-…):" — only the bus in the final
    // parentheses is the suffix. Cutting at the first colon loses the name.
    const camera = devices.find((d) => d.card.startsWith("Global"));
    expect(camera!.card).toBe("Global Shutter Camera: Global S");
    expect(camera!.nodes).toEqual(["/dev/video0", "/dev/video1", "/dev/media4"]);
  });

  it("keeps a card whose only node is a media node", () => {
    // bcm2835-codec owns /dev/media3 and nothing else. A card dropped here is
    // a card that can never be reported as rejected either (R-CAM-12).
    expect(devices.at(-1)).toEqual({ card: "bcm2835-codec", nodes: ["/dev/media3"] });
  });

  it("returns an empty list rather than throwing on unreadable output", () => {
    expect(parseDevices("")).toEqual([]);
  });
});
