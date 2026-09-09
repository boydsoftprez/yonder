// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, CameraOutput } from "../schema/config.js";
import { outputReach, type OutputKind, type ReachPaths } from "./outputs.js";
import type { AddressPath, AnswerableAddress } from "../net/dial-in.js";
import { RTP_PAYLOAD_TYPE } from "./pipeline.js";

/**
 * The stream address — the exact receive-side command, in the interface
 * (R-VID-15, R-UI-24).
 *
 * R-VID-10 makes a ground station configurable from the documentation alone,
 * which is what you need before the device is in front of anyone. This is the
 * stronger form for when you are standing at the console: the command is
 * generated from what the camera is doing at that moment, so nothing needs to
 * be read. Change the codec and the depayloader in the line changes with it.
 *
 * **The address is the one the operator is actually reaching the device on.**
 * A board on a mesh has several and only one of them is in use; the command
 * carries that one and lists the others beneath it rather than guessing.
 *
 * **Every line says whether it can be used right now** (R-UI-24). A line an
 * operator copies, pastes into a ground station and watches do nothing is
 * worse than no line at all: they have no way to tell a mistyped command from
 * a path that cannot carry it. So each rendering carries `usable` and the
 * sentence behind it — from `outputReach()`, which is where that judgement
 * lives — and the console draws the sentence. **It states and never acts**
 * (R-CMD-04): nothing here stops an output, hides a line or recommends a
 * path.
 *
 * Pure, and therefore fully testable — which matters because the one thing
 * this must never do is print a command that does not work.
 */
export interface ReceiveFacts {
  readonly camera: Camera;
  /** The address this console session arrived on. */
  readonly address: string;
  /** Every other address this device answers on. */
  readonly alternatives: readonly string[];
  /**
   * Every address this device answers on, and the path a peer would reach each
   * one over (R-UI-24). See `net/dial-in.ts`.
   *
   * Only the RTSP line uses it, and only the RTSP line needs it: the three UDP
   * renderings carry no address at all, because the ground station listens and
   * this board dials out to it. A listener is the other direction, and an
   * address behind the carrier's NAT is one nothing can reach — so a URL built
   * from "the address this console session arrived on" is wrong precisely when
   * the console is being reached over cellular, which is the flying case
   * R-UI-24 exists for.
   *
   * **A path per address, not a flag**, because the verdict rests on a path:
   * *reachable because of the mesh* is only satisfied by a mesh address, and
   * the access point's — which `activeIpv4()` reports first on every board
   * whose radio is serving — satisfies nothing a `ReachPaths` field is ever
   * true because of.
   */
  readonly answering: readonly AnswerableAddress[];
  /** Resolved from secrets.yaml, or null before it has been generated. */
  readonly rtspPassword: string | null;
  readonly rtspPort: number;
  /**
   * Which ways off this board a peer could use, for `outputReach()`.
   *
   * Required rather than optional, and deliberately: a default here would be
   * a claim about this device's network made by a rendering function, and
   * every line it drew would inherit it. The daemon reads the paths; this
   * only restates what they mean for one output.
   */
  readonly paths: ReachPaths;
}

export interface Rendering {
  readonly kind: "gstreamer" | "dialog" | "appsink" | "url";
  readonly title: string;
  readonly body: string;
  /**
   * Whether a receiver holding this line could use it right now (R-UI-24).
   *
   * Three separate ways it can be false, and the note says which: the output
   * this line is for is not configured, it is configured and stopped, or it
   * is running and no path this device has can carry it.
   */
  readonly usable: boolean;
  /**
   * Why, in an operator's words. States a fact and recommends nothing.
   *
   * **It carries the word *unusable* itself when it is one**, because that is
   * what R-UI-24 asks the console to say and the console cannot compose it:
   * the surface is `flows.json`, and a JSONata expression joining a verdict to
   * a sentence beside a wire coordinate is exactly CLAUDE.md rule 2. `usable`
   * stays beside it as the machine-readable half — the node's status badge
   * counts it — so nothing has to parse this string to learn the verdict.
   */
  readonly note: string;
}

/**
 * The depayloader and decoder for a codec. One place, so they cannot drift.
 *
 * The sending side's element names live in `pipeline.ts`, but that file has
 * nothing to say about a *depayloader* or a *decoder* — it encodes and pays,
 * it never unpays or decodes — so there is no second table here to disagree
 * with. What it does own is the RTP payload type: `RTP_PAYLOAD_TYPE`, below,
 * is imported rather than restated so the two files' numbers cannot drift
 * apart the way their element names have no opportunity to.
 */
const CODEC = {
  h264: { depay: "rtph264depay", parse: "h264parse", decode: "avdec_h264" },
  h265: { depay: "rtph265depay", parse: "h265parse", decode: "avdec_h265" },
} as const;

/**
 * Whether the output a line is for can carry it, and the sentence that says
 * so — the one place all four lines get their verdict from.
 *
 * **`outputReach()` answers only the last of the three questions**, which is
 * the one it was written for: can a peer reach a listener, or leave with an
 * outbound push, over the paths this device has. It knows nothing about
 * whether the output exists in the configuration or has been stopped, and it
 * says so in its own doc comment — "It is not wired to `CameraOutput.enabled`
 * … an output can be enabled and unreachable at once". Both of those are
 * still reasons a copied line does nothing, so they are answered here, before
 * reach, and each with its own sentence: *there is no such output*, *it is
 * stopped*, and *nothing can dial in to it* are three different things for an
 * operator to do something about.
 */
function usability(
  output: CameraOutput | undefined,
  kind: OutputKind,
  paths: ReachPaths,
): { usable: boolean; note: string } {
  const what = kind.toUpperCase();
  /** R-UI-24's own word, in front of the reason, exactly once. */
  const no = (why: string): { usable: false; note: string } =>
    ({ usable: false, note: `unusable — ${why}` });
  if (output === undefined) {
    return no(`this camera has no ${what} output; configure an RTP destination`);
  }
  if (!output.enabled) {
    return no(`this camera's ${what} output is stopped; enable it in Outputs on the Camera page and nothing has to be typed again`);
  }
  const reach = outputReach(kind, paths);
  return reach.reachable ? { usable: true, note: reach.note } : no(reach.note);
}

export function renderReceive(facts: ReceiveFacts): Rendering[] {
  const { camera, address, alternatives, rtspPassword, rtspPort, paths, answering } = facts;
  const c = CODEC[camera.codec];
  const rtp = camera.outputs.find((o) => o.kind === "rtp");
  const rtsp = camera.outputs.find((o) => o.kind === "rtsp");
  const port = rtp?.port ?? 5600;

  // The three UDP renderings are three ways of writing down one output: this
  // device pushing RTP to a ground station. They stand or fall together, so
  // they take one verdict rather than three that could disagree.
  const push = usability(rtp, "rtp", paths);
  const listen = usability(rtsp, "rtsp", paths);

  /**
   * **The address the RTSP URL is built from, and why it is not always the
   * one the console arrived on.**
   *
   * R-VID-15 asks for the address the operator is actually reaching the device
   * on, and for three of the four renderings that is not a question at all —
   * they carry no address. For the fourth it is the whole line, and the
   * requirement's intent is an address that *works*: R-VID-15's own words are
   * "the address the operator is actually reaching the device on", which on a
   * board with several is a proxy for "the one that is live". A peer dialling
   * in is a different question from a browser dialling in, and the two answers
   * differ in exactly one case — the console reached over cellular — where the
   * console's own address is behind the carrier's NAT and no peer can use it.
   *
   * So: **the address is chosen from the path the verdict rests on.** A
   * listener is reachable on a LAN or the mesh (`outputReach`), so the
   * candidates are this device's addresses on whichever of those is actually
   * up; the console's own is preferred when it is one of them, and the first
   * that is otherwise. The access point's address is never a candidate — no
   * `ReachPaths` field is ever true because of it — which is what stops a
   * board whose radio is serving printing `192.168.77.1` under a verdict that
   * rests on the mesh.
   *
   * When there is no candidate the console's own address is printed and the
   * line is marked unusable either way: a URL with an address nobody can
   * reach, plainly labelled, beats a URL with no address at all.
   */
  const rests: AddressPath[] = [
    ...(paths.lan ? ["lan" as const] : []),
    ...(paths.mesh ? ["mesh" as const] : []),
  ];
  const candidates = answering.filter((a) => rests.includes(a.path));
  const chosen = candidates.find((a) => a.address === address) ?? candidates[0];
  /**
   * **And when there is no candidate, still never the modem's.**
   *
   * The line is marked unusable either way, but it prints an address, and the
   * modem's is the one address this device holds that is *known* never to be
   * dialable — an unattributed one merely has nothing established about it.
   * Printing the known-useless one while holding others is the worst choice
   * available, and on a board reached over cellular it is the one
   * `activeIpv4()` reports first.
   */
  const notCellular = (a: string): boolean =>
    !answering.some((x) => x.address === a && x.path === "cellular");
  const listenAt = chosen?.address
    ?? (notCellular(address) ? address : answering.find((a) => a.path !== "cellular")?.address ?? address);
  const substituted = chosen !== undefined && chosen.address !== address;

  const caps =
    `application/x-rtp,media=video,clock-rate=90000,encoding-name=${camera.codec.toUpperCase()},payload=${RTP_PAYLOAD_TYPE}`;

  return [
    {
      kind: "gstreamer",
      title: "A GStreamer command line",
      body: [
        `gst-launch-1.0 -v udpsrc port=${port} caps="${caps}"`,
        `  ! rtpjitterbuffer latency=100 ! ${c.depay} ! ${c.parse} ! ${c.decode}`,
        `  ! videoconvert ! autovideosink sync=false`,
      ].join(" \\\n"),
      ...push,
    },
    {
      kind: "dialog",
      title: "A ground station's own video settings",
      body: [
        // The camera's name first, because a ground station's dialog has one
        // feed in it and the operator filling it in has to know which camera
        // they are pointing it at (R-UI-27). It is the operator's own name,
        // read from the configuration, never a label typed into a page.
        `Camera:          ${camera.name}`,
        `Video source:    UDP`,
        `Listen port:     ${port}`,
        `Codec:           ${camera.codec.toUpperCase()}`,
        `Picture:         ${camera.width}x${camera.height} at ${camera.framerate} fps`,
        `Bitrate:         ${(camera.bitrate_kbps / 1000).toFixed(1)} Mb/s`,
        ``,
        `This device also answers on: ${alternatives.length ? alternatives.join(", ") : "no other address"}`,
      ].join("\n"),
      ...push,
    },
    {
      kind: "appsink",
      title: "A pipeline ending in an application sink",
      body:
        `udpsrc port=${port} caps="${caps}" `
        + `! rtpjitterbuffer latency=100 ! ${c.depay} ! ${c.parse} ! ${c.decode} `
        + `! videoconvert ! video/x-raw,format=BGRA ! appsink name=sink emit-signals=true sync=false`,
      ...push,
    },
    {
      kind: "url",
      title: "An RTSP URL",
      /**
       * **The credential is in the URL, and it has to be.** This device's
       * media server grants anonymous read from loopback only
       * (`media/config.ts`'s `authInternalUsers`, measured against mediamtx
       * on a board): a player dialling in from anywhere else without the
       * credential is answered `401 Unauthorized`, which most players report
       * as nothing at all. So an address printed without it is an address
       * that looks right and silently does not work — worse than saying
       * there is none.
       */
      body: rtsp === undefined || rtsp.kind !== "rtsp"
        ? "This camera has no RTSP output configured. Enable RTSP in Outputs on the Camera page."
        : rtspPassword === null
          ? `rtsp://yonder:<password>@${listenAt}:${rtspPort}/${camera.id}\n\n`
          + "This device's RTSP password is not yet generated; it is created the first "
          + "time the media server is configured."
          : `rtsp://yonder:${rtspPassword}@${listenAt}:${rtspPort}/${camera.id}`,
      // A URL with `<password>` where the credential goes is not a URL
      // anybody can use, whatever the paths say, so an unresolved secret is
      // its own unusable case ahead of reach.
      ...(rtsp !== undefined && rtspPassword === null
        ? {
          usable: false,
          note: "unusable — this device's RTSP password has not been generated yet, "
            + "so there is no URL to copy",
        }
        // **A verdict about the address that is actually printed.** Where the
        // URL had to reach for a different address, the note says which and
        // why, so the sentence and the line under it are about one thing; and
        // a claim that a peer can reach this output while no address is known
        // to be dialable is a claim about nothing, so it is withdrawn rather
        // than left standing over an address that cannot serve it.
        : listen.usable && chosen === undefined
          ? {
            usable: false,
            note: "unusable — this device holds no address on a path a peer could dial in over, "
              + "so there is no URL to hand anyone even though the path itself is up",
          }
          : listen.usable && substituted
            ? {
              usable: true,
              note: `${listen.note}; the URL carries ${listenAt}, this device's address on `
                + `${chosen.path === "mesh" ? "the mesh" : "a local network"}, rather than the one `
                + "this console is being reached on, which no peer can dial in to",
            }
            : listen),
    },
  ];
}
