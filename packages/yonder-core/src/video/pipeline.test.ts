// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  compose, encodeControl, encodesIn, encoderFor, previewCaps, refuse, scalesInEncoder,
  ENCODE_ELEMENT, PREVIEW_CAPS_ELEMENT, QUEUE,
} from "./pipeline.js";
import { present, noCapabilities, captureSizes } from "./capability.js";
import type { ControlRange } from "./capability.js";
import type { Camera, CameraOutput } from "../schema/config.js";

// Named so a test can disable one kind and leave the other running, without
// retyping its shape (Task 10: `renders no pipeline for a disabled output`).
const rtpOutput: CameraOutput = { kind: "rtp", enabled: true, host: "192.168.1.50", port: 5600 };
const rtspOutput: CameraOutput = { kind: "rtsp", enabled: true, password: { secret: "rtsp_password" } };

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: {
    mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
    floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
  },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [rtpOutput, rtspOutput],
  stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
};
const CAPS = {
  ...noCapabilities(),
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
};
const HW = {
  element: "v4l2h264enc" as const, h265: null, decoder: null, device: "/dev/video11", hardware: true,
  detail: "hardware H.264 on /dev/video11",
};
const opts = { camera: CAMERA, capabilities: CAPS, encoder: HW, rtspBase: "rtsp://127.0.0.1:8554" };
const argv = () => compose(opts);
const text = () => argv().join(" ");

const MPP = {
  element: "mpph264enc" as const, h265: "mpph265enc" as const, decoder: "mppjpegdec" as const,
  device: "/dev/mpp_service", hardware: true,
  detail: "hardware H.264 and H.265 through Rockchip MPP (mpph264enc, mpph265enc)",
};
const mppOpts = { ...opts, encoder: MPP };
const mpp = () => compose(mppOpts);
const mppText = () => mpp().join(" ");

describe('a main encode with no permanent consumer', () => {
  it.each([
    ['usb', 'empty'], ['usb', 'disabled'], ['usb', 'enabled'],
    ['accessory', 'empty'], ['accessory', 'disabled'], ['accessory', 'enabled'],
  ] as const)('keeps the %s preview independent when outputs are %s and the recorder detaches', (source, outputState) => {
    const outputs = outputState === 'empty' ? [] : [{ ...rtspOutput, enabled: outputState === 'enabled' }];
    const camera = { ...CAMERA, source, outputs, device: source === 'accessory' ? 'pocket2:test.udc' : CAMERA.device };
    const argv = compose({ ...opts, camera, accessory: source === 'accessory'
      ? { endpoint: '/run/yonder/accessory/cam0.sock', live: true, generation: 1, reason: null, native: { width: 1280, height: 720, fps: 29.97 } }
      : undefined });
    // The host observes main's sink pad; it attaches no permanent drain.
    // Its dynamic recorder can release the last request pad at any time.
    expect(argv.join(' ')).toContain('tee name=main allow-not-linked=true');
    expect(argv.filter(token => token === 'main.')).toHaveLength(outputState === 'enabled' ? 1 : 0);
    expect(argv).toContain('name=enc-stream'); expect(argv).toContain('name=enc-preview');
    expect(argv).toContain(`location=${opts.rtspBase}/${camera.id}-preview`);
    expect(argv).not.toContain('fakesink');
  });
});

describe('accessory input', () => {
  const accessory = { endpoint: '/run/yonder/accessory/cam1.sock', live: true, generation: 1, reason: null, native: { width: 1280, height: 720, fps: 29.97 } };
  const input = { ...opts, camera: { ...CAMERA, source: 'accessory' as const, device: 'pocket2:test.udc' }, capabilities: noCapabilities(), accessory };
  it('uses timestamped appsrc and H264 decode before the existing independent encodes', () => {
    expect(refuse(input)).toBeNull(); const line = compose(input).join(' ');
    expect(line).toContain('--accessory-socket=/run/yonder/accessory/cam1.sock');
    expect(line).toContain('appsrc name=accessory-source'); expect(line).toContain('h264parse ! avdec_h264');
    expect(line).toContain('tee name=raw'); expect(line).not.toContain('v4l2src'); expect(line).not.toContain('jpegdec');
    expect(line.match(/v4l2h264enc/g)).toHaveLength(2);
    expect(encodesIn(compose(input)).stream).toBe(2000);
  });
  it('keeps native input separate from selectable camera formats and refuses upscaling', () => {
    expect(input.capabilities.formats.state).toBe('not-offered');
    expect(refuse({ ...input, camera: { ...input.camera, width: 1920 } })).toContain('exceeds native');
    expect(refuse({ ...input, accessory: { ...accessory, native: null } })).toContain('timestamp cadence');
    expect(refuse({ ...input, accessory: { ...accessory, live: false } })).toContain('not live');
  });
});

describe("compose", () => {
  it('composes independent 1080p30 hardware HEVC streams', () => {
    const camera = { ...CAMERA, width: 1920, height: 1080, codec: 'h265' as const,
      preview: { ...CAMERA.preview, codec: 'h265' as const, size: '1920x1080' as const, framerate: 30 } };
    const line = compose({ ...mppOpts, camera });
    expect(line.filter(x => x === 'mpph265enc')).toHaveLength(2);
    const preview = line.slice(line.indexOf('name=enc-preview'));
    expect(preview).toContain('width=1920');
    expect(preview).toContain('height=1080');
    expect(refuse({ ...mppOpts, camera: { ...camera, width: 1280, height: 720 } })).toContain('larger than');
  });
  it("encodes an independently selected H.265 preview and preserves the main codec", () => {
    const selected = { ...CAMERA, preview: { ...CAMERA.preview, codec: 'h265' as const } };
    const line = compose({ ...mppOpts, camera: selected });
    expect(line[line.indexOf('name=enc-stream') - 1]).toBe('mpph264enc');
    expect(line[line.indexOf('name=enc-preview') - 1]).toBe('mpph265enc');
    expect(line.slice(line.indexOf('name=enc-preview'))).toContain('h265parse');
    expect(refuse({ ...opts, camera: selected })).toContain('no H.265 preview encoder');
  });
  it("feeds CSI NV12 frames directly to both hardware encoders", () => {
    const line = compose({ ...mppOpts, camera: { ...CAMERA, source: "csi" } });
    expect(line).toContain("video/x-raw,format=NV12,width=1280,height=720,framerate=30/1");
    expect(line).not.toContain("mppjpegdec");
    expect(line).not.toContain("jpegdec");
    expect(line.filter((token) => token === "mpph264enc")).toHaveLength(2);
    expect(line).toContain('name=csi-source');
    expect(line).toContain('drop-only=true');
    expect(compose(mppOpts)).not.toContain('drop-only=true');
  });
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

  it("renders no pipeline for a disabled output", () => {
    // The whole point: the branch is absent from the argv, not present and idle.
    const argv = compose({ ...opts, camera: { ...CAMERA, outputs: [
      { ...rtpOutput, enabled: false }, { ...rtspOutput, enabled: true },
    ] } });
    expect(argv.join(" ")).not.toContain("udpsink");
    expect(argv.join(" ")).toContain("rtspclientsink");
  });

  it("counts branches rather than trusting a substring, in both directions", () => {
    // `rtspclientsink` alone cannot prove the rtsp *output's* branch
    // rendered: the preview copy always publishes one too (R-VID-13),
    // enabled or not — so the test above would stay green even for a filter
    // that dropped every output, or one with its condition inverted.
    // Counting tells the two apart.
    const countSinks = (enabled: boolean) => compose({ ...opts, camera: { ...CAMERA, outputs: [
      { ...rtpOutput, enabled: true }, { ...rtspOutput, enabled },
    ] } }).filter((t) => t === "rtspclientsink").length;
    expect(countSinks(true)).toBe(2);   // the rtsp output, and the preview
    expect(countSinks(false)).toBe(1);  // the preview only
  });

  it("publishes the full-rate stream and the preview under separate paths", () => {
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0");
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0-preview");
  });

  it.each([
    ["usb", opts],
    ["csi", mppOpts],
    ["accessory", opts],
  ] as const)("publishes both %s RTSP branches over interleaved TCP", (source, sourceOpts) => {
    const camera = {
      ...CAMERA,
      source,
      device: source === "accessory" ? "pocket2:test.udc" : CAMERA.device,
      outputs: [rtspOutput],
    };
    const line = compose({
      ...sourceOpts,
      camera,
      accessory: source === "accessory"
        ? { endpoint: "/run/yonder/accessory/cam0.sock", live: true, generation: 1, reason: null, native: { width: 1280, height: 720, fps: 29.97 } }
        : undefined,
    });
    const sinks = line.flatMap((token, at) => token === "rtspclientsink"
      ? [line.slice(at + 1, line.indexOf("!", at) === -1 ? line.length : line.indexOf("!", at))]
      : []);
    expect(sinks).toHaveLength(2); // configured main output and always-on preview
    for (const properties of sinks) {
      expect(properties).toEqual(expect.arrayContaining(["latency=0", "protocols=tcp"]));
    }
  });

  it("carries a fixed bitrate, in bits, on both encodes (R-VID-08)", () => {
    expect(text()).toContain("video_bitrate=2000000");
    expect(text()).toContain("video_bitrate=400000");
  });

  it("uses x264enc where the board has no hardware encoder", () => {
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", h265: null, decoder: null, device: null, hardware: false,
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
      element: "x264enc", h265: null, decoder: null, device: null, hardware: false,
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

describe("compose, on a Rockchip board (R-HW-03, R-CAM-07, spec §4 §5)", () => {
  it("decodes with the board's own JPEG decoder, and names no software decoder", () => {
    expect(mpp()).toContain("mppjpegdec");
    expect(mpp()).not.toContain("jpegdec");
  });

  it("scales the preview inside its encoder through RGA, with no scaler element at all", () => {
    const at = mpp().indexOf("name=enc-preview");
    expect(mpp()[at - 1]).toBe("mpph264enc");
    expect(mpp().slice(at, at + 6)).toEqual(expect.arrayContaining(["width=640", "height=360"]));
    expect(mppText()).not.toContain("v4l2convert");
    expect(mppText()).not.toContain("videoscale");
    expect(mppText()).not.toContain("videoconvert");
    expect(mppText()).not.toContain("name=preview-scale");
  });

  it("carries the bitrate in bits per second, in the encoder's own property, on both encodes", () => {
    expect(mpp()).toContain("bps=2000000");
    expect(mpp()).toContain("bps=400000");
    expect(mppText()).not.toContain("extra-controls");
    expect(mppText()).not.toContain("bitrate=");
  });

  it.each(["h264", "h265"] as const)(
    "bounds both %s pipeline encoders so synchronous MPP can drain output before another input",
    (codec) => {
      // RK3566's MPP changes NON_BLOCK input to BLOCK during initialization.
      // The plugin batches pending inputs before polling output; its default
      // sixteen can fill MPP's eight output slots and deadlock that task.
      // This is the composer-to-plugin contract; the RTSP restart bench proves
      // frame delivery with the real hardware and the actual emitted argv.
      const line = compose({ ...mppOpts, camera: { ...CAMERA, codec } });
      for (const name of ["enc-stream", "enc-preview"]) {
        const at = line.indexOf(`name=${name}`);
        const end = line.indexOf("!", at);
        expect(line.slice(at + 1, end)).toContain("max-pending=1");
      }
    },
  );

  it("runs a short GOP on the preview branch only", () => {
    expect(mpp().filter((t) => t === "gop=15")).toHaveLength(1);
    const preview = mppText().slice(mppText().indexOf("name=enc-preview"));
    expect(preview).toContain("gop=15");
  });

  it("keeps the preview's rate filter without pinning the memory the frames sit in", () => {
    // mppjpegdec hands out DMA buffers. A plain video/x-raw filter would
    // negotiate every branch off the tee back into system memory — the
    // +25-point arm the bench measured. (ANY) matches any caps feature.
    expect(mpp()).toContain("videorate");
    expect(mpp()).toContain("caps=video/x-raw(ANY),framerate=15/1");
  });

  it("welds the V4L2 level capsfilter to nothing on this board", () => {
    expect(mppText()).not.toContain("video/x-h264,level=(string)4");
  });

  it("encodes H.265 for the ground station and H.264 for the browser (R-CAM-08, R-VID-20)", () => {
    const line = compose({ ...mppOpts, camera: { ...CAMERA, codec: "h265" } });
    const text = line.join(" ");
    const stream = line.indexOf("name=enc-stream");
    const preview = line.indexOf("name=enc-preview");
    expect(line[stream - 1]).toBe("mpph265enc");
    expect(line[preview - 1]).toBe("mpph264enc");
    expect(text.slice(0, text.indexOf("tee name=main"))).toContain("h265parse");
    expect(text).toContain("rtph265pay");
    expect(text).not.toContain("rtph264pay");
    expect(text.slice(text.indexOf("name=enc-preview"))).toContain("h264parse");
  });

  it("composes the same line for a Pi as it did before this board existed", () => {
    expect(text()).toContain("jpegdec");
    expect(text()).toContain("v4l2convert");
    expect(text()).not.toContain("mpp");
    expect(text()).not.toContain("bps=");
    expect(text()).not.toContain("max-pending=");
  });
});

describe("the runtime channel's half of the launch line, on a Rockchip board", () => {
  it("builds a retune in MPP's own units", () => {
    expect(encodeControl(mpp(), "stream", 3000)).toEqual({
      element: "enc-stream", property: "bps", value: "3000000",
    });
    expect(encodeControl(mpp(), "preview", 700)).toEqual({
      element: "enc-preview", property: "bps", value: "700000",
    });
  });

  it("reads MPP's bits back as kb/s, and the preview's size off its encoder", () => {
    expect(encodesIn(mpp())).toEqual({ stream: 2000, preview: 400, shape: { size: "640x360", fps: 15 } });
  });

  it("knows when the preview is scaled inside its encoder", () => {
    expect(scalesInEncoder(mpp())).toBe(true);
    expect(scalesInEncoder(argv())).toBe(false);
  });
});

describe("refuse, for a codec the board cannot encode (R-CAM-08, R-CAM-10)", () => {
  it("refuses H.265 on a board whose encoder has none, before Start, naming the encoder", () => {
    const refusal = refuse({ ...opts, camera: { ...CAMERA, codec: "h265" } });
    expect(refusal).toContain("no H.265 encoder");
    expect(refusal).toContain("hardware H.264 on /dev/video11");
  });

  it("accepts it where the encoder offers it", () => {
    expect(refuse({ ...mppOpts, camera: { ...CAMERA, codec: "h265" } })).toBeNull();
  });

  it("answers the question compose() will ask", () => {
    expect(encoderFor(MPP, "h265")).toBe("mpph265enc");
    expect(encoderFor(MPP, "h264")).toBe("mpph264enc");
    expect(encoderFor(HW, "h265")).toBeNull();
  });
});

describe("the board's share of turning the picture (R-CTL-05)", () => {
  // A switch as `v4l2-ctl --list-ctrls` reports one. The bench ELP lists
  // neither flip name at all, which is the whole reason the board has to be
  // able to do this — see `video/orientation.ts`.
  const boolRange: ControlRange = { min: 0, max: 1, step: 1, default: 0, current: 0, inactive: false };
  /** The operator has asked for a mirror; who performs it depends on the caps. */
  const mirroredCamera: Camera = { ...CAMERA, controls: { ...CAMERA.controls, horizontalFlip: true } };
  /** A mirror and a half-turn, against a camera that offers neither control. */
  const boardMirroredCamera: Camera = {
    ...CAMERA, controls: { ...CAMERA.controls, horizontalFlip: true, rotation: 180 },
  };
  const sensorMirrors = { ...CAPS, horizontalFlip: present(boolRange) };

  it("adds no element when the sensor is the thing doing the turning", () => {
    // The sensor's correction costs nothing; the board's costs a pass over
    // every decoded frame. Confusing the two is the failure `capability.ts`
    // names where `horizontalFlip` is defined.
    expect(compose({ ...opts, camera: mirroredCamera, capabilities: sensorMirrors }).join(" "))
      .not.toContain("videoflip");
  });

  it("adds one when the sensor cannot, for the very same camera settings", () => {
    // Same camera, same controls — only the capabilities differ. Without
    // this pair the test above would pass for a `compose()` that had simply
    // never learned to turn a picture at all.
    expect(compose({ ...opts, camera: mirroredCamera }).join(" "))
      .toContain("videoflip video-direction=horiz");
  });

  it("adds nothing at all when nothing is asked for", () => {
    expect(compose(opts).join(" ")).not.toContain("videoflip");
  });

  it("applies the correction once, before the tee, so both branches agree", () => {
    // One correction on the frames both branches fork from. After the tee it
    // would have to be composed twice, on two branches that could then be
    // changed independently — and an operator watching the preview would be
    // told the ground station is seeing something it is not.
    const argv = compose({ ...opts, camera: boardMirroredCamera });
    expect(argv.join(" ").match(/videoflip/g)).toHaveLength(1);
    expect(argv.indexOf("videoflip")).toBeLessThan(argv.indexOf("tee"));
  });

  it("sits between the decode and the tee, with a link on each side", () => {
    // `indexOf("videoflip") < indexOf("tee")` alone would still pass with the
    // element in front of `jpegdec`, or anywhere else upstream. This pins the
    // two neighbours it actually has, which is what makes it one correction
    // on decoded frames rather than a filter on JPEG.
    const argv = compose({ ...opts, camera: boardMirroredCamera });
    const at = argv.indexOf("videoflip");
    expect(argv[at - 2]).toBe("jpegdec");
    expect(argv[at - 1]).toBe("!");
    // A mirror and a half-turn, neither of which this camera offers, so the
    // board carries the whole of it — as one direction, `vert`.
    expect(argv[at + 1]).toBe("video-direction=vert");
    expect(argv[at + 2]).toBe("!");
    expect(argv[at + 3]).toBe("tee");
  });

  it("composes one videoflip for a flip and a rotation together, not two", () => {
    // A mirror and a half-turn are a vertical flip, and the pipeline carries
    // the composed answer rather than two elements that each cost a pass.
    const argv = compose({
      ...opts,
      camera: { ...CAMERA, controls: { ...CAMERA.controls, horizontalFlip: true, rotation: 180 } },
      capabilities: sensorMirrors,
    });
    // The sensor mirrors, so only the half-turn is left for the board.
    expect(argv.join(" ")).toContain("videoflip video-direction=180");
    expect(argv.join(" ").match(/videoflip/g)).toHaveLength(1);
  });

  /**
   * **The join `video/renderer.ts` carries, pinned so it cannot go quiet.**
   *
   * That renderer composes the line a configuration implies and compares it,
   * token for token, against the line the running pipeline was started with —
   * and it composes with `noCapabilities()` while the start route composes
   * with what it probed. Since R-CTL-05 the two are not the same line for a
   * camera whose sensor can turn the picture: one apply restarts a pipeline
   * nothing asked to change, and it comes back turned twice.
   *
   * No camera on the bench can reach it — the ELP offers no `horizontal_flip`,
   * no `vertical_flip` and no `rotate` — so this states the disagreement
   * rather than asserting the bug is absent. A future change that gives both
   * composers one capability answer should make this test fail, and its
   * replacement is `toEqual`.
   */
  it("composes a different line for one configuration when the callers disagree about the camera", () => {
    const probed = compose({ ...opts, camera: mirroredCamera, capabilities: sensorMirrors });
    const unprobed = compose({ ...opts, camera: mirroredCamera, capabilities: noCapabilities() });
    expect(unprobed).not.toEqual(probed);
    // ...and for the camera the bench actually has, they agree, which is why
    // this is a recorded defect rather than a broken board.
    expect(compose({ ...opts, camera: mirroredCamera, capabilities: CAPS }))
      .toEqual(unprobed);
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
      preview: { ...CAMERA.preview, size: "1280x720" },
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
   * **The join between the pickers and this refusal** (R-CAM-14, R-VID-07).
   *
   * The deck's Resolution and Frame rate menus are `captureSizes()` over the
   * same format list this function judges against, so every pair a menu
   * offers must be one this accepts. Written as a sweep of the whole menu
   * rather than a spot check, because a disagreement between the two would
   * show up on exactly one pair — the operator's — and a console that offers
   * a mode and then will not start on it is worse than one that never
   * offered it.
   *
   * The other direction matters too and is `captureRefusal`'s own test: this
   * one would still pass if the menus were empty.
   */
  it("accepts every size and rate the deck's own menus offer", () => {
    const menu = captureSizes(CAPS.formats.value);
    expect(menu.length, "an empty menu would pass this vacuously").toBeGreaterThan(0);
    let pairs = 0;
    for (const size of menu) {
      for (const rate of size.rates) {
        pairs += 1;
        expect(
          refuse({ ...opts, camera: { ...CAMERA, width: size.width, height: size.height, framerate: rate } }),
          `the deck offers ${size.size} at ${rate} fps`,
        ).toBeNull();
      }
    }
    expect(pairs).toBe(3);
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
  const withSrt = { ...CAMERA, outputs: [{ kind: "srt" as const, enabled: true, port: 9998 }] };

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

  it("a disabled SRT output is filtered out before sink() ever throws on it", () => {
    // enabled's filter runs first in compose()'s own loop, so a disabled SRT
    // output never reaches the branch above that refuses to compose one —
    // proving the branch is skipped, not built and discarded. If the filter
    // ran after sink() (or not at all), this would throw exactly like the
    // test above.
    const disabledSrt = { ...withSrt, outputs: [{ ...withSrt.outputs[0], enabled: false }] };
    expect(() => compose({ ...opts, camera: disabledSrt })).not.toThrow();
    expect(compose({ ...opts, camera: disabledSrt }).join(" ")).not.toContain("srtsink");
  });
});

describe("the runtime channel's half of the launch line", () => {
  // R-VID-07. Everything here exists so a bitrate can reach an encoder that
  // is already running (K-48), and every one of these is a join: the same
  // fact written once and read from two places, so the launch line and the
  // command that changes it cannot drift into disagreeing.

  it("names both encodes, so a running one can be addressed at all", () => {
    expect(text()).toContain(`name=${ENCODE_ELEMENT.stream}`);
    expect(text()).toContain(`name=${ENCODE_ELEMENT.preview}`);
    // Each name belongs to exactly one element in the line it is meant to
    // pick out of.
    for (const name of Object.values(ENCODE_ELEMENT)) {
      expect(argv().filter((t) => t === `name=${name}`)).toHaveLength(1);
    }
  });

  it("builds a retune from the pipeline that is running, in the encoder's own units", () => {
    expect(encodeControl(argv(), "stream", 3000)).toEqual({
      element: "enc-stream", property: "extra-controls",
      value: "controls,video_bitrate=3000000",
    });
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", h265: null, decoder: null, device: null, hardware: false, detail: "software",
    } });
    expect(encodeControl(soft, "stream", 3000)).toEqual({
      element: "enc-stream", property: "bitrate", value: "3000",
    });
  });

  it("keeps the preview's short keyframe interval in every retune of it", () => {
    // `extra-controls` is a whole GstStructure and setting it replaces every
    // control in it. A retune carrying video_bitrate alone would silently
    // drop h264_i_frame_period and stretch the preview's GOP back to the
    // encoder's default — R-VID-09 undone by a bitrate change. The stream's
    // encode has no short GOP and must not acquire one here either.
    expect(encodeControl(argv(), "preview", 800)?.value)
      .toBe("controls,video_bitrate=800000,h264_i_frame_period=15");
    expect(encodeControl(argv(), "stream", 800)?.value).not.toContain("i_frame_period");
  });

  it("offers no retune for an encode the running pipeline does not carry", () => {
    // A fixed-passthrough feed has no encoder element in its line, so there
    // is nothing named to address. Derived from the pipeline rather than
    // declared anywhere, so a passthrough feed answers correctly the day one
    // is composed.
    const at = argv().indexOf(`name=${ENCODE_ELEMENT.stream}`);
    const passthrough = argv().filter((_, i) => i < at - 1 || i > at + 1);
    expect(encodeControl(passthrough, "stream", 3000)).toBeNull();
    expect(encodeControl(passthrough, "preview", 700)).not.toBeNull();
  });

  it("reads back the rates the line is actually running, on either encoder", () => {
    // The seed for "last confirmed": what the process was told when it was
    // started, not what config.yaml says now. K-48 is the difference.
    expect(encodesIn(argv())).toEqual({
      stream: 2000, preview: 400, shape: { size: "640x360", fps: 15 },
    });
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", h265: null, decoder: null, device: null, hardware: false, detail: "software",
    } });
    expect(encodesIn(soft)).toMatchObject({ stream: 2000, preview: 400 });
  });

  it("reads the rung the preview is actually held at, auto resolved", () => {
    const pinned = compose({ ...opts, camera: {
      ...CAMERA, preview: { ...CAMERA.preview, size: "854x480", framerate: 10 },
    } });
    expect(encodesIn(pinned).shape).toEqual({ size: "854x480", fps: 10 });
  });

  it("sends a reconfigure exactly the caps compose would have baked in", () => {
    // The join that matters most: a rung change and a fresh start must
    // produce the same picture. Composed for a size, read back off the
    // composed line, and asked for by a reconfigure — three routes, one
    // answer.
    for (const shape of [
      { size: "1280x720" as const, fps: 30 },
      { size: "854x480" as const, fps: 10 },
      { size: "640x360" as const, fps: 15 },
    ]) {
      const baked = compose({ ...opts, camera: {
        ...CAMERA, preview: { ...CAMERA.preview, size: shape.size, framerate: shape.fps },
      } });
      for (const set of previewCaps(shape)) {
        const at = baked.indexOf(`name=${set.element}`);
        expect(at).toBeGreaterThan(0);
        expect(baked[at + 1]).toBe(`${set.property}=${set.value}`);
      }
      expect(encodesIn(baked).shape).toEqual(shape);
    }
  });

  it("names the preview's capsfilters without changing what they filter", () => {
    // `capsfilter name=x caps=C` and a bare `C` build the same element; the
    // difference is that this one can be addressed while it is running.
    expect(text()).toContain(`capsfilter name=${PREVIEW_CAPS_ELEMENT.scale}`);
    expect(text()).toContain("caps=video/x-raw,width=640,height=360");
    expect(text()).toContain(`capsfilter name=${PREVIEW_CAPS_ELEMENT.rate}`);
    expect(text()).toContain("caps=video/x-raw,framerate=15/1");
  });
});

describe('stream color processing', () => {
  it('bypasses neutral settings and changes both encodes before the shared raw tee without another queue or codec', () => {
    const neutral = { brightness: 0, contrast: 100, saturation: 100, hue: 0 };
    const base = compose({ ...opts, camera: { ...CAMERA, image: neutral } });
    expect(base).not.toContain('videobalance');
    const adjusted = compose({ ...opts, camera: { ...CAMERA, image: { brightness: 10, contrast: 110, saturation: 115, hue: 9 } } });
    expect(adjusted.join(' ')).toContain('videobalance name=image-balance brightness=0.1 contrast=1.1 saturation=1.15 hue=0.05 !');
    expect(adjusted.indexOf('videobalance')).toBeLessThan(adjusted.indexOf('name=raw'));
    for (const token of ['queue', 'jpegdec', 'v4l2h264enc']) expect(adjusted.filter(t => t === token)).toHaveLength(base.filter(t => t === token).length);
  });
});
