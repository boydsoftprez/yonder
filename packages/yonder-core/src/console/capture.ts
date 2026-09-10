// SPDX-License-Identifier: GPL-3.0-or-later
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { cameraFor, STILL_AGE_HEADER, STILL_AT_HEADER } from "../video/media-path.js";

/**
 * A capture's bytes, on their way from the daemon to a browser (R-CAM-18,
 * R-SEC-13).
 *
 * R-CAM-18 says a still the board holds *can be viewed, downloaded and
 * deleted*. The listing and the delete are JSON and travel the way every
 * other console message does; the bytes cannot. `GET /cameras/:id/captures/
 * :name` answers a JPEG or a Matroska file on a Unix socket, and a browser
 * has no way to open one — so without this route the captures panel draws
 * three keys of which one works, which is exactly the surface CLAUDE.md rule
 * 7 says must not ship.
 *
 * **Piped, not buffered.** The answer is handed back as the daemon's own
 * response stream and the middleware pipes it to the browser, so a recording
 * does not become a second whole copy in this process's heap on a board with
 * a gigabyte of RAM. (The daemon reads the file into memory to serve it —
 * `video/recorder.ts`'s own `fetch()` — so there is one copy either way; this
 * declines to make it two.) It is also why `DaemonClient` is not used here:
 * that client is JSON, buffers to a 1 MB cap and would corrupt every byte
 * above 0x7f on the way through `toString("utf8")`.
 *
 * **Nothing here decides whether a capture may be served.** The daemon owns
 * that: it refuses a camera-held capture with the reason, and a name that is
 * not one of its own with a 404 (`daemon/routes.ts`'s `captureRoute`). This
 * relays a status and a body, exactly as `whep.ts` relays the media server's.
 *
 * **The one thing it does decide is that a path is a path.** The camera id
 * and the capture name both come off a URL and both become part of the
 * request line to the daemon, so each is matched against a pattern before it
 * is used for anything — the same rule, for the same reason, that `whep.ts`
 * states for `MEDIA_PATH`: a pattern, not a filter for `..`, because a filter
 * is a list of the tricks somebody thought of. The daemon matches the name
 * again where it means a file, which is where it must be right.
 *
 * **A still is relayed the same way, by the same code** (R-VID-14, R-VID-11).
 * `GET /cameras/:id/still` is the daemon's other route that answers bytes,
 * and it differs in three things only: it names no file, it names the viewer
 * it is for — so the daemon counts the copy against the browser that
 * fetched it — and it carries the frame's age in two headers this relay
 * copies through. One relay under both, so a picture and a photograph cannot
 * come to be proxied by two mechanisms that fail differently.
 */

/** A camera id: the shape `schema/config.ts` allows one. */
const CAMERA_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A capture name, as `video/recorder.ts`'s own `SAFE_CAPTURE_NAME`.
 *
 * Written out rather than imported, and the module graph is why: this file is
 * reached from `wiring.ts`, which a generated `settings.js` requires at
 * Node-RED start-up, and `recorder.ts` brings the config schema — and
 * therefore zod, and yaml — with it. `whep.ts` records the identical trade
 * for `MEDIA_PATH` in its own words. The two are checked against each other
 * by `capture.test.ts`, which imports both and asserts they are the same
 * pattern, so "by hand" here means "by a test" rather than "by memory".
 */
const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** How long to wait for the daemon's first byte before giving up. */
export const CAPTURE_TIMEOUT_MS = 10_000;

export interface CaptureRequest {
  /** The media path the browser asked on — `elp`, or `elp-preview`. */
  readonly camera: string;
  /** The capture name, already percent-decoded by the caller. */
  readonly name: string;
}

export interface CaptureAnswer {
  readonly status: number;
  readonly contentType: string;
  /**
   * The bytes, as a stream to pipe, or a sentence to send as text.
   *
   * Two shapes rather than one because the two cases genuinely differ: a
   * capture is arbitrarily large and must not be buffered, and a refusal is
   * one line this file composed and has no stream for.
   */
  readonly body: NodeJS.ReadableStream | string;
  /**
   * Headers the daemon sent that the browser needs — a still's `at` and its
   * age (R-VID-14). Absent on a capture, which carries no fact a JPEG
   * cannot hold, and on every refusal.
   */
  readonly headers?: Record<string, string>;
}

export type CaptureHandler = (req: CaptureRequest) => Promise<CaptureAnswer>;

export interface StillRequest {
  /** The camera id, already stripped of any `-preview` by `stillRequestFor`. */
  readonly camera: string;
  /** Which browser this copy is for — `viewerFor(token)`, never a body field. */
  readonly viewer: string;
}

export type StillHandler = (req: StillRequest) => Promise<CaptureAnswer>;

/** A viewer id, as `daemon/routes.ts` issues and checks one. */
const VIEWER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function refused(status: number, line: string): CaptureAnswer {
  return { status, contentType: "text/plain; charset=utf-8", body: line };
}

/**
 * The real handler: one GET over the daemon's own socket, relayed.
 *
 * Never rejects. This runs inside a Node-RED middleware, and an unhandled
 * rejection there is a console that falls over — the same rule `client.ts`
 * states for itself, applied to a transport it cannot use.
 */
export function captureHandler(socketPath: string, timeoutMs = CAPTURE_TIMEOUT_MS): CaptureHandler {
  return (req) => {
    if (!CAMERA_ID.test(req.camera) || !CAPTURE_NAME.test(req.name)) {
      return Promise.resolve(refused(404, "that is not a capture on this device"));
    }
    return relay(socketPath, timeoutMs, `/cameras/${req.camera}/captures/${encodeURIComponent(req.name)}`, []);
  };
}

/**
 * The still relay: one GET over the daemon's own socket, the viewer on the
 * query so the copy is counted against the browser it is for (R-VID-11),
 * and the frame's age carried through (R-VID-14).
 *
 * The same two guards as the capture's, for the same reason: the camera id
 * becomes part of a request line, and so does the viewer id.
 */
export function stillHandler(socketPath: string, timeoutMs = CAPTURE_TIMEOUT_MS): StillHandler {
  return (req) => {
    if (!CAMERA_ID.test(req.camera)) {
      return Promise.resolve(refused(404, "that is not a camera on this device"));
    }
    if (!VIEWER_ID.test(req.viewer)) {
      return Promise.resolve(refused(404, "that is not a viewer this device would have issued"));
    }
    return relay(
      socketPath, timeoutMs,
      `/cameras/${req.camera}/still?viewer=${encodeURIComponent(req.viewer)}`,
      [STILL_AT_HEADER, STILL_AGE_HEADER],
    );
  };
}

/**
 * One GET to the daemon, answered as a stream to pipe — never rejecting,
 * for the reason `captureHandler` gives. `carry` names the headers the
 * browser needs beside the bytes; everything else the daemon sent stays on
 * this side of the relay.
 */
function relay(
  socketPath: string, timeoutMs: number, path: string, carry: readonly string[],
): Promise<CaptureAnswer> {
  return new Promise<CaptureAnswer>((resolve) => {
    let settled = false;
    const answer = (a: CaptureAnswer): void => {
      if (settled) return;
      settled = true;
      resolve(a);
    };
    const outgoing = request(
      { socketPath, method: "GET", path },
      (incoming: IncomingMessage) => {
        const headers: Record<string, string> = {};
        for (const name of carry) {
          const value = incoming.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        answer({
          status: incoming.statusCode ?? 502,
          contentType: String(incoming.headers["content-type"] ?? "application/octet-stream"),
          body: incoming,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        });
      },
    );
    // A daemon that accepts the connection and then never answers is the
    // failure a socket error does not cover, and the one that would otherwise
    // leave a browser waiting for ever on an image that never arrives.
    outgoing.setTimeout(timeoutMs, () => {
      outgoing.destroy(new Error("timed out"));
    });
    outgoing.on("error", () => {
      answer(refused(503, "the device's configuration service is not answering"));
    });
    outgoing.end();
  });
}

/**
 * `/video/<camera>/captures/<name>` — the path, taken apart.
 *
 * `null` for anything that is not one, including a name whose percent escapes
 * are malformed: that is not a name, and it is refused as one rather than
 * throwing out of the middleware that called this.
 */
export function captureRequestFor(path: string): CaptureRequest | null {
  const match = /^\/video\/([^/]+)\/captures\/([^/]+)$/.exec(path);
  if (match === null) return null;
  let name: string;
  let camera: string;
  try {
    camera = decodeURIComponent(match[1] as string);
    name = decodeURIComponent(match[2] as string);
  } catch {
    return null;
  }
  return { camera, name };
}

/**
 * `/video/<camera>/still` — the path, taken apart (R-VID-14).
 *
 * The exact inverse of `video/media-path.ts`'s `stillUrl`, and `cameraFor`
 * is applied on the way in for the same reason the viewer-report route
 * applies it: a picture holding a stream path asks about the camera that
 * path is of, and `cam0-preview` and `cam0` are one camera.
 */
export function stillRequestFor(path: string): { readonly camera: string } | null {
  const match = /^\/video\/([^/]+)\/still$/.exec(path);
  if (match === null) return null;
  try {
    return { camera: cameraFor(decodeURIComponent(match[1] as string)) };
  } catch {
    return null;
  }
}
