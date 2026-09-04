// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, CameraOutput } from "../schema/config.js";
import type { CameraCapabilities } from "./capability.js";
import type { Encoder } from "./probe/encoder.js";

/**
 * One camera, one pipeline, composed as a value (R-VID-05).
 *
 * **Nothing here runs anything.** The composed pipeline is an argv a test
 * asserts without a camera, which is also the condition CI runs in.
 *
 * **The shape, and why it is not the obvious one.** The sketch this design
 * inherits forks once, after h264parse: one encode, copied to two consumers.
 * That is right about the encoder — the tee costs almost nothing, 68% of a
 * core for one output against 70% for two — and wrong about the uplink, where
 * each consumer that leaves over cellular costs its own bitrate. At 2 Mb/s
 * that is 6 Mb/s for one camera against a field LTE uplink that is often 1-5.
 *
 * So the graph forks twice:
 *
 *     v4l2src ! image/jpeg ! jpegdec ! tee name=raw
 *       raw. ! queue ! ENCODE(full) ! h264parse ! tee name=main
 *         main. ! queue ! rtph264pay ! udpsink        (R-VID-01)
 *         main. ! queue ! rtspclientsink              (R-VID-03/04, via mediamtx)
 *       raw. ! queue ! v4l2convert ! videorate ! ENCODE(preview) ! h264parse
 *            ! rtspclientsink                          (R-VID-13)
 *
 * The preview is a *second encode from frames already decoded*. The JPEG
 * decode is the entire cost of this pipeline — 1% capture, ~50% software
 * decode, +4% hardware encode — so a second encode off the decoded frames is
 * cheap in a way a second capture would not be, and it takes the browser's
 * share of the uplink down by most of an order of magnitude.
 *
 * The downscale uses the board's own resizer. That hardware sits idle once the
 * ISP converter is out of the main path, and software scaling of 1080p at
 * 30 fps is the one term the substituted 11% figure contains no allowance for
 * at all.
 *
 * **The preview branch runs a short keyframe interval and the ground-station
 * branch does not.** A reconnecting browser is a late joiner and without a
 * keyframe watches a grey rectangle for up to a whole group of pictures
 * (R-VID-09). Asking the media server to demand one from the encoder needs a
 * control channel M4 does not have, over an interface nobody has exercised.
 * Since section 4 already made these two separate encodes, a short GOP on the
 * cheap one costs a few tens of kb/s on a branch running at a few hundred —
 * and it is the only branch with a person watching the rectangle. A late-
 * joining *ground station* still wants the control channel, and waits for one.
 *
 * **The encoder's node is not chosen here, and cannot be.** `v4l2h264enc`'s
 * `device` property is *readable only*. The video4linux2 plugin scans the
 * board's devices when it registers, binds one element to each, and the
 * property reports which node this element was given — it is an answer, not a
 * request, and setting it draws a GObject CRITICAL and is ignored. Selection
 * is by element *name*: the first device offering a codec takes the generic
 * name and any others take a per-device one, which is why this board carries
 * both `v4l2convert` (/dev/video12) and `v4l2video18convert` (/dev/video18).
 * Exactly one node here takes raw in and gives H.264 out, so `v4l2h264enc` is
 * bound to it and there is nothing to steer; a board with two would need the
 * name `v4l2video<N>h264enc`, which `Encoder.element`'s type does not admit.
 * `Encoder.device` is therefore informational, and `probe/encoder.ts` says so
 * where the field is defined.
 */

/**
 * The queue on every branch off every tee.
 *
 * **A bare `queue` blocks when it fills.** A ground station that stops
 * reading, a media server that stalls, or a TCP connection that goes quiet
 * applies back-pressure through the tee, stalls the shared encoder, and takes
 * every other branch down with it — including the one the operator is
 * watching. That would make the spec's central claim about link loss —
 * *capture, encode and the ground-station push continue* — false rather than
 * merely untested.
 *
 * Bounded by time rather than by buffers or bytes, because 200 ms is a
 * latency budget and a buffer count is not. `max-size-buffers=0` and
 * `max-size-bytes=0` disable the other two limits, which default to non-zero
 * and would otherwise bound the queue first and by the wrong measure.
 */
export const QUEUE = [
  "queue", "leaky=downstream",
  "max-size-time=200000000", "max-size-buffers=0", "max-size-bytes=0",
] as const;

export interface ComposeOptions {
  readonly camera: Camera;
  readonly capabilities: CameraCapabilities;
  readonly encoder: Encoder;
  /** Where mediamtx listens, on loopback. */
  readonly rtspBase: string;
  /**
   * The `/dev/v4l/by-path/` names the probe actually found, when the caller
   * has probed. Supplied, it lets `refuse` catch a `device` that resolves to
   * nothing; absent, that check is skipped, because a caller holding no list
   * cannot be held to one.
   */
  readonly knownDevices?: ReadonlySet<string>;
}

/** `! element prop=v !` — GStreamer's link token, as its own argv entry. */
const LINK = "!";

/**
 * The RTP payload type this project's own H.264 stream uses.
 *
 * RFC 3551 reserves 96–127 for a payload with no static assignment, which
 * H.264 has none of; any number in that range would interoperate equally
 * well. Fixed here, once, so `rtph264pay`'s `pt=` on this, the sending side,
 * and the `payload=` a receiver built from `receive.ts` puts in its caps
 * cannot drift into two different answers to the same question.
 */
export const RTP_PAYLOAD_TYPE = 96;

/**
 * The capsfilter every `v4l2h264enc` needs, and the evidence that it does.
 *
 * Without it the element builds, links, reaches PLAYING, and then dies on the
 * **first frame** — not at link time, which is what makes it expensive to
 * diagnose, because everything looks well for about a third of a second:
 *
 *     ERROR .../v4l2h264enc:v4l2h264enc0: Failed to process frame.
 *     ../sys/v4l2/gstv4l2videoenc.c(898): gst_v4l2_video_enc_handle_frame ()
 *
 * with the driver's own reason in the kernel log, which is where the useful
 * half of the message is:
 *
 *     bcm2835-codec: bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3
 *
 * **It is the encoder, not the camera and not the fork.** It reproduces on
 * `videotestsrc ! video/x-raw,format=I420,1280x720,30/1 ! v4l2h264enc !
 * fakesink` — no camera, no jpegdec, no tee, one encode.
 *
 * **The order was checked**, because a codec left in a bad state by one
 * attempt would look exactly like this. With the capsfilter first, without it
 * second, with it again third: ok, ERROR, ok. The caps decide.
 *
 * On `v4l2h264enc` only. `x264enc` needs nothing of the kind, and copying it
 * across would be the ritual this note exists to prevent.
 */
const H264_LEVEL = "video/x-h264,level=(string)4";

function encode(encoder: Encoder, kbps: number, shortGop: boolean): string[] {
  if (encoder.element === "x264enc") {
    // x264enc counts in kb/s and takes key-int-max in frames. `tune=zerolatency`
    // because a B-frame reorder buffer is latency on a link that already has
    // 300 ms of it (R-UI-06).
    return [
      "x264enc", `bitrate=${kbps}`, "speed-preset=veryfast", "tune=zerolatency",
      ...(shortGop ? ["key-int-max=15"] : []),
    ];
  }
  const controls = [`video_bitrate=${kbps * 1000}`, ...(shortGop ? ["h264_i_frame_period=15"] : [])];
  // No `device=`: the property is read-only and `encoder.device` cannot be
  // applied — see the module comment. The capsfilter is welded on here rather
  // than added at the two call sites, because an encoder that reaches one of
  // them without it does not survive its first frame.
  return [
    "v4l2h264enc", `extra-controls=controls,${controls.join(",")}`,
    LINK, H264_LEVEL,
  ];
}

function sink(output: CameraOutput, rtspBase: string): string[] {
  switch (output.kind) {
    case "rtp":
      // config-interval=-1 sends SPS/PPS with every keyframe. Without it a
      // ground station started after the stream never gets the parameter sets
      // and shows nothing, with no error, for ever.
      return ["rtph264pay", "config-interval=-1", `pt=${RTP_PAYLOAD_TYPE}`, LINK,
        "udpsink", `host=${output.host}`, `port=${output.port}`, "sync=false"];
    case "rtsp":
      return ["rtspclientsink", `location=${rtspBase}/${output.path}`, "latency=0"];
    case "srt":
      return ["mpegtsmux", LINK, "srtsink", `uri=srt://:${output.port}`, "wait-for-connection=false"];
  }
}

export function compose(opts: ComposeOptions): string[] {
  const { camera, encoder, rtspBase } = opts;
  const argv: string[] = ["gst-launch-1.0", "-q"];
  const push = (...tokens: string[]): void => { argv.push(...tokens); };

  push(
    "v4l2src", `device=/dev/v4l/by-path/${camera.device}`, "io-mode=4", LINK,
    `image/jpeg,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
    "jpegdec", LINK,
    "tee", "name=raw",
  );

  // The full-rate encode, then the fork to its consumers.
  push("raw.", LINK, ...QUEUE, LINK, ...encode(encoder, camera.bitrate_kbps, false), LINK,
    "h264parse", LINK, "tee", "name=main");
  for (const output of camera.outputs) {
    push("main.", LINK, ...QUEUE, LINK, ...sink(output, rtspBase));
  }

  // The cheap copy the interface watches (R-VID-13), always published, always
  // under its own path so the console can never subscribe to the wrong one.
  push(
    "raw.", LINK, ...QUEUE, LINK,
    "v4l2convert", LINK,
    `video/x-raw,width=${camera.preview.width},height=${camera.preview.height}`, LINK,
    "videorate", LINK, `video/x-raw,framerate=${camera.preview.framerate}/1`, LINK,
    ...encode(encoder, camera.preview.bitrate_kbps, true), LINK,
    "h264parse", LINK,
    "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
  );

  return argv;
}

/**
 * Why this configuration cannot be sustained, or null (R-CAM-10).
 *
 * The pickers are built from what the camera reported, so this is the second
 * line of defence rather than the first — but `config.yaml` is a file an
 * operator may edit by hand, and a pipeline that fails to start says
 * `Internal data stream error` and nothing else.
 *
 * **Pure, and ordered with the file's own faults first.** Nothing here reads
 * a device or runs a command — the by-path names come in as a set the caller
 * probed — so the two checks answerable from `config.yaml` alone are made
 * before the two that depend on what the camera said about its sizes.
 */
export function refuse(opts: ComposeOptions): string | null {
  const { camera, capabilities, knownDevices } = opts;

  // A `device` that resolves to nothing is the likeliest of these to be hit,
  // and today the only report of it is `Internal data stream error`.
  // `v4l2-ctl --list-devices` prints a *bus id* in parentheses after the card
  // name — `usb-0000:01:00.0-1.3` — which looks like an answer, is a
  // different identifier from any by-path name, and has no entry under
  // /dev/v4l/by-path/ to resolve against.
  if (knownDevices && !knownDevices.has(camera.device)) {
    const offered = [...knownDevices].sort().join(", ");
    return offered
      ? `this board has no /dev/v4l/by-path/${camera.device}; the cameras it can see are ${offered}`
      : `this board has no /dev/v4l/by-path/${camera.device}, and no camera on it has a stable name at all`;
  }
  if (camera.preview.width > camera.width || camera.preview.height > camera.height) {
    return `the preview is ${camera.preview.width}x${camera.preview.height}, larger than the ${camera.width}x${camera.height} it is scaled from`;
  }

  if (capabilities.formats.state !== "present") {
    return "this camera has not answered with any capture format";
  }
  const formats = capabilities.formats.value;
  const size = formats.find((f) => f.width === camera.width && f.height === camera.height);
  if (!size) {
    const offered = formats.map((f) => `${f.width}x${f.height}`).join(", ");
    return `this camera does not offer ${camera.width}x${camera.height}; it offers ${offered}`;
  }
  if (!size.rates.includes(camera.framerate)) {
    return `this camera does not offer ${camera.framerate} fps at ${camera.width}x${camera.height}; it offers ${size.rates.join(", ")}`;
  }
  return null;
}
