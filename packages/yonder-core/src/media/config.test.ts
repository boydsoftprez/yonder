// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mediamtxConfig } from "./config.js";
import { SRT_PORT, WEBRTC_LOCAL_UDP_PORT } from "./ports.js";
import { ConfigSchema } from "../schema/config.js";

const base = {
  version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { port: 3000, editor: {} },
};
const withCamera = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({
  ...base,
  cameras: [{
    id: "cam0", name: "Nose", source: "usb", device: "usb-1",
    outputs: [{ kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } }],
    ...extra,
  }],
});
const PASSWORD = "Kx7-mfPq-2Rn4";
const yaml = (cfg = withCamera()) => parse(mediamtxConfig({ config: cfg, rtspPassword: PASSWORD }));

/** One entry of `authInternalUsers`, as the server reads it. */
interface AuthUser {
  user: string;
  pass?: string | null;
  ips: string[];
  permissions: { action: string; path?: string }[];
}
const users = (y: { authInternalUsers: AuthUser[] }): AuthUser[] => y.authInternalUsers;
const may = (u: AuthUser, action: string) => u.permissions.some((p) => p.action === action);
/** True when this entry needs no password: `any` is mediamtx's anonymous user. */
const anonymous = (u: AuthUser) => u.user === "any";

describe("mediamtxConfig", () => {
  it("switches off every protocol nothing in the configuration uses", () => {
    // A listener that exists for no reason is a listener nobody is watching.
    const y = yaml();
    expect(y.rtmp).toBe(false);
    expect(y.hls).toBe(false);
    expect(y.srt).toBe(false);
    // MoQ arrived with the server, not with this design: v1.20.1 ships
    // `moq: true` and opens :8893 on every interface. R-SEC-13 is about
    // listeners, not about the ones that happened to exist when it was
    // written, so every one of them is named here rather than left to a
    // default that a version bump can turn on underneath us.
    expect(y.moq).toBe(false);
  });

  it("leaves no control surface listening either", () => {
    // These four are off in the server's own defaults today. They are stated
    // anyway for the reason `moq` proves: a default is a decision somebody
    // else gets to change, and the API is a write path into what the aircraft
    // is serving.
    const y = yaml();
    expect(y.api).toBe(false);
    expect(y.metrics).toBe(false);
    expect(y.pprof).toBe(false);
    expect(y.playback).toBe(false);
  });

  it("never turns the SRT server on, not even for an SRT output (R-SEC-13)", () => {
    // It used to, and the credential it claimed to carry protected nothing:
    // the pipeline's own `srtsink` bound 0.0.0.0:<port> with no passphrase,
    // outside this server and outside `authInternalUsers` altogether, so this
    // file opened a second listener that nothing ever published to.
    // `video/pipeline.ts` refuses the output until R-VID-06 gives SRT a
    // posture; until then this server does not listen for it.
    expect(yaml(withCamera({ outputs: [{ kind: "srt", port: 9998 }] })).srt).toBe(false);
  });

  it("binds WebRTC to loopback, because the console proxies its handshake", () => {
    // R-SEC-13: the exchange that carries the encryption keys goes through
    // one authenticated route. A WebRTC listener on 0.0.0.0 would hand the
    // keys to anyone on the mesh and make that route decoration.
    expect(yaml().webrtcAddress).toMatch(/^127\.0\.0\.1:/);
  });

  it("keeps WebRTC's media port off SRT's, or neither server starts", () => {
    // Measured on a board. WebRTC's ICE port and SRT are both UDP, so putting
    // the first at webrtc+1 collides with SRT's 8890 the moment an operator
    // configures an SRT output — and mediamtx does not degrade, it exits:
    //
    //     ERR listen: listen udp :8890: bind: address already in use
    //     INF [WebRTC] closing
    //
    // which is the whole media server gone, on the apply that added one
    // output. The signalling port is loopback and the media port is not, so
    // they are two separate numbers and neither may be derived from the other.
    expect(WEBRTC_LOCAL_UDP_PORT).not.toBe(SRT_PORT);
    const y = yaml();
    expect(y.webrtcLocalUDPAddress).toBe(`:${WEBRTC_LOCAL_UDP_PORT}`);
    expect(y.srtAddress).toBe(`:${SRT_PORT}`);
    expect(y.webrtcLocalUDPAddress).not.toBe(y.srtAddress);
  });

  it("lets nobody read from the network without the generated credential", () => {
    // R-SEC-13. The server ships an anonymous user with read and publish on
    // every path from every address; a configuration that does not replace it
    // is a picture anyone on the mesh can watch without logging in, which is
    // exactly what this file exists to prevent.
    for (const u of users(yaml())) {
      if (anonymous(u) && may(u, "read")) {
        expect(u.ips).toEqual(["127.0.0.1/32", "::1/128"]);
      }
    }
    const credentialed = users(yaml()).filter((u) => !anonymous(u) && may(u, "read"));
    expect(credentialed).toHaveLength(1);
    expect(credentialed[0].user).toBe("yonder");
    expect(credentialed[0].pass).toBe(PASSWORD);
    // Read from anywhere, because a ground station is not on this board.
    expect(credentialed[0].ips).toEqual([]);
    // R-SEC-01: no shared default that protects the vehicle or its data.
    expect(credentialed[0].pass).not.toMatch(/yonder|admin|password|changeme/i);
  });

  it("gives the credential reading and nothing else", () => {
    // A ground station holding this may watch. It may not replace what the
    // aircraft appears to be sending, and it may not reach the API.
    const yonder = users(yaml()).find((u) => u.user === "yonder");
    expect(yonder?.permissions.map((p) => p.action)).toEqual(["read"]);
  });

  it("publishes from loopback only, so nothing outside can inject a stream", () => {
    // R-SEC-04's spirit: the pipeline publishes over loopback. A publish path
    // open to the network is a write path into what the aircraft appears to
    // be sending.
    const publishers = users(yaml()).filter((u) => may(u, "publish"));
    expect(publishers).toHaveLength(1);
    expect(publishers[0].ips).toEqual(["127.0.0.1/32", "::1/128"]);
  });

  it("uses none of the per-path credentials the server has deprecated", () => {
    // v1.20.1 still honours readUser/readPass/publishIPs and says so on every
    // start: "you are using one or more authentication-related deprecated
    // parameters". A posture built on those is a posture with a removal date,
    // and the failure mode of a silently-dropped key here is an open listener.
    const text = mediamtxConfig({ config: withCamera(), rtspPassword: PASSWORD });
    for (const key of ["readUser", "readPass", "readIPs", "publishUser", "publishPass", "publishIPs"]) {
      expect(text).not.toContain(key);
    }
  });

  it("declares a path for the cheap preview as well as the full stream", () => {
    const y = yaml();
    expect(Object.keys(y.paths).sort()).toEqual(["cam0", "cam0-preview"]);
  });

  it("declares no catch-all path, so nothing may invent one", () => {
    // A path the configuration does not name is refused outright — measured
    // on a board, an ANNOUNCE to an undeclared path answers 400. `all_others`
    // is the entry that would undo that.
    expect(Object.keys(yaml().paths)).not.toContain("all_others");
  });

  it("declares no path at all for a camera with no RTSP output", () => {
    const y = yaml(withCamera({ outputs: [{ kind: "rtp", host: "192.168.1.50", port: 5600 }] }));
    // The preview still needs a path — that is how the browser reaches it —
    // but the full-rate stream is not published where nobody asked for it.
    expect(Object.keys(y.paths)).toEqual(["cam0-preview"]);
  });

  it("spells every path out, rather than aliasing one back to another", () => {
    // The YAML writer turns a shared object into an anchor and an alias —
    // `cam0-preview: &a1` … `cam0: *a1`. mediamtx resolves those, but an
    // operator reading /etc/mediamtx/mediamtx.yml cannot, and a parser that did
    // not would leave a path with no source at all.
    const text = mediamtxConfig({ config: withCamera(), rtspPassword: PASSWORD });
    expect(text).not.toMatch(/&\w+\n/);
    expect(text).not.toMatch(/\*\w+/);
  });

  it("takes every path from a publisher, never from a source it dials", () => {
    // `source` also accepts a URL mediamtx connects out to. Every path here is
    // fed by the pipeline on this board; a path that dialled would be the
    // aircraft fetching video from somewhere on an operator's say-so.
    for (const path of Object.values(yaml().paths) as { source: string }[]) {
      expect(path.source).toBe("publisher");
    }
  });

  it("writes no secret into a log level that would print one", () => {
    const y = yaml();
    expect(y.logLevel).toBe("info");
    expect(mediamtxConfig({ config: withCamera(), rtspPassword: PASSWORD }))
      .not.toContain("logLevel: debug");
  });
});
