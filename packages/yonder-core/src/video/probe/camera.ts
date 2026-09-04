// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../../net/runner.js";
import {
  noCapabilities, present, type CameraCapabilities, type ControlRange,
} from "../capability.js";
import { parseControls, parseDevices, parseFormats } from "./parse.js";

/**
 * Detection on demand (R-CAM-12).
 *
 * **A rejection is a value.** "What was found, what was rejected and why" is
 * the requirement, and a thrown exception carries none of the third. Every
 * failure in this file becomes a `Rejection` with a sentence an operator can
 * act on, and the Cameras page renders both lists.
 *
 * Two rejections this bench produces today:
 *
 *   - `/dev/video10` is the board's JPEG *decoder*. It advertises MJPEG,
 *     cannot be started (K-40), and looks like a camera to everything that
 *     asks. Without a stated reason it simply would not appear, and an
 *     operator would go looking for the camera that vanished.
 *   - A camera offering raw frames only. R-CAM-02 is compressed sources; raw
 *     at 5 fps is not a flyable picture, and the software JPEG decode that
 *     dominates this pipeline has nothing to decode.
 */
export interface Rejection {
  readonly device: string;
  readonly card: string;
  readonly reason: string;
}
export interface Detection {
  readonly device: string;
  readonly card: string;
  /** The socket, not the enumeration number (R-CAM-05). */
  readonly byPath: string;
  readonly capabilities: CameraCapabilities;
}
export interface DetectResult {
  readonly found: Detection[];
  readonly rejected: Rejection[];
}

export interface ProbeOptions {
  runner?: CommandRunner;
  /** Injected so a test resolves by-path names without a /dev tree. */
  readLink?: (path: string) => string | null;
}

/** Formats that carry compressed video, and are therefore flyable (R-CAM-02). */
const COMPRESSED = new Set(["MJPG", "JPEG", "H264", "HEVC"]);

/** V4L2 control names this page draws, mapped to the capability they fill. */
const CONTROL_MAP = [
  ["brightness", "brightness"],
  ["contrast", "contrast"],
  ["zoom_absolute", "zoom"],
  ["focus_absolute", "focus"],
  ["exposure_time_absolute", "exposure"],
  ["white_balance_temperature", "whiteBalance"],
] as const;

export async function detectCameras(opts: ProbeOptions = {}): Promise<DetectResult> {
  const runner = opts.runner ?? systemRunner;
  const found: Detection[] = [];
  const rejected: Rejection[] = [];

  const listed = await runner(["v4l2-ctl", "--list-devices"]);
  if (listed.code !== 0) {
    return {
      found,
      rejected: [{
        device: "", card: "",
        reason: `v4l2-ctl could not list devices: ${listed.stderr.trim() || `exit ${listed.code}`}`,
      }],
    };
  }

  for (const device of parseDevices(listed.stdout)) {
    // **A card yields at most one row.** A UVC camera owns two nodes — the
    // capture node and a metadata node that answers `Type: Video Capture` with
    // no formats beneath it. Probing node by node puts a rejection beside the
    // camera that was just found, which on the Cameras page reads as
    // "something went wrong with your camera" when nothing did. R-UI-15 is
    // about capabilities on a camera's page, not about every /dev node the
    // kernel created.
    const outcomes: (Detection | Rejection)[] = [];
    for (const node of device.nodes) {
      outcomes.push(await probeNode(node, device.card, runner, opts.readLink));
    }
    const accepted = outcomes.find((o): o is Detection => "capabilities" in o);
    if (accepted) found.push(accepted);
    else if (outcomes.length > 0) rejected.push(outcomes[0] as Rejection);
  }
  return { found, rejected };
}

async function probeNode(
  node: string,
  card: string,
  runner: CommandRunner,
  readLink?: (path: string) => string | null,
): Promise<Detection | Rejection> {
  // K-40, checked by card rather than by node number: the decoder is
  // /dev/video10 on this board and need not be on another, but a codec always
  // announces itself as one.
  //
  // `decode|encode|hevc` and not `decoder`: this board carries an
  // `rpi-hevc-dec` card that matches none of the obvious words, and letting it
  // through means an operator reads "this camera offers only raw frames" about
  // a hardware HEVC decoder — a true sentence that sends them looking for a
  // camera setting that does not exist.
  if (/codec|decode|encode|isp|hevc/i.test(card)) {
    return {
      device: node, card,
      reason: `${card} is a hardware codec on this board, not a camera; it advertises formats it cannot capture (K-40)`,
    };
  }

  const formats = await runner(["v4l2-ctl", "-d", node, "--list-formats-ext"]);
  if (formats.code !== 0) {
    return {
      device: node, card,
      reason: `could not read this device's formats: ${formats.stderr.trim() || `exit ${formats.code}`}`,
    };
  }
  const parsed = parseFormats(formats.stdout);
  if (parsed.length === 0) {
    return { device: node, card, reason: "this device offered no capture format" };
  }
  const compressed = parsed.filter((f) => COMPRESSED.has(f.fourcc));
  if (compressed.length === 0) {
    return {
      device: node, card,
      reason: `this camera offers only raw frames (${[...new Set(parsed.map((f) => f.fourcc))].join(", ")}); Yonder needs a compressed source (R-CAM-02)`,
    };
  }

  const controls = await runner(["v4l2-ctl", "-d", node, "--list-ctrls-menus"]);
  const ranges: Map<string, ControlRange> =
    controls.code === 0 ? parseControls(controls.stdout) : new Map();

  // Mutable only here, and only over the keys CONTROL_MAP names: writing
  // through the mapped type is what makes the compiler check that a control
  // fills a capability of the matching shape, rather than an Object.assign
  // that would let a ControlRange land in `aim`.
  const capabilities: { -readonly [K in keyof CameraCapabilities]: CameraCapabilities[K] } = {
    ...noCapabilities(),
    formats: present(compressed),
  };
  for (const [v4l2Name, key] of CONTROL_MAP) {
    const range = ranges.get(v4l2Name);
    // Absent is `not-offered`, which noCapabilities() already set. A device
    // that *listed* the control and refused to read it is the `advertised`
    // state, and M5 is where that distinction gets drawn; today v4l2-ctl does
    // not separate the two, and inventing the distinction here would be worse
    // than not drawing it.
    if (range) capabilities[key] = present(range);
  }

  const byPath = readLink?.(node) ?? node;
  return { device: node, card, byPath, capabilities };
}

/** One camera, re-probed — the Setup deck's *Re-probe* key. */
export async function probeCamera(
  node: string,
  card: string,
  opts: ProbeOptions = {},
): Promise<Detection | Rejection> {
  return probeNode(node, card, opts.runner ?? systemRunner, opts.readLink);
}
