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
        expect(of(kind, noRtp).note, kind).toMatch(/no RTP output/);
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

    it("gives every rendering both fields, so no surface has to guess", () => {
      for (const r of renderReceive({ ...FACTS, paths: CELL })) {
        expect(typeof r.usable, r.kind).toBe("boolean");
        expect(r.note, r.kind).not.toBe("");
      }
    });
  });
});
