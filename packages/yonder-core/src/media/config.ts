// SPDX-License-Identifier: GPL-3.0-or-later
import { stringify } from "yaml";
import type { Config } from "../schema/config.js";
import { RTSP_PORT, SRT_PORT, WEBRTC_LOCAL_UDP_PORT, WEBRTC_PORT } from "./ports.js";

/**
 * The media server's configuration, generated from Yonder's (R-SEC-13).
 *
 * **One declarative file is the only writer.** This is generated from
 * config.yaml exactly as the NetworkManager keyfiles are, so there is no
 * second place where a listener could be turned on.
 *
 * **Every listener has a stated posture, and none is reachable by default
 * without one.** The interface's password is checked by the console on the
 * console's port, and nothing in that path touches this server — so without
 * this file, M4's exit criterion of watching video *from another network* is
 * met by a picture anyone on the mesh can watch without logging in.
 *
 *   - **WebRTC** binds to loopback. Setting up a stream begins with one small
 *     HTTP exchange carrying the keys that encrypt the video; the console
 *     proxies *that exchange* behind its own credential, and the video itself
 *     flows directly and stays fast. Somebody who cannot log in never obtains
 *     the keys.
 *   - **RTSP** carries a generated per-device credential, because Mission
 *     Planner and QGroundControl cannot hold a console session. Per device
 *     rather than per camera: a set of them buys the ability to hand out one
 *     camera and not another, which nobody has asked for.
 *   - **SRT** is off unless an output configures it, and carries the same
 *     credential when it is on.
 *   - **RTMP, HLS and MoQ are off.** Nothing in this design uses them.
 *
 * Publishing is loopback-only. The pipeline publishes from this board; a
 * publish path open to the network would be a write path into what the
 * aircraft appears to be sending.
 *
 * **Measured, not assumed.** Every claim above was probed against mediamtx
 * v1.20.1 on a board, from a second machine on its network: RTSP DESCRIBE
 * without the credential answers `401 Unauthorized`, with it `404` (the path
 * exists, nothing is publishing yet); an ANNOUNCE from the network answers
 * `401` even holding the credential, and from loopback `200 OK`; the WebRTC
 * port refuses a connection from anywhere but the board itself.
 */
export interface MediaFacts {
  readonly config: Config;
  /** Resolved from secrets.yaml. Never logged, never in a support bundle. */
  readonly rtspPassword: string;
}

/**
 * The account a ground station is given. One per device (R-SEC-13); the
 * password beside it is generated per device and never a shared default
 * (R-SEC-01).
 */
export const RTSP_USER = "yonder";

/**
 * Who may act without a password, and from where.
 *
 * `any` is mediamtx's anonymous user, and its shipped configuration grants it
 * publish *and* read on every path from every address. Replacing that entry is
 * the single most load-bearing line in this file: leave it as it ships and
 * every listener below is open to the whole mesh whatever else is written
 * here. Narrowed to this board, it is the two things that must not need a
 * credential — the pipeline publishing, and the console's proxy reading the
 * handshake it is about to hand to a browser that has already logged in.
 */
const LOOPBACK = ["127.0.0.1/32", "::1/128"];

export function mediamtxConfig(facts: MediaFacts): string {
  const { config, rtspPassword } = facts;
  const cameras = config.cameras;
  const anySrt = cameras.some((c) => c.outputs.some((o) => o.kind === "srt"));

  // `publisher`, never a URL: mediamtx will otherwise dial out for a source,
  // which would be the aircraft fetching video rather than serving it.
  //
  // A fresh object per path, and not for tidiness. The YAML writer emits one
  // shared object as an anchor and every later use as an alias — `cam0: *a1` —
  // which is a file an operator cannot read at a glance and a construct not
  // every parser resolves. What it would cost is a path with no source at all.
  const fedByThisBoard = (): Record<string, unknown> => ({ source: "publisher" });

  const paths: Record<string, unknown> = {};
  for (const camera of cameras) {
    // The preview always has a path: it is how the browser reaches the
    // picture, and it is the default the interface watches.
    paths[`${camera.id}-preview`] = fedByThisBoard();
    if (camera.outputs.some((o) => o.kind === "rtsp")) {
      paths[camera.id] = fedByThisBoard();
    }
  }

  return stringify({
    logLevel: "info",
    logDestinations: ["stdout"],

    // R-SEC-13, and the whole of it. mediamtx moved authentication out of the
    // paths and into this list; the per-path readUser/readPass/publishIPs it
    // still accepts are deprecated, warned about on every start, and their
    // eventual removal would be an open listener rather than a broken one.
    authMethod: "internal",
    authInternalUsers: [
      { user: "any", ips: LOOPBACK, permissions: [{ action: "publish" }, { action: "read" }] },
      // Reading, and only reading. A ground station holding this may watch
      // what the aircraft sends; it may not replace it.
      { user: RTSP_USER, pass: rtspPassword, ips: [], permissions: [{ action: "read" }] },
    ],

    // R-VID-04. Publishing and reading both happen here; the two entries above
    // are what separates them.
    rtsp: true,
    rtspAddress: `:${RTSP_PORT}`,
    rtspTransports: ["tcp", "udp"],

    // R-VID-03, behind the console. Loopback deliberately: a listener on
    // 0.0.0.0 hands the encryption keys to anyone on the mesh and makes the
    // authenticated route decoration.
    webrtc: true,
    webrtcAddress: `127.0.0.1:${WEBRTC_PORT}`,
    webrtcLocalUDPAddress: `:${WEBRTC_LOCAL_UDP_PORT}`,

    // R-VID-06, and only where something asked for it.
    srt: anySrt,
    srtAddress: `:${SRT_PORT}`,

    // Off. mediamtx offers them; nothing in this design uses them. MoQ is
    // named for a reason the others are not: it did not exist when this file
    // was first written, arrived with `moq: true`, and would have opened
    // :8893 on every interface of every device on the next version bump. A
    // listener nobody decided to open is the failure R-SEC-13 describes, so
    // the answer is to name every one of them rather than to trust a default.
    rtmp: false,
    hls: false,
    moq: false,

    // Not media, and off for the same reason. The API is a write path into
    // what the server is serving; the other three are read paths into what
    // this device is doing.
    api: false,
    metrics: false,
    pprof: false,
    playback: false,

    paths,
  }, { lineWidth: 0 });
}
