// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderReceive, type ReceiveFacts } from "./receive.js";
import type { ReachPaths } from "./outputs.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: {
    mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
    floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
  },
  controls: { brightness: null, contrast: null, rotation: 0 },
  // `enabled` written out, because a parsed configuration always carries it:
  // `CameraOutput` gives it `.default(true)`, so it is required on the way out
  // of the schema and only a hand-built literal can be missing it. This
  // fixture used to omit it, which meant every test here ran against an output
  // shape no device produces — and R-VID-16's stopped-output case below is
  // exactly what that would have hidden.
  outputs: [
    { kind: "rtp", enabled: true, host: "192.168.1.50", port: 5600 },
    { kind: "rtsp", enabled: true, password: { secret: "rtsp_password" } },
  ],
  stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
};

/** On a bench: a LAN this device shares with whoever is reading the page. */
const LAN: ReachPaths = { lan: true, mesh: false, cellular: false };
/** In flight, on cellular alone — nothing can dial in. */
const CELL: ReachPaths = { lan: false, mesh: false, cellular: true };

const FACTS: ReceiveFacts = {
  camera: CAMERA,
  // **Never a real device's address.** These were copied off the bench board,
  // which is usually the right instinct — recorded output beats invented
  // output — and is the wrong one for a value that names somebody's actual
  // network: it ships in the package and stays there for ever. Same class as
  // the live ZeroTier network id in `node-red-contrib-yonder-remote`, fixed in
  // a7a2ee2. 198.51.100.0/24 is RFC 5737's documentation range and resolves to
  // nothing anywhere.
  address: "192.168.191.42",
  alternatives: ["192.168.77.1", "198.51.100.20"],
  rtspPassword: "Kx7-mfPq-2Rn4",
  rtspPort: 8554,
  paths: LAN,
  // On a bench the console's own address is one a peer can dial, so the URL
  // uses it and nothing is substituted. The flying case is its own block.
  answering: [{ address: "192.168.191.42", path: "lan" as const }],
};

/** The one rendering a given kind produced. */
const of = (kind: string, facts: ReceiveFacts = FACTS): { body: string; usable: boolean; note: string } => {
  const found = renderReceive(facts).find((r) => r.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} rendering`);
  return found;
};

describe("renderReceive", () => {
  it("gives four renderings of the same three facts", () => {
    expect(renderReceive(FACTS).map((r) => r.kind))
      .toEqual(["gstreamer", "dialog", "appsink", "url"]);
  });

  it("names the depayloader that matches the codec", () => {
    const gst = renderReceive(FACTS)[0].body;
    expect(gst).toContain("rtph264depay");
    expect(gst).toContain("avdec_h264");
    expect(gst).toContain("port=5600");
  });

  it("writes the ground station an H.265 line when that is what leaves (R-VID-02)", () => {
    const gst = renderReceive({ ...FACTS, camera: { ...CAMERA, codec: "h265" } })[0].body;
    expect(gst).toContain("encoding-name=H265");
    expect(gst).toContain("rtph265depay");
    expect(gst).toContain("h265parse");
    expect(gst).toContain("avdec_h265");
    expect(gst).not.toContain("rtph264depay");
  });

  it("carries the address the operator is actually reaching the device on", () => {
    // A board on a mesh has several and only one is in use. The command
    // carries that one; the others are listed beneath rather than guessed at.
    const url = renderReceive(FACTS)[3].body;
    expect(url).toContain("192.168.191.42");
    expect(url).not.toContain("192.168.77.1");
    const dialog = renderReceive(FACTS)[1].body;
    expect(dialog).toContain("192.168.77.1");
    expect(dialog).toContain("198.51.100.20");
  });

  it("resolves the RTSP credential into the URL, so nobody types it", () => {
    expect(renderReceive(FACTS)[3].body).toContain("Kx7-mfPq-2Rn4");
    expect(renderReceive(FACTS)[3].body).toContain(`rtsp://yonder:`);
    expect(renderReceive(FACTS)[3].body).toContain(":8554/cam0");
  });

  /**
   * **The trap this URL exists to avoid.** `media/config.ts` grants mediamtx's
   * anonymous user read from loopback only, measured against a board: a player
   * dialling in from anywhere else without the credential is answered `401`,
   * which most players report as nothing at all. A URL with no credential in
   * it is therefore an address that looks right and silently does not work —
   * and the three UDP lines beside it, which need no credential, must not
   * grow one by copy-and-paste.
   */
  it("puts the credential in the RTSP URL and in nothing else", () => {
    for (const kind of ["gstreamer", "dialog", "appsink"]) {
      expect(of(kind).body, kind).not.toContain("Kx7-mfPq-2Rn4");
      expect(of(kind).body, kind).not.toContain("rtsp://");
    }
    expect(of("url").body).toMatch(/^rtsp:\/\/yonder:Kx7-mfPq-2Rn4@/);
  });

  it("says so rather than printing half a URL when the secret is unresolved", () => {
    const body = renderReceive({ ...FACTS, rtspPassword: null })[3].body;
    expect(body).not.toContain("yonder:@");
    expect(body).toContain("not yet generated");
  });

  it("omits an RTSP rendering entirely when no RTSP output is configured", () => {
    const noRtsp = { ...FACTS, camera: { ...CAMERA, outputs: [CAMERA.outputs[0]] } };
    expect(renderReceive(noRtsp).find((r) => r.kind === "url")?.body).toContain("no RTSP output");
  });

  it("keeps units in their own case", () => {
    // Mb/s rendered as MB/S says megabytes. This appeared three times in
    // three components during design.
    for (const r of renderReceive(FACTS)) expect(r.body).not.toContain("MB/S");
    expect(renderReceive(FACTS)[1].body).toContain("Mb/s");
  });

  /**
   * R-UI-27: a camera's name is the operator's, and is shown everywhere the
   * camera is named. A ground station's dialog holds one feed, and the person
   * filling it in has to know which camera they are pointing it at.
   */
  it("names the camera in the ground station's settings, from the configuration", () => {
    expect(of("dialog").body).toContain("Nose");
    expect(of("dialog", { ...FACTS, camera: { ...CAMERA, name: "Belly" } }).body)
      .toContain("Belly");
  });

  describe("R-UI-24: every line says whether it can be used", () => {
    it("marks the RTSP URL unusable on cellular alone, and says why", () => {
      const url = of("url", { ...FACTS, paths: CELL });
      expect(url.usable).toBe(false);
      expect(url.note).toMatch(/^unusable — /);
      expect(url.note).toMatch(/cellular/);
      expect(url.note).toMatch(/mesh/);
      // Never stopped, never hidden: R-UI-24 says *marked unusable rather
      // than offered*, and the address itself is still there to copy the
      // moment the operator brings the board onto a LAN.
      expect(url.body).toContain("rtsp://yonder:Kx7-mfPq-2Rn4@");
    });

    it("leaves the outbound push usable on cellular, because it dials out", () => {
      for (const kind of ["gstreamer", "dialog", "appsink"]) {
        const r = of(kind, { ...FACTS, paths: CELL });
        expect(r.usable, kind).toBe(true);
        expect(r.note, kind).not.toMatch(/unusable/);
      }
    });

    it("marks every line unusable when no path at all is up", () => {
      const dark = { ...FACTS, paths: { lan: false, mesh: false, cellular: false } };
      for (const r of renderReceive(dark)) {
        expect(r.usable, r.kind).toBe(false);
        expect(r.note, r.kind).toMatch(/^unusable — /);
      }
    });

    it("marks the whole set usable on a LAN, so the mark is not simply always on", () => {
      for (const r of renderReceive(FACTS)) {
        expect(r.usable, r.kind).toBe(true);
        expect(r.note, r.kind).not.toMatch(/unusable/);
      }
    });

    /**
     * An output that exists and is stopped is a third thing, and it is the
     * one `outputReach()` deliberately says nothing about: "an output can be
     * enabled and unreachable at once". A line for a stopped output is still
     * a line nothing will answer.
     */
    it("marks a stopped output's line unusable, and names starting it", () => {
      const stopped = {
        ...FACTS,
        camera: {
          ...CAMERA,
          outputs: [CAMERA.outputs[0], { ...CAMERA.outputs[1], enabled: false }],
        } as Camera,
      };
      const url = of("url", stopped);
      expect(url.usable).toBe(false);
      expect(url.note).toMatch(/stopped/);
      // And the three UDP lines, whose own output is untouched, stay usable —
      // one output's state must not mark another output's line.
      expect(of("gstreamer", stopped).usable).toBe(true);
    });

    it("marks the three UDP lines unusable when there is no RTP output to push", () => {
      const noRtp = { ...FACTS, camera: { ...CAMERA, outputs: [CAMERA.outputs[1]] } as Camera };
      for (const kind of ["gstreamer", "dialog", "appsink"]) {
        expect(of(kind, noRtp).usable, kind).toBe(false);
        expect(of(kind, noRtp).note, kind).toMatch(/No RTP destination/);
      }
      // The RTSP line is about a different output and is unaffected.
      expect(of("url", noRtp).usable).toBe(true);
    });

    it("marks the URL unusable while the credential is unresolved, whatever the paths", () => {
      const url = of("url", { ...FACTS, rtspPassword: null });
      expect(url.usable).toBe(false);
      expect(url.note).toMatch(/^unusable — /);
      expect(url.note).toMatch(/password/);
    });

    /**
     * **The address in the URL must be one the verdict is true of.**
     *
     * On the flying case — cellular up, the mesh up, no LAN — a listener is
     * reachable and the console is being reached on the modem's address, which
     * is behind the carrier's NAT. Printing that address under "a peer on the
     * mesh or a LAN has an address that reaches this RTSP output" is the claim
     * true and the line beside it useless: an address that looks right and does
     * nothing, which is the whole failure this surface exists to prevent.
     */
    /**
     * **The flying board, in the shape it really has.** Cellular and the mesh
     * up, no LAN, the radio serving the access point — so `activeIpv4()`
     * reports the modem's CGNAT address and `192.168.77.1` before the mesh's,
     * and the console is being reached on the CGNAT one. `outputReach` says
     * the listener is reachable *because of the mesh*, so the mesh address is
     * the only one that satisfies the verdict printed beside it.
     */
    it("builds the RTSP URL from the path the verdict rests on", () => {
      const flying = {
        ...FACTS,
        address: "100.72.14.9",
        alternatives: ["192.168.77.1", "10.147.17.42"],
        answering: [
          { address: "100.72.14.9", path: "cellular" as const },
          { address: "192.168.77.1", path: "access-point" as const },
          { address: "10.147.17.42", path: "mesh" as const },
        ],
        paths: { lan: false, mesh: true, cellular: true },
      };
      const url = of("url", flying);
      expect(url.usable).toBe(true);
      expect(url.body).toContain("@10.147.17.42:8554/cam0");
      expect(url.body).not.toContain("100.72.14.9");
      // The access point's address is reported first and is genuinely dialable
      // by somebody joined to it — and it is not what a mesh peer can use, so
      // it must not be what a mesh verdict prints.
      expect(url.body).not.toContain("192.168.77.1");
      // And the note says which address it used and why, so the sentence and
      // the line under it are about one thing.
      expect(url.note).toContain("10.147.17.42");
      expect(url.note).toContain("the mesh");
    });

    it("prefers a LAN address when the verdict rests on a LAN", () => {
      const bench = {
        ...FACTS,
        address: "100.72.14.9",
        answering: [
          { address: "192.168.1.50", path: "lan" as const },
          { address: "10.147.17.42", path: "mesh" as const },
        ],
        paths: { lan: true, mesh: false, cellular: true },
      };
      expect(of("url", bench).body).toContain("@192.168.1.50:8554/cam0");
    });

    it("keeps the console's own address when it is on a path the verdict rests on", () => {
      const lan = {
        ...FACTS,
        address: "192.168.1.50",
        answering: [
          { address: "10.147.17.42", path: "mesh" as const },
          { address: "192.168.1.50", path: "lan" as const },
        ],
        paths: { lan: true, mesh: true, cellular: false },
      };
      const url = of("url", lan);
      // Not simply the first candidate: the operator is already reaching the
      // device on this one, so it is the one that is known to work.
      expect(url.body).toContain("@192.168.1.50:8554/cam0");
      expect(url.note).not.toMatch(/rather than the one/);
    });

    it("withdraws the claim when the path is up and this device has no address on it", () => {
      // A verdict of *reachable* over no candidate at all is a claim about no
      // address. It is withdrawn rather than left standing over one that
      // cannot serve it.
      const url = of("url", {
        ...FACTS,
        answering: [{ address: "192.168.77.1", path: "access-point" as const }],
        paths: { lan: false, mesh: true, cellular: false },
      });
      expect(url.usable).toBe(false);
      expect(url.note).toMatch(/^unusable — /);
      expect(url.body).toContain("@192.168.191.42:8554/cam0");
    });

    it("leaves the three UDP lines' addresses alone, because they carry none", () => {
      const flying = {
        ...FACTS,
        address: "100.72.14.9",
        answering: [{ address: "10.147.17.42", path: "mesh" as const }],
      };
      for (const kind of ["gstreamer", "appsink"]) {
        expect(of(kind, flying).body, kind).not.toContain("10.147.17.42");
        expect(of(kind, flying).body, kind).not.toContain("100.72.14.9");
      }
    });

    it("gives every rendering both fields, so no surface has to guess", () => {
      for (const r of renderReceive({ ...FACTS, paths: CELL })) {
        expect(typeof r.usable, r.kind).toBe("boolean");
        expect(r.note, r.kind).not.toBe("");
      }
    });
  });
});
