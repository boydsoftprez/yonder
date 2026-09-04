// SPDX-License-Identifier: GPL-3.0-or-later
import { WEBRTC_PORT } from "../media/config.js";

/**
 * The browser's picture, behind the interface's own credential (R-SEC-13).
 *
 * The media server listens on its own ports and the console's password is
 * checked on the console's port, so nothing in the interface's authentication
 * touches the media server. Without this route, M4's exit criterion — usable
 * video *from another network*, meaning over the mesh — is met by a picture
 * anyone on the overlay can watch without logging in.
 *
 * **Only the handshake is proxied.** Setting up a WebRTC stream begins with
 * one small HTTP exchange: the browser posts an SDP offer, the server answers,
 * and the keys that encrypt the video are carried in it. This forwards *that
 * exchange* and nothing else. The video itself flows directly from the media
 * server to the browser over UDP and stays fast — proxying it would put a
 * Node process in the path of every frame, which is the one thing this design
 * cannot afford. Somebody who cannot log in never obtains the keys, and
 * therefore cannot watch.
 *
 * mediamtx's WebRTC listener is bound to loopback (media/config.ts), and that
 * was probed from a second machine rather than assumed, so there is no way
 * round this route rather than merely a discouragement from taking one.
 *
 * **R-SEC-12 holds.** This forwards an HTTP request. The console still cannot
 * start, stop or reconfigure the media server.
 */
export const WHEP_PREFIX = "/video";

/**
 * A media path: the same shape the schema allows a camera id, plus -preview.
 *
 * Stated here rather than imported from the schema, and the module graph is
 * why: this file is reached from `wiring.ts`, which a generated `settings.js`
 * requires at Node-RED start-up, and the schema would bring zod with it. The
 * two are checked against each other by hand — a camera id is 32 characters
 * of the same alphabet, and `-preview` is eight more.
 */
const MEDIA_PATH = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WhepOptions {
  /** Injected so a test never opens a socket. */
  fetch?: typeof globalThis.fetch;
  webrtcPort?: number;
}

export interface WhepRequest {
  method: string;
  path: string;
  body: string;
  authenticated: boolean;
}

export interface WhepResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export function whepHandler(opts: WhepOptions = {}): (req: WhepRequest) => Promise<WhepResponse> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const port = opts.webrtcPort ?? WEBRTC_PORT;

  return async (req) => {
    if (req.method !== "POST") return { status: 405, body: "only POST is used to set up a stream" };
    // The credential check comes before anything reads the body, so an
    // unauthenticated request cannot make this process do work either.
    if (!req.authenticated) return { status: 401, body: "log in to watch this camera" };

    const rest = req.path.slice(WHEP_PREFIX.length + 1);
    const [name, verb] = rest.split("/");
    // The proxy target is built from the request path, so this is the one
    // place a traversal could reach something that is not a stream. Matched
    // against a pattern rather than filtered for `..`, because a filter is a
    // list of the tricks somebody thought of.
    if (verb !== "whep" || !MEDIA_PATH.test(name ?? "")) {
      return { status: 404, body: "no such camera stream" };
    }

    let answer: Response;
    try {
      answer = await doFetch(`http://127.0.0.1:${port}/${name}/whep`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: req.body,
      });
    } catch {
      // The reason matters: a camera that is configured but not started, a
      // media server that is not running, and a browser blocked by a network
      // all present as no picture, and only one of them is worth walking
      // outside for.
      return { status: 503, body: "the media server is not answering; is the camera started?" };
    }

    return {
      status: answer.status,
      body: await answer.text(),
      // The media server's `location` names a session resource on a port no
      // browser can reach, so it is rewritten to this route rather than
      // relayed. The session id it carried is dropped with it: the only
      // method proxied is the POST above, so there is nothing for a browser
      // to send back there.
      headers: {
        "content-type": answer.headers.get("content-type") ?? "application/sdp",
        ...(answer.headers.has("location")
          ? { location: `${WHEP_PREFIX}/${name}/whep` }
          : {}),
      },
    };
  };
}
