// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { whepHandler, WHEP_PREFIX } from "./whep.js";
import { WEBRTC_PORT } from "../media/config.js";

const OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";

/**
 * An arbitrary port, injected, and deliberately not the real one: with the
 * two the same, a handler that ignored `webrtcPort` and a handler that
 * honoured it would pass the same assertions.
 */
const PORT = 18889;

function handler(fetchImpl?: typeof globalThis.fetch) {
  return whepHandler({
    fetch: fetchImpl ?? (vi.fn(async () => new Response(ANSWER, {
      status: 201, headers: { "content-type": "application/sdp", location: "/cam0-preview/whep/abc" },
    })) as unknown as typeof globalThis.fetch),
    webrtcPort: PORT,
  });
}
const post = (path: string, authenticated: boolean) =>
  ({ method: "POST", path, body: OFFER, authenticated });

describe("the WHEP proxy", () => {
  it("refuses an unauthenticated offer", async () => {
    // Without this, M4's exit criterion is met by a picture anyone on the
    // mesh can watch. The video is what the credential is protecting; the
    // handshake is where it is protected.
    const r = await handler()(post(`${WHEP_PREFIX}/cam0-preview/whep`, false));
    expect(r.status).toBe(401);
    expect(r.body).not.toContain("v=0");
  });

  it("asks the media server for nothing at all when nobody is logged in", async () => {
    // The credential is checked before the offer is forwarded, so a caller
    // who cannot log in cannot make this process do work either.
    const fetchImpl = vi.fn(async () => new Response(ANSWER, { status: 201 }));
    await handler(fetchImpl as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, false),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards an authenticated offer to mediamtx on loopback", async () => {
    const fetchImpl = vi.fn(async () => new Response(ANSWER, {
      status: 201, headers: { "content-type": "application/sdp" },
    }));
    const r = await handler(fetchImpl as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(201);
    expect(r.body).toBe(ANSWER);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${PORT}/cam0-preview/whep`);
    expect(init.body).toBe(OFFER);
  });

  it("dials the port the media server is configured to listen on", async () => {
    // Task 9 reworked these ports once already, when WEBRTC_PORT + 1 turned
    // out to be SRT's and mediamtx exited rather than degrading. A restated
    // number here would be a proxy pointing at nothing after the next such
    // move, and a blank picture with no error to explain it.
    const fetchImpl = vi.fn(async () => new Response(ANSWER, { status: 201 }));
    await whepHandler({ fetch: fetchImpl as unknown as typeof globalThis.fetch })(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`http://127.0.0.1:${WEBRTC_PORT}/cam0-preview/whep`);
  });

  it("refuses a path that is not a media path", async () => {
    // The proxy target is built from the request path, so this is the one
    // place a traversal could reach something other than a stream.
    for (const bad of ["../admin", "cam0/../../etc", "a b", "cam0%2f.."]) {
      const r = await handler()(post(`${WHEP_PREFIX}/${bad}/whep`, true));
      expect(r.status, bad).toBe(404);
    }
  });

  it("answers a mediamtx that is not running with a reason, not a stack trace", async () => {
    const dead = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = await handler(dead as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(503);
    expect(r.body).toContain("media server");
  });

  it("passes a 404 from mediamtx through as a 404", async () => {
    // A camera that is configured but not started has no path yet. The page
    // must be able to tell that apart from "you are not logged in".
    const none = vi.fn(async () => new Response("stream not found", { status: 404 }));
    const r = await handler(none as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(404);
  });

  it("handles only the one method WHEP needs", async () => {
    const r = await handler()({ method: "GET", path: `${WHEP_PREFIX}/cam0-preview/whep`, body: "", authenticated: true });
    expect(r.status).toBe(405);
  });
});
