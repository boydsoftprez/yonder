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

  it("welds the level capsfilter to every v4l2h264enc, and to nothing else", () => {
    // Without it the encoder links, reaches PLAYING and dies on the *first
    // frame* — "Failed to process frame", with the driver logging
    // "bcm2835-codec: Failed enabling i/p port, ret -3". It reproduces on a
    // bare videotestsrc, so it is the encoder rather than the camera or the
    // fork, and running with/without/with gives ok, ERROR, ok — the caps
    // decide, not a codec left in a bad state by the previous attempt.
    const a = argv();
    const encoders = a.flatMap((token, i) => (token === "v4l2h264enc" ? [i] : []));
    expect(encoders).toHaveLength(2);
    for (const i of encoders) {
      // The very next thing downstream of the encoder, on both branches.
      expect(a[a.indexOf("!", i) + 1]).toBe("video/x-h264,level=(string)4");
    }
    // x264enc needs nothing of the kind. Copying it across would be the
    // ritual the comment on H264_LEVEL exists to prevent.
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", device: null, hardware: false, codec: "h264",
      detail: "software",
    } });
    expect(soft.join(" ")).not.toContain("level=(string)4");
  });

  it("does not try to set the encoder's node, which the element will not take", () => {
    // v4l2h264enc's `device` is readable only: the plugin binds an element
    // per device when it registers and the property reports which one it got.
    // Setting it draws a GObject CRITICAL and is ignored, so Encoder.device
    // is informational and never reaches the pipeline.
    expect(text()).not.toContain("device=/dev/video11");
    // The camera's device *is* settable on v4l2src, and is still set.
    expect(text()).toContain("device=/dev/v4l/by-path/");
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

  /**
   * **The listener this milestone would otherwise have opened** (R-SEC-13).
   *
   * `srtsink uri=srt://:<port>` binds 0.0.0.0 and leaves `passphrase` at its
   * default of "" — no encryption, no authentication — and the socket belongs
   * to the `gst-launch-1.0` process, not to mediamtx, so nothing in
   * `media/config.ts`'s `authInternalUsers` is in the path at all. Verified on
   * a board: `ss -lun` showed `UNCONN 0 0 0.0.0.0:9998`.
   *
   * R-VID-06 is not built. The refusal is what stands in for it.
   */
  const withSrt = { ...CAMERA, outputs: [{ kind: "srt" as const, port: 9998 }] };

  it("refuses an SRT output, because SRT has no posture on this device yet", () => {
    const refusal = refuse({ ...opts, camera: withSrt });
    expect(refusal).toContain("SRT");
    expect(refusal).toContain("9998");
    // The two things an operator can do about it, rather than a bare refusal.
    expect(refusal).toContain("RTSP");
  });

  it("refuses it before anything about the camera is even looked at", () => {
    // A camera that answered nothing AND carries an SRT output is refused for
    // the listener, not for the capabilities: the operator can plug the camera
    // back in and the listener would still be open.
    expect(refuse({ ...opts, camera: withSrt, capabilities: noCapabilities() }))
      .toContain("SRT");
  });

  it("composes no srtsink at all, and will not be talked into one", () => {
    // The guard above is what stops this being reached. If it is ever removed
    // without SRT being given a credential, this throws rather than quietly
    // opening a listener on every interface — the safe direction to be wrong
    // in, and the one a reviewer can see.
    expect(() => compose({ ...opts, camera: withSrt })).toThrow(/SRT/);
    expect(text()).not.toContain("srtsink");
  });
});
