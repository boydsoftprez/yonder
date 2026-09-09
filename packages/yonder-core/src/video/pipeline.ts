// SPDX-License-Identifier: GPL-3.0-or-later
import { PREVIEW_RUNGS, type Camera, type CameraOutput, type PreviewRung } from "../schema/config.js";
import { captureRefusal, type CameraCapabilities } from "./capability.js";
import { orientation } from "./orientation.js";
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
 *     v4l2src ! image/jpeg ! jpegdec ! [videoflip] ! tee name=raw
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
  /**
   * What the device answered (R-CAM-14).
   *
   * **Read by `refuse()`, and since R-CTL-05 by `compose()` too**, which is a
   * change worth stating rather than leaving to be discovered: whether the
   * board must turn the picture depends on whether the *sensor* can, so two
   * callers who disagree about this camera's capabilities compose two
   * different launch lines for one configuration. `video/renderer.ts`
   * compares the line a configuration implies against the line the running
   * pipeline was started with and respawns on any difference, so a caller
   * that cannot answer this honestly must not be the one deciding — see the
   * note there.
   */
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

type Codec = Camera["codec"];
export type EncodeKind = Encoder["element"] | "mpph265enc";

/** The parser that follows an encode. */
function parser(codec: Codec): string {
  return codec === "h265" ? "h265parse" : "h264parse";
}

/** The payloader an RTP output needs. */
function payloader(codec: Codec): string {
  return codec === "h265" ? "rtph265pay" : "rtph264pay";
}

/**
 * Which element encodes `codec` on this board, or null where it has none.
 * H.265 is a Rockchip capability (R-CAM-08): the Pi's V4L2 encoder and
 * `x264enc` are H.264 only. `refuse()` turns the null into a sentence before
 * Start; `compose()` treats reaching it as a programming error.
 */
export function encoderFor(encoder: Encoder, codec: Codec): EncodeKind | null {
  return codec === "h265" ? encoder.h265 : encoder.element;
}

/**
 * Whether this board's preview is scaled inside its encoder. On MPP the
 * encoder carries `width`/`height` and hands the resize to RGA — measured at
 * about twice a software scaler's throughput, and the whole preview branch at
 * one point of four cores. There is then no scaler element to reconfigure
 * live, which is what `encoder.ts` asks this for.
 */
function encoderScales(encoder: Encoder): boolean {
  return encoder.element === "mpph264enc";
}

/** The same question, of a launch line that is running. */
export function scalesInEncoder(argv: readonly string[]): boolean {
  const preview = elementIn(argv, ENCODE_ELEMENT.preview);
  return preview !== null && preview.kind.startsWith("mpp")
    && elementIn(argv, PREVIEW_CAPS_ELEMENT.scale) === null;
}

/**
 * The preview's rate filter, written so it does not pin the memory the
 * frames sit in. `mppjpegdec` hands out DMA buffers; a plain `video/x-raw`
 * filter on one branch negotiates every branch off the tee back into system
 * memory, which is the +25-point arm the bench measured against +4. `(ANY)`
 * matches any caps feature.
 */
function anyMemory(set: ElementProperty): ElementProperty {
  return { ...set, value: set.value.replace(/^video\/x-raw,/, "video/x-raw(ANY),") };
}

/**
 * The concrete pixel size to bake into today's respawn-only pipeline.
 *
 * `preview.size` names one of three offered resolutions directly, or
 * `"auto"` for the rate controller (`video/rate.ts`, spec §8.1) to move at
 * runtime. A launch line still has to carry a concrete size, and for `"auto"`
 * that is `ladder_bottom` — **the rung the controller starts from**, being
 * the conservative end an adaptive algorithm climbs from before it has proven
 * more capacity is safe. Baking in a size chosen independently of the ladder
 * would let the two silently disagree about where the picture began.
 */
/** The rung `preview.size` is holding, with `"auto"` resolved (see above). */
function heldRung(preview: Camera["preview"]): PreviewRung {
  return preview.size === "auto" ? preview.ladder_bottom : preview.size;
}

function previewSize(preview: Camera["preview"]): { width: number; height: number } {
  const [width, height] = heldRung(preview).split("x").map(Number) as [number, number];
  return { width, height };
}

/**
 * The two encodes, and the name each one carries in the launch line.
 *
 * **A name is what makes an element addressable while it is running**
 * (R-VID-07). `gst-launch-1.0`'s `name=` is how anything holding the pipeline
 * finds one element among the dozen this file composes, so the runtime
 * channel's commands are addressed to these names and nothing else — see
 * `encodeControl` below and `video/encoder.ts`.
 *
 * Exported because the channel and the launch line must agree about them
 * exactly: a name typed twice is a name that can drift, and a command
 * addressed to an element that is not there does nothing and says nothing.
 */
export const ENCODE_ELEMENT = { stream: "enc-stream", preview: "enc-preview" } as const;
export type EncodeName = keyof typeof ENCODE_ELEMENT;

/**
 * Which encode runs the short keyframe interval (R-VID-09), in one place.
 *
 * `compose()` reads it to build the launch line and `encodeControl()` reads
 * it to build a retune. **On `v4l2h264enc` that is not a convenience.**
 * `extra-controls` is a whole `GstStructure`: setting it at runtime replaces
 * every control in it, so a retune that carried only `video_bitrate` would
 * silently drop the preview's `h264_i_frame_period` and stretch its GOP back
 * to the encoder's default — the browser-side guarantee of R-VID-09, undone
 * by a bitrate change, with nothing to see in any log. One table, read twice.
 */
const SHORT_GOP: Record<EncodeName, boolean> = { stream: false, preview: true };

/**
 * The preview's two capsfilters, named for the same reason the encodes are.
 *
 * Written as an explicit `capsfilter name=… caps=…` rather than as the bare
 * caps string `gst-launch` would turn into an anonymous one. The element the
 * pipeline gets is identical either way; the difference is that this one has
 * a name a reconfigure can address (`previewCaps` below).
 */
export const PREVIEW_CAPS_ELEMENT = { scale: "preview-scale", rate: "preview-rate" } as const;

/** One property of one named element: what a launch line bakes in, and what a
 *  runtime command carries. The two are built by the same functions here. */
export interface ElementProperty {
  readonly element: string;
  readonly property: string;
  readonly value: string;
}

/** The size and rate the preview branch is asked to hold. */
export interface PreviewShape {
  readonly size: PreviewRung;
  readonly fps: number;
}

/** `prop=value`, as the launch line's own token. */
function token(set: ElementProperty): string {
  return `${set.property}=${set.value}`;
}

/** The controls `v4l2h264enc` carries, for a launch line and for a retune alike. */
function extraControls(kbps: number, shortGop: boolean): string {
  return [
    "controls", `video_bitrate=${kbps * 1000}`,
    ...(shortGop ? ["h264_i_frame_period=15"] : []),
  ].join(",");
}

/**
 * What sets one encode's bitrate, by element kind.
 *
 * Exhaustive over `Encoder["element"]` with no `default:`, so a board whose
 * encoder is neither of these cannot be added without this function being
 * made to answer for it.
 */
function bitrateOf(
  kind: EncodeKind, element: string, kbps: number, shortGop: boolean,
): ElementProperty {
  switch (kind) {
    case "x264enc":
      // x264enc counts in kb/s, and its `bitrate` is settable while playing.
      return { element, property: "bitrate", value: String(kbps) };
    case "v4l2h264enc":
      return { element, property: "extra-controls", value: extraControls(kbps, shortGop) };
    case "mpph264enc":
    case "mpph265enc":
      // MPP counts in bits per second, in a plain property. Measured live on
      // an RK3566 with the real camera in front of it: 0.96 → 3.93 Mb/s on
      // both encoders, no gap after the change (retune-bitrate-mpp.py).
      return { element, property: "bps", value: String(kbps * 1000) };
  }
}

function encode(
  kind: EncodeKind, name: EncodeName, kbps: number,
  scale: { width: number; height: number } | null,
): string[] {
  const element = ENCODE_ELEMENT[name];
  const bitrate = token(bitrateOf(kind, element, kbps, SHORT_GOP[name]));
  switch (kind) {
    case "x264enc":
      // key-int-max is in frames. `tune=zerolatency` because a B-frame reorder
      // buffer is latency on a link that already has 300 ms of it (R-UI-06).
      return [
        "x264enc", `name=${element}`, bitrate, "speed-preset=veryfast", "tune=zerolatency",
        ...(SHORT_GOP[name] ? ["key-int-max=15"] : []),
      ];
    case "v4l2h264enc":
      // No `device=`: the property is read-only and `encoder.device` cannot
      // be applied — see the module comment. The capsfilter is welded on here
      // rather than at the call sites, because an encoder that reaches it
      // without one does not survive its first frame.
      return ["v4l2h264enc", `name=${element}`, bitrate, LINK, H264_LEVEL];
    case "mpph264enc":
    case "mpph265enc":
      // `gop` is the keyframe interval in frames (-1 means one per second).
      // `width`/`height` are RGA's resize inside the encoder, taken at start
      // only — set while playing they are accepted and ignored (measured).
      // RK3566's MPP changes nonblocking input to blocking at initialization.
      // The plugin sends its whole pending batch before draining output; its
      // default sixteen frames can fill MPP's eight output slots and deadlock
      // that same task. One pending frame keeps submission and draining paired
      // on both encodes (R-VID-13, R-VID-20). Reproduced with RTSP, then verified
      // across repeated starts by scripts/spikes/rockchip-rtsp-restarts.py.
      return [
        kind, `name=${element}`, bitrate, "max-pending=1",
        ...(SHORT_GOP[name] ? ["gop=15"] : []),
        ...(scale === null ? [] : [`width=${scale.width}`, `height=${scale.height}`]),
      ];
  }
}

/**
 * The caps the preview branch is scaled and timed by — one function, read by
 * `compose()` when it bakes them in and by a reconfigure when it changes them
 * (R-VID-07, spec §8.1).
 *
 * Two properties rather than one: `v4l2convert` fixes the size and
 * `videorate` fixes the rate, and a rung change moves the first without
 * touching the second.
 */
export function previewCaps(shape: PreviewShape): readonly [ElementProperty, ElementProperty] {
  const [width, height] = shape.size.split("x").map(Number) as [number, number];
  return [
    {
      element: PREVIEW_CAPS_ELEMENT.scale, property: "caps",
      value: `video/x-raw,width=${width},height=${height}`,
    },
    {
      element: PREVIEW_CAPS_ELEMENT.rate, property: "caps",
      value: `video/x-raw,framerate=${shape.fps}/1`,
    },
  ];
}

/**
 * Where one output goes.
 *
 * **The RTSP location is built from the camera's id, and nothing else may name
 * it.** `media/config.ts` declares `paths[camera.id]`, `console/whep.ts`
 * proxies the browser to the same name, and `receive.ts` prints it: an output
 * carrying a path of its own gave four files three answers, agreeing only
 * where the same string had been typed twice. `media/config.test.ts` holds
 * every location this function composes against the paths that file declares,
 * so the two cannot drift apart again without a test going red.
 */
function sink(output: CameraOutput, rtspBase: string, cameraId: string, codec: Codec): string[] {
  switch (output.kind) {
    case "rtp":
      // config-interval=-1 sends SPS/PPS with every keyframe. Without it a
      // ground station started after the stream never gets the parameter sets
      // and shows nothing, with no error, for ever.
      return [payloader(codec), "config-interval=-1", `pt=${RTP_PAYLOAD_TYPE}`, LINK,
        "udpsink", `host=${output.host}`, `port=${output.port}`, "sync=false"];
    case "rtsp":
      return ["rtspclientsink", `location=${rtspBase}/${cameraId}`, "latency=0"];
    case "srt":
      // **Unreachable, and it throws rather than composing.** `refuse()` below
      // rejects an SRT output before anything is composed, and the daemon
      // refuses the start on that refusal — so this line is what happens when
      // somebody removes that guard without building SRT a posture first.
      // Throwing is the safe direction to be wrong in: the alternative
      // (`srtsink uri=srt://:<port>`) binds 0.0.0.0 with no passphrase, which
      // is the failure R-SEC-13 exists to prevent, and it fails silently.
      throw new Error(
        "an SRT output has no stated posture yet and is refused before composition (R-SEC-13, R-VID-06)",
      );
  }
}

/**
 * The board's share of turning the picture, as launch-line tokens, or none
 * at all (R-CTL-05).
 *
 * **Between `jpegdec` and `tee name=raw`, and that placement is the point.**
 * One correction, applied once, to the frames both branches are forked from
 * — so the full-rate stream and the preview cannot disagree about which way
 * up the world is. After the tee it would have to be composed twice, on two
 * branches that could then be changed independently, and an operator
 * watching the preview would be told the ground station is seeing something
 * it is not.
 *
 * Unnamed, unlike the encodes and the preview's capsfilters. A name here
 * would be a name nothing addresses: this correction is baked in and only a
 * respawn changes it, so there is no runtime command to point at it and a
 * name would only suggest there were one.
 *
 * `orientation()` returns null for the sensor's own doing and for a picture
 * nobody asked to turn, and both of those compose no element rather than an
 * `identity` one — a `videoflip` that turns nothing still copies every
 * frame.
 */
function turn(opts: ComposeOptions): string[] {
  const board = orientation(opts.capabilities, opts.camera.controls);
  return board.flip === null ? [] : ["videoflip", `video-direction=${board.flip}`, LINK];
}

export function compose(opts: ComposeOptions): string[] {
  const { camera, encoder, rtspBase } = opts;
  const main = encoderFor(encoder, camera.codec);
  if (main === null) {
    throw new Error(
      `${camera.id} asks for ${camera.codec} and this board's encoder offers none; refuse() answers this before compose() is reached`,
    );
  }
  const argv: string[] = ["gst-launch-1.0", "-q"];
  const push = (...tokens: string[]): void => { argv.push(...tokens); };

  push(
    "v4l2src", `device=/dev/v4l/by-path/${camera.device}`, "io-mode=4", LINK,
    ...(camera.source === "csi" ? [
      `video/x-raw,format=NV12,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
    ] : [
      `image/jpeg,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
    // Spec §5: decode in hardware where the board has it, so the frames
    // never leave the SoC between capture and encode. Measured at +3 points
    // against software's +8 for one branch, +4 against +14 for two.
    encoder.decoder ?? "jpegdec", LINK,
    ]),
    ...turn(opts),
    "tee", "name=raw",
  );

  // The full-rate encode, then the fork to its consumers.
  push("raw.", LINK, ...QUEUE, LINK, ...encode(main, "stream", camera.bitrate_kbps, null), LINK,
    parser(camera.codec), LINK, "tee", "name=main");
  // A disabled output contributes no branch at all (R-VID-16) — not a branch
  // that opens a socket and sits muted, which is a different claim to an
  // operator than "stopped". See the note on `CameraOutput.enabled`.
  for (const output of camera.outputs.filter((o) => o.enabled)) {
    push("main.", LINK, ...QUEUE, LINK, ...sink(output, rtspBase, camera.id, camera.codec));
  }

  // The cheap copy the interface watches (R-VID-13), always published, always
  // under its own path so the console can never subscribe to the wrong one.
  const [scale, rate] = previewCaps({
    size: heldRung(camera.preview), fps: camera.preview.framerate,
  });
  // The interface's copy is always H.264, whatever the main stream carries:
  // a browser reaches it over WebRTC (R-VID-20).
  if (encoderScales(encoder)) {
    push(
      "raw.", LINK, ...QUEUE, LINK,
      "videorate", LINK,
      "capsfilter", `name=${rate.element}`, token(anyMemory(rate)), LINK,
      ...encode(encoder.element, "preview", camera.preview.bitrate_kbps, previewSize(camera.preview)), LINK,
      "h264parse", LINK,
      "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
    );
  } else {
    push(
      "raw.", LINK, ...QUEUE, LINK,
      "v4l2convert", LINK,
      "capsfilter", `name=${scale.element}`, token(scale), LINK,
      "videorate", LINK,
      "capsfilter", `name=${rate.element}`, token(rate), LINK,
      ...encode(encoder.element, "preview", camera.preview.bitrate_kbps, null), LINK,
      "h264parse", LINK,
      "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
    );
  }

  return argv;
}

/**
 * The properties one named element carries in a launch line, or null where
 * that line has no such element.
 *
 * **Read from the argv the process is actually running, never from the
 * configuration.** K-48 is what the other choice looks like: `config.yaml`
 * said 2000 kb/s while the encoder ran 100, and every file that answered
 * from the config agreed with the config and was wrong. The launch line is
 * the only record of what the running pipeline was actually told.
 *
 * `element` is the token before `name=…` because that is how `compose()`
 * writes it and how `gst-launch` parses it — the element, then its
 * properties, until the next `!`.
 */
function elementIn(
  argv: readonly string[], element: string,
): { readonly kind: string; readonly props: readonly string[] } | null {
  const at = argv.indexOf(`name=${element}`);
  if (at < 1) return null;
  const props: string[] = [];
  for (let i = at + 1; i < argv.length && argv[i] !== LINK; i++) props.push(argv[i]);
  return { kind: argv[at - 1], props };
}

/**
 * What retunes one encode of a **running** pipeline to `kbps`, or null where
 * that pipeline carries no such encode to retune (R-VID-07).
 *
 * Null is the fixed-passthrough answer, and it is derived rather than
 * declared: a feed that carries the source's own encoding has no encoder
 * element in its launch line, so there is nothing named to address and
 * nothing this function can offer. `video/encoder.ts` turns that into the
 * `notControllable` an operator is shown, rather than a control that appears
 * to work.
 */
const ENCODE_KINDS: readonly string[] = ["v4l2h264enc", "x264enc", "mpph264enc", "mpph265enc"];

export function encodeControl(
  argv: readonly string[], name: EncodeName, kbps: number,
): ElementProperty | null {
  const element = ENCODE_ELEMENT[name];
  const found = elementIn(argv, element);
  if (found === null) return null;
  if (!ENCODE_KINDS.includes(found.kind)) return null;
  return bitrateOf(found.kind as EncodeKind, element, kbps, SHORT_GOP[name]);
}

/**
 * What a running pipeline was told at the moment it was started: the bitrate
 * of each encode it carries, and the shape its preview branch holds.
 *
 * This is the **last confirmed state** before anything has been retuned —
 * the seed `video/encoder.ts` starts from, so a failed retune reports what
 * the encoder is doing rather than what the configuration wishes it were.
 * A `null` field means the running pipeline has no such encode at all.
 */
export interface RunningEncodes {
  readonly stream: number | null;
  readonly preview: number | null;
  readonly shape: PreviewShape | null;
}

function bitrateIn(argv: readonly string[], name: EncodeName): number | null {
  const found = elementIn(argv, ENCODE_ELEMENT[name]);
  if (found === null) return null;
  for (const prop of found.props) {
    // v4l2h264enc, in bits per second, inside the controls structure.
    const controls = /^extra-controls=.*\bvideo_bitrate=(\d+)/.exec(prop);
    if (controls) return Math.round(Number(controls[1]) / 1000);
    // x264enc, already in kb/s.
    const plain = /^bitrate=(\d+)$/.exec(prop);
    if (plain) return Number(plain[1]);
    const bps = /^bps=(\d+)$/.exec(prop);
    if (bps) return Math.round(Number(bps[1]) / 1000);
  }
  return null;
}

function shapeIn(argv: readonly string[]): PreviewShape | null {
  const rate = elementIn(argv, PREVIEW_CAPS_ELEMENT.rate);
  if (rate === null) return null;
  const fps = /\bframerate=(\d+)\/1/.exec(rate.props.join(" "));
  // The size lives on the capsfilter where a scaler element does the
  // resize, and on the preview encoder itself where RGA does it inside.
  const scale = elementIn(argv, PREVIEW_CAPS_ELEMENT.scale);
  const preview = elementIn(argv, ENCODE_ELEMENT.preview);
  const size = scale !== null
    ? /\bwidth=(\d+),height=(\d+)/.exec(scale.props.join(" "))
    : preview === null ? null : /\bwidth=(\d+) height=(\d+)/.exec(preview.props.join(" "));
  if (size === null || fps === null) return null;
  const rung = `${size[1]}x${size[2]}`;
  // A size this schema does not offer is not reported as one it does. The
  // pipeline could only be carrying it if something outside `compose()` built
  // the line, and inventing a fourth rung to name it would be the repair
  // R-CMD-04 refuses everywhere else.
  if (!(PREVIEW_RUNGS as readonly string[]).includes(rung)) return null;
  return { size: rung as PreviewRung, fps: Number(fps[1]) };
}

export function encodesIn(argv: readonly string[]): RunningEncodes {
  return {
    stream: bitrateIn(argv, "stream"),
    preview: bitrateIn(argv, "preview"),
    shape: shapeIn(argv),
  };
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
  const { camera, capabilities, encoder, knownDevices } = opts;

  // **First, because it is the one that cannot be fixed by looking at the
  // camera.** `srtsink` binds `0.0.0.0:<port>` and leaves `passphrase` at its
  // default of the empty string — no encryption and no authentication — and
  // the socket is opened by this pipeline's own process rather than by the
  // media server, so `media/config.ts`'s `authInternalUsers` is not in the
  // path at all. Anyone who can reach this board, on the LAN, on the mesh or
  // on a routable cellular address, would pull the full-rate H.264 with no
  // credential: R-SEC-13 says every media listener has a stated posture, and
  // this one has none and appears in none of them.
  //
  // R-VID-06 is the requirement that owns SRT and it is not built. The shape
  // stays in the schema so a configuration already holding one still loads and
  // can be read and corrected, and the milestone that serves SRT owes it a
  // credential before this refusal comes out.
  //
  // **Deliberately ignores `enabled`.** *SRT is not supported yet* is true
  // whether or not this particular output is switched on — disabling it
  // does not give it the posture R-VID-06 owes it — so gating this refusal
  // on `enabled` would only delay the same message to a worse moment: the
  // operator would re-enable the output expecting it to work, on the
  // strength of a config that had gone on loading without complaint.
  const srt = camera.outputs.find((o) => o.kind === "srt");
  if (srt !== undefined) {
    return `this device cannot serve SRT yet: the output on port ${srt.port} would listen with no password on it (R-VID-06). Remove it, or use an RTSP output, which carries this device's own credential`;
  }

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
  const preview = previewSize(camera.preview);
  if (preview.width > camera.width || preview.height > camera.height) {
    return `the preview is ${preview.width}x${preview.height}, larger than the ${camera.width}x${camera.height} it is scaled from`;
  }

  if (encoderFor(encoder, camera.codec) === null) {
    return `this board has no H.265 encoder — its encoder is ${encoder.detail}; set codec to h264, or run this camera on a board that encodes H.265 (R-CAM-08)`;
  }

  if (capabilities.formats.state !== "present") {
    return "this camera has not answered with any capture format";
  }
  // **`captureRefusal()` and not a comparison of its own** (R-CAM-14). The
  // deck builds its Resolution and Frame rate pickers from `captureSizes()`
  // and the apply route judges a staged draft with this same function, so a
  // size or rate this refuses is one neither of them ever offered — which is
  // the whole difference between a second line of defence and a second
  // opinion. Written twice, the picker would eventually offer a pair only
  // this copy knew to reject, and the operator would meet it as a pipeline
  // that would not start.
  return captureRefusal(capabilities.formats.value, camera);
}
