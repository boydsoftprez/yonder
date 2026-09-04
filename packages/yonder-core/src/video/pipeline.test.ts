// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { compose, refuse, QUEUE } from "./pipeline.js";
import { present, noCapabilities } from "./capability.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: { width: 640, height: 360, framerate: 15, bitrate_kbps: 400 },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [
    { kind: "rtp", host: "192.168.1.50", port: 5600 },
    { kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } },
  ],
};
const CAPS = {
  ...noCapabilities(),
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
};
const HW = {
  element: "v4l2h264enc" as const, device: "/dev/video11", hardware: true,
  codec: "h264" as const, detail: "hardware H.264 on /dev/video11",
};
const opts = { camera: CAMERA, capabilities: CAPS, encoder: HW, rtspBase: "rtsp://127.0.0.1:8554" };
const argv = () => compose(opts);
const text = () => argv().join(" ");

describe("compose", () => {
  it("captures the format the camera actually offered", () => {
    expect(text()).toContain("v4l2src");
    expect(text()).toContain("image/jpeg,width=1280,height=720,framerate=30/1");
  });

  it("decodes once and forks before the encoder", () => {
    // Spec section 4: the expensive frames are already decoded, and the
    // preview is a second encode from those frames. One jpegdec, two encodes.
    expect(text().match(/jpegdec/g)).toHaveLength(1);
    expect(text().match(/v4l2h264enc/g)).toHaveLength(2);
    expect(text()).toContain("tee name=raw");
    expect(text()).toContain("tee name=main");
  });

  it("scales the preview with the board's own resizer, not in software", () => {
    // That hardware sits idle once the ISP converter is out of the main path.
    expect(text()).toContain("v4l2convert");
    expect(text()).toContain("width=640,height=360");
    expect(text()).not.toContain("videoscale");
  });

  it("runs a short keyframe interval on the preview branch only", () => {
    // R-VID-09 on the path where a person is watching a grey rectangle. The
    // ground-station branch keeps a long GOP; asking the media server to
    // demand a keyframe would need a control channel M4 does not have.
    expect(text()).toContain("h264_i_frame_period=15");
    expect(text().match(/h264_i_frame_period/g)).toHaveLength(1);
    // ...and it is on the preview's encode, not the full-rate one: the short
    // GOP appears after the branch that carries v4l2convert.
    const previewBranch = text().slice(text().indexOf("v4l2convert"));
    expect(previewBranch).toContain("h264_i_frame_period=15");
  });

  it("bounds every branch off both tees, and drops rather than blocks", () => {
    // A bare queue blocks when it fills, applies back-pressure through the
    // tee, stalls the shared encoder, and takes every other branch down with
    // it — including the one the operator is watching.
    const branches = argv().filter((a) => a === "queue");
    expect(branches.length).toBeGreaterThanOrEqual(3);
    for (const token of QUEUE.slice(1)) {
      expect(argv().filter((a) => a === token).length).toBe(branches.length);
    }
    expect(QUEUE).toContain("leaky=downstream");
    expect(QUEUE).toContain("max-size-time=200000000");
    expect(QUEUE).toContain("max-size-buffers=0");
    expect(QUEUE).toContain("max-size-bytes=0");
  });

  it("pushes RTP to the configured ground station", () => {
    expect(text()).toContain("rtph264pay");
    expect(text()).toContain("host=192.168.1.50");
    expect(text()).toContain("port=5600");
  });

  it("publishes the full-rate stream and the preview under separate paths", () => {
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0");
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0-preview");
  });

  it("carries a fixed bitrate, in bits, on both encodes (R-VID-08)", () => {
    expect(text()).toContain("video_bitrate=2000000");
    expect(text()).toContain("video_bitrate=400000");
  });

  it("uses x264enc where the board has no hardware encoder", () => {
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", device: null, hardware: false, codec: "h264",
      detail: "software",
    } });
    expect(soft.join(" ")).toContain("x264enc");
    expect(soft.join(" ")).toContain("bitrate=2000");   // x264enc counts in kb/s
    expect(soft.join(" ")).not.toContain("video_bitrate");
  });

  it("never shells out — the composition is a value", () => {
    expect(Array.isArray(argv())).toBe(true);
    expect(argv()[0]).toBe("gst-launch-1.0");
  });
});

describe("refuse", () => {
  it("refuses a mode the camera never offered, before anything is pressed", () => {
    // R-CAM-10. The picker is built from what the camera reported, so this is
    // the second line of defence, not the first — but a config file edited by
    // hand does not go through a picker.
    expect(refuse({ ...opts, camera: { ...CAMERA, width: 3840, height: 2160 } }))
      .toContain("3840x2160");
  });

  it("refuses a rate the camera did not offer at that size", () => {
    expect(refuse({ ...opts, camera: { ...CAMERA, framerate: 60 } })).toContain("60");
  });

  it("refuses a preview larger than the capture it is scaled from", () => {
    expect(refuse({ ...opts, camera: {
      ...CAMERA, width: 640, height: 360,
      preview: { width: 1280, height: 720, framerate: 15, bitrate_kbps: 400 },
    } })).toContain("preview");
  });

  it("refuses a device the board does not have, and names what it does", () => {
    // The failure an operator is most likely to hit: `v4l2-ctl --list-devices`
    // prints a bus id that looks like an answer and has no entry under
    // /dev/v4l/by-path/. Configured, it yields `Internal data stream error`
    // and nothing else.
    const refusal = refuse({
      ...opts,
      camera: { ...CAMERA, device: "usb-0000:01:00.0-1.3" },
      knownDevices: new Set([CAMERA.device]),
    });
    expect(refusal).toContain("usb-0000:01:00.0-1.3");
    expect(refusal).toContain(CAMERA.device);
  });

  it("says nothing about the device when nothing has probed for one", () => {
    // A caller that has not probed cannot be held to a list it does not have.
    expect(refuse({ ...opts, camera: { ...CAMERA, device: "usb-0000:01:00.0-1.3" } }))
      .toBeNull();
  });

  it("says nothing about a configuration the board can sustain", () => {
    expect(refuse(opts)).toBeNull();
  });
});
