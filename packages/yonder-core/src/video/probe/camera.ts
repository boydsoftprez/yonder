// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../../net/runner.js";
import {
  noCapabilities, present, type CameraCapabilities, type ControlRange,
} from "../capability.js";
import { parseControls, parseDevices, parseFormats } from "./parse.js";
import { byPathNames, systemByPath, type ByPathReader } from "./bypath.js";

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
  /**
   * The socket, not the enumeration number (R-CAM-05) — the name under
   * `/dev/v4l/by-path/` that means this node, which is what a configuration
   * stores and what survives a reboot and a plug-order change. `bypath.ts`
   * records how one name is chosen when the kernel publishes several.
   */
  readonly byPath: string;
  /**
   * Whether `byPath` above is a real by-path name or the enumeration number
   * it fell back to.
   *
   * **False is a fact worth showing, not a detail to hide.** A camera with no
   * entry under `/dev/v4l/by-path/` can still be streamed from today, but its
   * identity moves the next time the kernel probes in a different order, and
   * the configuration written now will point somewhere else. Reporting that
   * as an ordinary `byPath` — a string that looks exactly as authoritative as
   * a real one — is the silent absence R-UI-15 exists to forbid.
   */
  readonly byPathStable: boolean;
  readonly capabilities: CameraCapabilities;
}
export interface DetectResult {
  readonly found: Detection[];
  readonly rejected: Rejection[];
}

export interface ProbeOptions {
  runner?: CommandRunner;
  /**
   * The `/dev/v4l/by-path/` listing, injected so a test resolves names from
   * the recorded directory without a `/dev` tree.
   *
   * The seam is the directory *reader*, and deliberately not the resolver:
   * choosing one name from the several the kernel publishes is the part
   * R-CAM-05 turns on, so it must not be the part a test stands in for.
   * Unset means the real directory, which is the whole point — an option only
   * ever supplied by a test leaves the requirement unmet on the board.
   */
  byPath?: ByPathReader;
}

/** Formats that carry compressed video, and are therefore flyable (R-CAM-02). */
const COMPRESSED = new Set(["MJPG", "JPEG", "H264", "HEVC"]);

/** Words a driver uses for a codec function. Whole words only — see below. */
const CODEC_WORD = /^(codec|decoder?|encoder?|isp|hevc)$/i;

/**
 * Whether this card is one of the board's own codec blocks rather than a
 * camera (K-40).
 *
 * A hardware codec advertises formats it cannot capture, so it looks like a
 * camera to everything that asks, cannot be started, and without a stated
 * reason simply would not appear — sending an operator to look for the camera
 * that vanished (R-CAM-12).
 *
 * **Two conditions, and the second is what makes it safe.** A codec's card is
 * a *driver name*: `bcm2835-codec-decode`, `bcm2835-isp`, `rpi-hevc-dec`, all
 * recorded from this board. A camera's card is a *product name* somebody
 * wrote for a person to read, and it has spaces in it. So a card carrying
 * whitespace is a camera whatever letters are in it, and a driver name is a
 * codec only when one of its whole words is one — `bcm2835-isp` splits to
 * `bcm` and `isp`, and `rkisp1_mainpath` to `rkisp` and `mainpath`.
 *
 * The pattern this replaces was an unanchored substring list, and it rejected
 * genuine cameras **as codecs**, with a reason that was actively false:
 *
 *   - `Studio Display`, `LG Display Camera` — D-**isp**-lay
 *   - `USB Camera (H.264 Encoder)` — a camera advertising its own encoder,
 *     which is precisely the compressed source R-CAM-02 wants
 *   - `rkisp1_mainpath` — the CSI capture node on Rockchip, which is the
 *     Radxa boards the roadmap names as a target
 *
 * **The two error directions are not symmetric, and that is why this errs
 * towards letting a card through.** A codec wrongly accepted reaches format
 * probing and is rejected there with a true sentence — it offers no capture
 * format, or only raw ones. A camera wrongly rejected is invisible, and the
 * operator is told a false reason for it.
 */
export function isHardwareCodec(card: string): boolean {
  if (/\s/.test(card)) return false;
  return card.split(/[^A-Za-z]+/).some((word) => CODEC_WORD.test(word));
}

/**
 * The by-path map for one sweep: the injected listing, or the real directory.
 *
 * Read once and passed down rather than resolved per node — sixteen nodes on
 * this board, and the directory does not change while we walk them.
 */
const resolveNames = (opts: ProbeOptions): ReadonlyMap<string, string> =>
  byPathNames(opts.byPath?.() ?? systemByPath());

/**
 * V4L2 control names this page draws, mapped to the capability they fill.
 *
 * **Exported so `video/controls.ts` can be checked against it.** That file
 * writes these same three image controls back to the device, under its own
 * `CONTROL_NAMES`; the two are maintained by hand rather than one deriving
 * the other, so a test cross-checks them — a control probed under one name
 * and set under another is a silent split that would otherwise surface only
 * as a page whose value never moves.
 *
 * `rotate` is here despite most UVC cameras not implementing it, for the
 * same reason `zoom_absolute` and the rest are: absence is what
 * `noCapabilities()` already means, so an unmatched name simply stays
 * `not-offered` rather than needing a special case (R-CTL-05).
 */
export const CONTROL_MAP = [
  ["brightness", "brightness"],
  ["contrast", "contrast"],
  ["rotate", "rotation"],
  ["zoom_absolute", "zoom"],
  ["focus_absolute", "focus"],
  ["exposure_time_absolute", "exposure"],
  ["white_balance_temperature", "whiteBalance"],
] as const;

export async function detectCameras(opts: ProbeOptions = {}): Promise<DetectResult> {
  const runner = opts.runner ?? systemRunner;
  const found: Detection[] = [];
  const rejected: Rejection[] = [];

  const names = resolveNames(opts);

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
      outcomes.push(await probeNode(node, device.card, runner, names));
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
  byPath: ReadonlyMap<string, string>,
): Promise<Detection | Rejection> {
  // K-40, checked by card rather than by node number: the decoder is
  // /dev/video10 on this board and need not be on another, but a codec
  // announces itself as one in its driver name. `isHardwareCodec` above holds
  // the rule and the evidence for it.
  if (isHardwareCodec(card)) {
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

  // No entry is a fallback to the node, and the fallback is reported rather
  // than blended in: see `byPathStable` above.
  const stable = byPath.get(node);
  return {
    device: node,
    card,
    byPath: stable ?? node,
    byPathStable: stable !== undefined,
    capabilities,
  };
}

/** One camera, re-probed — the Setup deck's *Re-probe* key. */
export async function probeCamera(
  node: string,
  card: string,
  opts: ProbeOptions = {},
): Promise<Detection | Rejection> {
  return probeNode(node, card, opts.runner ?? systemRunner, resolveNames(opts));
}
