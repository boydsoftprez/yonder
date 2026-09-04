// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderReceive, type ReceiveFacts } from "./receive.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: { width: 640, height: 360, framerate: 15, bitrate_kbps: 400 },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [
    { kind: "rtp", host: "192.168.1.50", port: 5600 },
    { kind: "rtsp", password: { secret: "rtsp_password" } },
  ],
};
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
});
