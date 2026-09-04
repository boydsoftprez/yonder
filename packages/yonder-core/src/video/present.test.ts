// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  ASSUMED_UPLINK_KBPS,
  atIp,
  cameraStrip,
  capabilityFacts,
  identityWords,
  uplinkBudget,
} from "./present.js";
import { advertised, noCapabilities, notOffered, present } from "./capability.js";
import type { CameraCapabilities } from "./capability.js";
import type { Camera } from "../schema/config.js";

const BY_PATH = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0";

function camera(over: Partial<Camera> = {}): Camera {
  return {
    id: "front",
    name: "Front camera",
    source: "usb",
    device: BY_PATH,
    enabled: true,
    autostart: false,
    width: 1280,
    height: 720,
    framerate: 30,
    codec: "h264",
    bitrate_kbps: 2000,
    preview: { width: 640, height: 360, framerate: 15, bitrate_kbps: 400 },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [{ kind: "rtp", host: "192.168.77.20", port: 5600 }],
    ...over,
  } as Camera;
}

const range = { min: 0, max: 100, step: 1, default: 50, current: 50 };

describe("atIp", () => {
  /**
   * The measurement, not a guess: 2000 kb/s configured was ~2067 at IP and UDP
   * over an 8 s window on the board. A budget that counted the elementary
   * stream would under-report an uplink by 3%.
   */
  it("counts the layer an uplink actually carries", () => {
    expect(atIp(2000)).toBe(2067);
    expect(atIp(400)).toBe(413);
  });
});

describe("uplinkBudget", () => {
  it("gives every consumer its own segment, because every one costs its own bitrate", () => {
    const budget = uplinkBudget([camera({
      outputs: [
        { kind: "rtp", host: "192.168.77.20", port: 5600 },
        { kind: "rtsp", password: { secret: "rtsp_password" } },
      ],
    })]);
    expect(budget.segments.map((s) => s.label)).toEqual([
      "Front camera · rtp",
      "Front camera · rtsp",
      "Front camera · preview",
    ]);
    expect(budget.segments.map((s) => s.kbps)).toEqual([2067, 2067, 413]);
  });

  it("counts nothing for a camera that is not enabled, because it has no pipeline", () => {
    expect(uplinkBudget([camera({ enabled: false })]).segments).toEqual([]);
  });

  it("totals across cameras, which is why this lives on the index and not on a page", () => {
    const budget = uplinkBudget([
      camera(),
      camera({ id: "gimbal", name: "Gimbal", bitrate_kbps: 2000 }),
    ]);
    const total = budget.segments.reduce((n, s) => n + s.kbps, 0);
    expect(total).toBe(2067 + 413 + 2067 + 413);
  });

  it("states an assumed capacity rather than pretending to have measured one", () => {
    expect(uplinkBudget([]).capacityKbps).toBe(ASSUMED_UPLINK_KBPS);
    expect(uplinkBudget([], 1500).capacityKbps).toBe(1500);
  });
});

describe("capabilityFacts", () => {
  it("states everything the camera does not have, and nothing it does", () => {
    const caps: CameraCapabilities = {
      ...noCapabilities(),
      formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30] }]),
      zoom: present(range),
      focus: present(range),
      exposure: present(range),
      whiteBalance: present(range),
      brightness: present(range),
      contrast: present(range),
    };
    expect(capabilityFacts(caps).map((f) => f.label))
      .toEqual(["Rotation", "Aim", "Recording", "Stills"]);
    expect(capabilityFacts(caps).every((f) => f.state === "not-offered")).toBe(true);
  });

  /**
   * The state most likely to be got wrong, because on the wire it is
   * indistinguishable from success. It must keep its reason: that is the half
   * that tells an operator a firmware change might fix it.
   */
  it("keeps an advertised capability apart from one the camera does not have", () => {
    const caps: CameraCapabilities = {
      ...noCapabilities(),
      zoom: advertised("every value was acknowledged and the frame never changed"),
      focus: notOffered(),
    };
    const zoom = capabilityFacts(caps).find((f) => f.label === "Zoom");
    expect(zoom).toEqual({
      label: "Zoom",
      state: "advertised",
      reason: "every value was acknowledged and the frame never changed",
    });
    expect(capabilityFacts(caps).find((f) => f.label === "Focus"))
      .toEqual({ label: "Focus", state: "not-offered" });
  });

  it("says every row when the probe answered nothing, never an empty row", () => {
    // *This camera cannot* and *this page failed* must not look the same.
    expect(capabilityFacts(noCapabilities())).toHaveLength(11);
  });

  it("labels a capability in words, never with its own field name", () => {
    expect(capabilityFacts(noCapabilities()).map((f) => f.label)).toContain("White balance");
    expect(capabilityFacts(noCapabilities()).map((f) => f.label)).not.toContain("whiteBalance");
  });
});

describe("identityWords", () => {
  it("says a stable name survives a reboot", () => {
    expect(identityWords(BY_PATH, true)).toBe(`${BY_PATH} — survives a reboot`);
  });

  /**
   * The half nothing in this repository rendered until the Cameras page did.
   * A `false` means the configured camera is held by an enumeration number,
   * and only the operator can act on that.
   */
  it("says an unstable one may mean a different camera after a reboot", () => {
    expect(identityWords("/dev/video0", false)).toContain("may mean a different camera");
  });

  it("says nothing was resolved when the camera did not answer", () => {
    expect(identityWords(null, false)).toBe("not resolved — this camera did not answer");
  });
});

describe("cameraStrip", () => {
  const encoder = { element: "v4l2h264enc", hardware: true };

  it("composes the readout the page cannot compose for itself", () => {
    const strip = cameraStrip({
      camera: camera(),
      run: { state: "running" },
      device: "/dev/video0",
      byPathStable: true,
      encoder,
    });
    expect(strip.state).toBe("running");
    expect(strip.picture).toBe("1280 × 720");
    expect(strip.rate).toBe("30 fps");
    expect(strip.bitrate).toBe("2000 kb/s");
    expect(strip.device).toBe("/dev/video0");
    expect(strip.encoder).toBe("v4l2h264enc · hardware");
  });

  /**
   * A row labelled "cannot start" with nothing after it reads as *this camera
   * cannot start*, which is the opposite of what a null refusal means. So the
   * strip carries a sentence either way.
   */
  it("says a start would not be refused, rather than saying nothing", () => {
    const strip = cameraStrip({
      camera: camera(), run: { state: "stopped" }, device: "/dev/video0",
      byPathStable: true, encoder, refusal: null,
    });
    expect(strip.startCheck).toBe("nothing is stopping it");
  });

  it("carries the refusal itself when there is one (R-CAM-10)", () => {
    const strip = cameraStrip({
      camera: camera(), run: { state: "stopped" }, device: null,
      byPathStable: false, encoder,
      refusal: "this camera has not answered with any capture format",
    });
    expect(strip.startCheck).toBe("this camera has not answered with any capture format");
  });

  it("adds every output and the preview into this camera's own share, at IP", () => {
    const strip = cameraStrip({
      camera: camera({
        outputs: [
          { kind: "rtp", host: "192.168.77.20", port: 5600 },
          { kind: "srt", port: 8890 },
        ],
      }),
      run: { state: "running" },
      device: "/dev/video0",
      byPathStable: true,
      encoder,
    });
    // 2067 + 2067 + 413
    expect(strip.uplink).toBe("4.55 Mb/s at IP");
  });

  /** Units keep their case: `KB/S` says kilobytes and `FPS` says nothing. */
  it("never uppercases a unit", () => {
    const strip = cameraStrip({
      camera: camera(),
      run: { state: "stopped" },
      device: null,
      byPathStable: false,
      encoder,
    });
    for (const value of [strip.rate, strip.bitrate, strip.uplink]) {
      expect(value).toBe(value.replace(/KB\/S|FPS|MB\/S/g, "!"));
    }
  });

  /**
   * The supervisor's own reason, when it has one. "the pipeline exited with
   * code 1" is what an operator needs after a camera that would not start.
   */
  it("carries the supervisor's reason beside the state", () => {
    const strip = cameraStrip({
      camera: camera(),
      run: { state: "failed", reason: "the pipeline exited with code 1" },
      device: null,
      byPathStable: false,
      encoder,
    });
    expect(strip.state).toBe("failed — the pipeline exited with code 1");
    expect(strip.device).toBe("not resolved");
    expect(strip.identity).toBe("not resolved — this camera did not answer");
  });
});
