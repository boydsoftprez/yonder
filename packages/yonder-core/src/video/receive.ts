// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import { RTP_PAYLOAD_TYPE } from "./pipeline.js";

/**
 * The exact receive-side command, in the interface (R-VID-15).
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
 * Pure, and therefore fully testable — which matters because the one thing
 * this must never do is print a command that does not work.
 */
export interface ReceiveFacts {
  readonly camera: Camera;
  /** The address this console session arrived on. */
  readonly address: string;
  /** Every other address this device answers on. */
  readonly alternatives: readonly string[];
  /** Resolved from secrets.yaml, or null before it has been generated. */
  readonly rtspPassword: string | null;
  readonly rtspPort: number;
}

export interface Rendering {
  readonly kind: "gstreamer" | "dialog" | "appsink" | "url";
  readonly title: string;
  readonly body: string;
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
} as const;

export function renderReceive(facts: ReceiveFacts): Rendering[] {
  const { camera, address, alternatives, rtspPassword, rtspPort } = facts;
  const c = CODEC[camera.codec];
  const rtp = camera.outputs.find((o) => o.kind === "rtp");
  const rtsp = camera.outputs.find((o) => o.kind === "rtsp");
  const port = rtp?.port ?? 5600;

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
    },
    {
      kind: "dialog",
      title: "A ground station's own video settings",
      body: [
        `Video source:    UDP`,
        `Listen port:     ${port}`,
        `Codec:           ${camera.codec.toUpperCase()}`,
        `Picture:         ${camera.width}x${camera.height} at ${camera.framerate} fps`,
        `Bitrate:         ${(camera.bitrate_kbps / 1000).toFixed(1)} Mb/s`,
        ``,
        `This device also answers on: ${alternatives.length ? alternatives.join(", ") : "no other address"}`,
      ].join("\n"),
    },
    {
      kind: "appsink",
      title: "A pipeline ending in an application sink",
      body:
        `udpsrc port=${port} caps="${caps}" ` +
        `! rtpjitterbuffer latency=100 ! ${c.depay} ! ${c.parse} ! ${c.decode} ` +
        `! videoconvert ! video/x-raw,format=BGRA ! appsink name=sink emit-signals=true sync=false`,
    },
    {
      kind: "url",
      title: "An RTSP URL",
      body: rtsp === undefined || rtsp.kind !== "rtsp"
        ? "This camera has no RTSP output configured. Add one in Setup to receive over RTSP."
        : rtspPassword === null
          ? `rtsp://yonder:<password>@${address}:${rtspPort}/${rtsp.path}\n\n` +
            "This device's RTSP password is not yet generated; it is created the first " +
            "time the media server is configured."
          : `rtsp://yonder:${rtspPassword}@${address}:${rtspPort}/${rtsp.path}`,
    },
  ];
}
