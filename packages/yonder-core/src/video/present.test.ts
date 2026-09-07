// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  absentIdentityWords,
  aimPanel,
  ASSUMED_UPLINK_KBPS,
  atIp,
  fromIp,
  cameraDeck,
  cameraIndex,
  cameraStrip,
  capabilityFacts,
  captureDestination,
  deckCapture,
  endedWords,
  heldWords,
  identityWords,
  LABELS,
  removalRefusal,
  thumbStrip,
  uplinkBudget,
} from "./present.js";
import { stillUrl } from "./media-path.js";
import type { RunState } from "./supervisor.js";
import { advertised, gated, noCapabilities, notOffered, present } from "./capability.js";
import type { CameraCapabilities } from "./capability.js";
import type { Camera } from "../schema/config.js";
import type { RecordingState } from "./recorder.js";

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
    preview: {
      mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [{ kind: "rtp", host: "192.168.77.20", port: 5600, enabled: true }],
    stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
    ...over,
  } as Camera;
}

const range = { min: 0, max: 100, step: 1, default: 50, current: 50, inactive: false };

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

describe("fromIp", () => {
  /**
   * The exact inverse, and it has to be exact: `video/rate.ts` divides a
   * measured link between two encodes with it, and a kilobit lost to
   * `kbps / IP_OVERHEAD`'s rounding is a kilobit of a cellular uplink left
   * unspent on every allocation for ever.
   */
  it("gives the largest rate whose IP cost fits, and never one that does not", () => {
    for (let budget = 0; budget <= 4200; budget += 1) {
      const rate = fromIp(budget);
      expect(atIp(rate), `${budget} kb/s at IP`).toBeLessThanOrEqual(budget);
      expect(atIp(rate + 1), `${budget} kb/s at IP`).toBeGreaterThan(budget);
    }
  });

  it("round-trips every rate an encoder in this schema can be set to", () => {
    for (let kbps = 100; kbps <= 20_000; kbps += 1) {
      expect(fromIp(atIp(kbps)), `${kbps} kb/s`).toBe(kbps);
    }
  });

  it("has nothing to give out of nothing", () => {
    expect(fromIp(0)).toBe(0);
    expect(fromIp(-5)).toBe(0);
  });
});

describe("uplinkBudget", () => {
  // Named so a test can disable one and leave the other running, without
  // retyping its shape (Task 10 fix round 1: `stops counting an output the
  // operator stopped`).
  const rtpOutput = { kind: "rtp", host: "192.168.77.20", port: 5600, enabled: true } as const;
  const rtspOutput = { kind: "rtsp", password: { secret: "rtsp_password" }, enabled: true } as const;

  it("gives every consumer its own segment, because every one costs its own bitrate", () => {
    const budget = uplinkBudget([camera({
      outputs: [rtpOutput, rtspOutput],
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

  it("stops counting an output the operator stopped", () => {
    // The whole point of the fix: a disabled output's bitrate is not billed,
    // exactly as if it had never been configured, while its enabled sibling
    // and the preview still are.
    const b = uplinkBudget([camera({ outputs: [
      { ...rtpOutput, enabled: false }, rtspOutput,
    ] })]);
    expect(b.segments.map((s) => s.label)).toEqual([
      "Front camera · rtsp", "Front camera · preview",
    ]);
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
  /** What the bench's own camera answers, from the committed fixture. */
  const globalShutter: CameraCapabilities = {
    ...noCapabilities(),
    formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30] }]),
    zoom: present(range),
    focus: present(range),
    exposure: present(range),
    whiteBalance: present(range),
    brightness: present(range),
    contrast: present(range),
  };

  it("states everything the camera does not have, and nothing it does", () => {
    // `globalShutter` answers only the six controls the bench's own camera
    // does (plus `formats`); the ten this task added are not among them, so
    // they read `not-offered` too, in `CAPABILITY_KEYS` order, right after
    // the four that were already here.
    expect(capabilityFacts(globalShutter).filter((f) => f.state === "not-offered")
      .map((f) => f.label))
      .toEqual([
        "Rotation", "Aim", "Recording", "Stills",
        "Saturation", "Hue", "Auto white balance", "Gamma", "Gain",
        "Mains frequency", "Sharpness", "Backlight compensation",
        "Auto exposure", "Auto focus", "Mirror", "Flip",
      ]);
  });

  /**
   * **R-UI-20 in the direction nothing was watching.** This camera answers
   * zoom, focus, exposure and white balance as present; the page draws
   * brightness and contrast. Those four appeared nowhere at all — no control,
   * and no fact — so an operator read the page and concluded the camera had
   * two adjustable settings when it has six. Neither *this camera cannot* nor
   * *this page failed* was being said.
   */
  it("states a capability the camera has and the page does not draw", () => {
    const undrawn = capabilityFacts(globalShutter).filter((f) => f.state === "undrawn");
    expect(undrawn.map((f) => f.label)).toEqual(["Zoom", "Focus", "Exposure", "White balance"]);
  });

  it("says nothing about a capability the page does draw", () => {
    // A control *and* a row saying it is missing would be the page saying both.
    const said = capabilityFacts(globalShutter).map((f) => f.label);
    expect(said).not.toContain("Brightness");
    expect(said).not.toContain("Contrast");
    expect(said).not.toContain("Capture formats");
  });

  it("follows the page rather than a list of its own", () => {
    // The set is an argument, so a control added to the page moves the row
    // rather than needing this file to be edited in step with the wiring.
    const drawn = capabilityFacts(globalShutter, ["formats", "brightness", "contrast", "zoom"]);
    expect(drawn.map((f) => f.label)).not.toContain("Zoom");
    expect(drawn.filter((f) => f.state === "undrawn").map((f) => f.label))
      .toEqual(["Focus", "Exposure", "White balance"]);
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

  /**
   * **The console must not call a camera short of something it has.** A
   * `gated` capability is real and working; another control just has charge
   * of it right now, which is not a fault and reads nothing like one — see
   * `capability.ts`'s own module comment for why this state exists. This is
   * the fix for the bug the ternary this replaced had: everything that was
   * not `advertised` read `not-offered`, `gated` included.
   */
  it("says which control has it, and does not call the camera short of one", () => {
    const range = { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true };
    const by = { id: "auto_exposure", label: "auto exposure" };
    const caps = { ...noCapabilities(), exposure: gated(range, by) };
    const fact = capabilityFacts(caps).find((f) => f.label === LABELS.exposure);
    expect(fact).toEqual({ label: LABELS.exposure, state: "gated", reason: "auto exposure" });
  });

  it("says every row when the probe answered nothing, never an empty row", () => {
    // *This camera cannot* and *this page failed* must not look the same.
    // One row per `CAPABILITY_KEYS` entry — eleven, then ten, then the
    // mirror and the flip (R-CTL-05). A literal on purpose, not
    // `CAPABILITY_KEYS.length`: counted against the implementation it would
    // agree with any number the implementation happened to produce.
    expect(capabilityFacts(noCapabilities())).toHaveLength(23);
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

  /**
   * **The socket is kept, and it is the whole point of the sentence.**
   * `identityWords(null, …)` drops it — right on a camera's own page, where
   * the socket is stated beside it, and wrong on an index row, where the
   * socket is the one thing an operator can act on: move a plug back to it,
   * or remove the entry that names it.
   */
  it("keeps the socket a configured camera expects when nothing answered on it", () => {
    expect(absentIdentityWords(BY_PATH)).toContain(BY_PATH);
    expect(absentIdentityWords(BY_PATH)).toContain("nothing there answered");
  });

  /**
   * "Nothing there answered", never "nothing is attached": the board cannot
   * tell an empty socket from a camera that refused to enumerate, and the
   * second claims more than it saw.
   */
  it("claims only what the board actually observed", () => {
    expect(absentIdentityWords(BY_PATH)).not.toContain("nothing is attached");
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
   * **R-UI-27: the camera's own name, on the one part of the page that never
   * goes away.**
   *
   * The deck's placard carries it too, but the deck is exchanged — Live and
   * Setup swap — and until this, the only thing on the page saying which
   * camera you were looking at while they swapped was a literal in
   * `flows.json`: `"label": "Front camera"`, the capture fixture's name,
   * frozen at deploy time on every device. A page cannot compose this for
   * itself (see this file's opening note), so it is composed here.
   */
  it("names the camera, from the configuration and not from a page", () => {
    const strip = cameraStrip({
      camera: camera({ name: "Nose mast" }),
      run: { state: "running" },
      device: "/dev/video0",
      byPathStable: true,
      encoder,
    });
    expect(strip.name).toBe("Nose mast");
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

  /**
   * **The cost the operator reads before they spend the uplink** (R-VID-11).
   *
   * Both of these were literals in `flows.json` — the fixture's own numbers,
   * frozen at deploy time and reachable by no message. Raise the bitrate and
   * the picture went on saying 2.07 Mb/s while the strip beside it said 8.27:
   * the same page contradicting itself, with the number an operator would act
   * on wrong by four times.
   */
  it("states what the picture costs, from the configuration in force", () => {
    const rtsp = { kind: "rtsp" as const, password: { secret: "rtsp_password" } };
    const strip = (over: Partial<Camera>) => cameraStrip({
      camera: camera({ outputs: [rtsp], ...over }),
      run: { state: "running" }, device: "/dev/video0", byPathStable: true, encoder,
    });
    expect(strip({}).pictureCost).toBe("preview 0.41 Mb/s · full rate 2.07 Mb/s at IP");
    expect(strip({}).holdCost).toBe("2.07 Mb/s while held");

    // The whole point of computing them: they move.
    const raised = strip({ bitrate_kbps: 8000, preview: {
      mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 2000, framerate: 15,
    } });
    expect(raised.pictureCost).toBe("preview 2.07 Mb/s · full rate 8.27 Mb/s at IP");
    expect(raised.holdCost).toBe("8.27 Mb/s while held");
    // And they agree with the strip's own total, which is computed elsewhere
    // in this file: 8268 + 2067.
    expect(raised.uplink).toBe("10.34 Mb/s at IP");
  });

  it("offers no full rate where there is no full-rate stream to hold", () => {
    // The full-rate path exists only where an RTSP output does. Held on a
    // camera without one, the key asks the media server for a path that does
    // not exist and the picture reports the 404 as "this camera is not
    // streaming" — a true sentence about the wrong thing, for a key that
    // should not have been offered (R-UI-20).
    const strip = cameraStrip({
      camera: camera({ outputs: [{ kind: "rtp", host: "192.168.77.20", port: 5600 }] }),
      run: { state: "running" }, device: "/dev/video0", byPathStable: true, encoder,
    });
    expect(strip.fullRate).toBe(false);
    expect(strip.holdCost).toContain("no full-rate stream");
    expect(strip.pictureCost).toBe("preview 0.41 Mb/s at IP");
    expect(strip.pictureCost).not.toContain("full rate");
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

/* ------------------------------------------------------------------------ *
 * The probe-to-row adapter, and the two payloads beside it.
 * ------------------------------------------------------------------------ */

function detection(over: Partial<{
  device: string; card: string; byPath: string; byPathStable: boolean;
  capabilities: CameraCapabilities;
}> = {}) {
  return {
    device: "/dev/video0",
    card: "Global Shutter Camera: Global S",
    byPath: BY_PATH,
    byPathStable: true,
    capabilities: noCapabilities(),
    ...over,
  };
}

describe("cameraIndex — the probe-to-row adapter", () => {
  /**
   * **R-CAM-05, which is the whole subject of the id.** A configuration
   * stores the *socket* — the `/dev/v4l/by-path/` name — and this is what
   * matches a detection to a configured camera. Unplug the camera and plug it
   * back into the same socket and `byPath` is the same string, so the same id
   * comes back whatever `/dev/videoN` the kernel hands it this time.
   */
  it("matches a detection to a configured camera by its socket, not its /dev node", () => {
    const { cameras } = cameraIndex({
      // The enumeration number has moved, as it does across a replug.
      found: [detection({ device: "/dev/video7" })],
      rejected: [],
      cameras: [camera()],
      run: () => "running",
    });
    expect(cameras[0]?.id).toBe("front");
    expect(cameras[0]?.name).toBe("Front camera");
    expect(cameras[0]?.bus).toBe("usb · /dev/video7");
  });

  /**
   * The other half of R-CAM-05, and the reason `identityWords` exists: a
   * camera held by an enumeration number will mean a different device after a
   * reboot, and the row has to say so or nobody ever learns it.
   */
  it("carries the identity sentence, in both of its forms", () => {
    const stable = cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()], run: () => "stopped",
    });
    expect(stable.cameras[0]?.identity).toContain("survives a reboot");

    const unstable = cameraIndex({
      found: [detection({ byPath: "/dev/video0", byPathStable: false })],
      rejected: [],
      cameras: [camera({ device: "/dev/video0" })],
      run: () => "stopped",
    });
    expect(unstable.cameras[0]?.identity)
      .toContain("it may mean a different camera after a reboot");
  });

  /**
   * R-UI-03: a camera detected on a socket nothing is configured for has no
   * page to open. It is still a row — *there is a camera here and Yonder is
   * not set up for it* is exactly what an operator has to be told — with a
   * null id, which is what `YonderIndex` draws an inert key for.
   */
  it("reports a camera on an unconfigured socket as a row with no id", () => {
    const { cameras } = cameraIndex({
      found: [detection()], rejected: [], cameras: [], run: () => "stopped",
    });
    expect(cameras[0]?.id).toBeNull();
    expect(cameras[0]?.name).toBe("Global Shutter Camera: Global S");
    expect(cameras[0]?.state).toBe("Not configured");
    expect(cameras[0]?.tone).toBe("neutral");
  });

  /**
   * **`state` and `tone` come from the supervisor's observed run state**, and
   * never from the configuration: `enabled` and `autostart` are what the
   * operator asked for, and a camera that was asked to run and did not is the
   * one case an operator most needs the row to be honest about.
   */
  it("takes state and tone from what the supervisor observed", () => {
    const seen = (state: "running" | "starting" | "failed" | "stopped") =>
      cameraIndex({
        found: [detection()], rejected: [], cameras: [camera()], run: () => state,
      }).cameras[0];
    expect(seen("running")).toMatchObject({ state: "Streaming", tone: "good" });
    expect(seen("starting")).toMatchObject({ state: "Starting", tone: "waiting" });
    expect(seen("failed")).toMatchObject({ state: "Failed", tone: "bad" });
    expect(seen("stopped")).toMatchObject({ state: "Idle", tone: "neutral" });
  });

  /**
   * **`rate` is measured egress, and nothing on this branch measures one.**
   *
   * The camera below is configured at 2000 kb/s and the row still reads
   * `null`. That is the point: a number nobody measured is a number nobody
   * should act on, and echoing the configured target into the column an
   * operator reads to find out what is *actually* going out is the most
   * plausible wrong answer available. `YonderIndex` draws null as "none".
   */
  it("reports no rate at all until something measures one, never the configured target", () => {
    const { cameras } = cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()], run: () => "running",
    });
    expect(cameras[0]?.rate).toBeNull();

    // And when a measurement exists it is stated at IP, the layer an uplink
    // actually carries — the same layer every other rate on this console is.
    const measured = cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()],
      run: () => "running", egressKbps: () => 1800,
    });
    expect(measured.cameras[0]?.rate).toBeCloseTo(atIp(1800) / 1000, 2);
  });

  /** R-CAM-12: a rejection travels with its reason, never filtered out. */
  it("carries every rejection through with the reason the probe gave", () => {
    const { rejected } = cameraIndex({
      found: [],
      rejected: [{ device: "/dev/video10", reason: "a hardware codec, not a camera (K-40)" }],
      cameras: [camera()],
      run: () => "stopped",
    });
    expect(rejected).toEqual([
      { device: "/dev/video10", reason: "a hardware codec, not a camera (K-40)" },
    ]);
  });

  /**
   * **The state the operator found a board in** (R-CAM-20, R-CAM-05).
   *
   * A camera had been moved between USB ports. Identity is the socket, so
   * each move made it a *different* camera as far as the configuration was
   * concerned and nothing removed the old one — two configured cameras on
   * empty ports and the camera in his hand matching neither. This function
   * mapped `input.found` alone, so it drew **no row at all** for either of
   * the two, while the navigation, built from the same configuration,
   * carried both. The page whose whole job is to say what cameras this
   * device has was the one leaving them out.
   */
  it("draws a row for a configured camera the sweep matched to nothing", () => {
    const { cameras } = cameraIndex({
      found: [], rejected: [], cameras: [camera()], run: () => "stopped",
    });
    expect(cameras, "the camera is on the page at all, which is the defect").toHaveLength(1);
    expect(cameras[0]?.id).toBe("front");
    expect(cameras[0]?.name).toBe("Front camera");
    // The socket it expects — the one string an operator can act on: move a
    // plug back to it, or remove the entry that names it.
    expect(cameras[0]?.device).toBe(BY_PATH);
    expect(cameras[0]?.identity).toContain(BY_PATH);
    expect(cameras[0]?.identity).toContain("nothing there answered");
    // And what it is configured to send is still stated: the configuration
    // has not stopped saying it.
    expect(cameras[0]?.spec).toBe("H264 · 1280×720p30");
  });

  /**
   * **`stopped` is what the supervisor answers for a camera that is idle and
   * for a camera that is not on the bus**, and drawing both as `Idle` is the
   * confusion this row exists to remove. An idle camera is one an operator
   * can start; an absent one is a plug to move or an entry to clear.
   */
  it("says a camera is not attached rather than idle, which is what the supervisor calls both", () => {
    const absent = cameraIndex({
      found: [], rejected: [], cameras: [camera()], run: () => "stopped",
    }).cameras[0];
    const idle = cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()], run: () => "stopped",
    }).cameras[0];
    expect(idle).toMatchObject({ state: "Idle", tone: "neutral" });
    expect(absent?.state).not.toBe(idle?.state);
    // Neutral, by the operator's decision on 2026-09-07: a warning that fires
    // every time somebody unplugs a camera between flights is a warning that
    // stops being read. The row says *Not attached* in words, names the socket
    // it expects and carries a key to clear it — the colour was only the alarm.
    expect(absent).toMatchObject({ state: "Not attached", tone: "neutral" });
  });

  /**
   * **A row of `aim: none · zoom: none` would be twenty-one claims about a
   * camera this board cannot see** (R-CAM-14, R-UI-20). Nothing answered, so
   * nothing was asked, and an operator has to be able to tell *this camera
   * cannot* from *this camera was not there to ask*.
   */
  it("reports no capabilities at all for a camera that answered nothing, never a row of none", () => {
    const { cameras } = cameraIndex({
      found: [], rejected: [], cameras: [camera()], run: () => "stopped",
    });
    expect(cameras[0]?.capabilities).toBeNull();
    // And a camera that *was* found still carries what it answered.
    expect(cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()], run: () => "stopped",
    }).cameras[0]?.capabilities).not.toBeNull();
  });

  /**
   * The mutation this pair is checked against: appending an absent row for
   * every configured camera rather than for every *unmatched* one. A board
   * with its camera plugged in would then draw that camera twice — once
   * streaming, once as missing — which is a page contradicting itself about
   * the camera in front of the operator.
   */
  it("draws a configured camera that is present exactly once, and never also as absent", () => {
    const { cameras } = cameraIndex({
      found: [detection()], rejected: [], cameras: [camera()], run: () => "running",
    });
    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({ id: "front", state: "Streaming" });
  });

  /**
   * Both kinds of row at once, which is the board's actual state: the ELP on
   * a socket nothing is configured for, and two entries left behind by the
   * ports it used to be in. Found rows first — what is attached to this board
   * is still the page's first subject, and an operator scanning for the
   * camera in their hand should not read past two that are not there.
   */
  it("draws what is attached first, and what is configured and absent after it", () => {
    const { cameras } = cameraIndex({
      found: [detection({ byPath: "/dev/v4l/by-path/elp", card: "ELP" })],
      rejected: [],
      cameras: [
        camera({ id: "cam0", name: "Cam1" }),
        // The other port the same physical camera had been in — a different
        // camera, as far as the configuration is concerned (R-CAM-05).
        camera({ id: "cam1", name: "Global Shutter Camera", device: BY_PATH.replace("1.3", "1.1") }),
      ],
      run: () => "stopped",
    });
    expect(cameras.map((c) => c.id)).toEqual([null, "cam0", "cam1"]);
    expect(cameras[0]?.state).toBe("Not configured");
    expect(cameras.slice(1).map((c) => c.state)).toEqual(["Not attached", "Not attached"]);
  });

  /**
   * **Removing a camera is not a way to stop it** (R-CAM-21). The reason is
   * composed here rather than left to the daemon's 409, because this page
   * reads the camera list again after every press — a refusal travelling back
   * on the message is overwritten by the next sweep before anything could
   * draw it, so "with the reason in words" would come to no words at all.
   */
  it("refuses to have a running camera removed, and says why on the row", () => {
    const row = (state: "running" | "starting" | "failed" | "stopped") =>
      cameraIndex({
        found: [detection()], rejected: [], cameras: [camera()], run: () => state,
      }).cameras[0];
    expect(row("running")?.removal).toContain("streaming");
    expect(row("starting")?.removal).toContain("starting");
    // A camera whose pipeline exited is very often one whose device is not
    // there — refusing exactly the entries an operator most needs to clear
    // would be the guard defeating its own purpose.
    expect(row("failed")?.removal).toBeNull();
    expect(row("stopped")?.removal).toBeNull();
  });

  /**
   * The refusal reaches an *absent* row too. A pipeline can outlive the
   * device it was reading from — a camera falling off the bus mid-flight is
   * K-46's whole subject — and the camera being gone is not a reason to pull
   * a running pipeline's configuration out from under it.
   */
  it("still refuses a removal while the pipeline is up, even with no device on the bus", () => {
    const { cameras } = cameraIndex({
      found: [], rejected: [], cameras: [camera()], run: () => "running",
    });
    expect(cameras[0]?.state, "the row says what is true of the device").toBe("Not attached");
    expect(cameras[0]?.removal, "and the key says what is true of the pipeline")
      .toContain("streaming");
  });

  /** A socket nothing is configured for has no entry to remove; it has one to add. */
  it("has nothing to remove on a row that is configured nowhere", () => {
    const { cameras } = cameraIndex({
      found: [detection()], rejected: [], cameras: [], run: () => "stopped",
    });
    expect(cameras[0]?.id).toBeNull();
    expect(cameras[0]?.removal).toContain("nothing to remove");
  });
});

describe("removalRefusal", () => {
  /**
   * One sentence, two readers: `cameraIndex()` puts it on the row so the key
   * is drawn inoperative carrying it, and `daemon/routes.ts` answers its 409
   * with it. Two wordings for one rule is how a page and a daemon come to
   * disagree about why something did not happen.
   */
  it("is exhaustive over the supervisor's four states", () => {
    expect(removalRefusal("running")).toBeTypeOf("string");
    expect(removalRefusal("starting")).toBeTypeOf("string");
    expect(removalRefusal("failed")).toBeNull();
    expect(removalRefusal("stopped")).toBeNull();
  });

  it("names the state and what to do about it, never just 'no'", () => {
    expect(removalRefusal("running")).toContain("stop it");
  });
});

describe("cameraDeck", () => {
  const encoder = { element: "v4l2h264enc", hardware: true };
  const paths = { lan: true, mesh: false, cellular: false };

  /**
   * R-CTL-15, and the reason this block exists at all. The bench camera
   * answers `not-offered` to all three orientation controls — honestly, and
   * `probe/camera.ts` must go on doing so — and the deck must nonetheless
   * draw three working controls, because the board turns the picture when
   * the sensor will not. `not-offered` is the one state orientation is never
   * in, because it is never true of Yonder.
   */
  describe("the three that turn the picture", () => {
    const boolRange = { min: 0, max: 1, step: 1, default: 0, current: 0, inactive: false };
    const degrees = { min: 0, max: 270, step: 90, default: 0, current: 0, inactive: false };

    it("offers all three on a camera whose sensor offers none of them", () => {
      const deck = cameraDeck({ camera: camera(), capabilities: noCapabilities(), encoder, paths });
      expect(deck.orientation.turns.map((t) => t.key))
        .toEqual(["horizontalFlip", "verticalFlip", "rotation"]);
      for (const turn of deck.orientation.turns) expect(turn.by).toBe("board");
      // The state the group must never be in, checked as the absence it is:
      // nothing on this payload's orientation block carries a capability
      // state at all, so a page cannot read one and draw a fact from it.
      for (const turn of deck.orientation.turns) {
        expect(turn).not.toHaveProperty("state");
      }
    });

    it("says which of the two carries the picture, once, beneath the group", () => {
      const board = cameraDeck({ camera: camera(), capabilities: noCapabilities(), encoder, paths });
      expect(board.orientation.says).toContain("cannot turn the picture itself");
      // And not a fourth time beside each control: three copies of one
      // sentence is three times the words and none of the information.
      for (const turn of board.orientation.turns) expect(turn.says).toBeNull();

      const sensor = cameraDeck({
        camera: camera(),
        capabilities: {
          ...noCapabilities(),
          horizontalFlip: present(boolRange), verticalFlip: present(boolRange), rotation: present(degrees),
        },
        encoder,
        paths,
      });
      expect(sensor.orientation.says).toContain("camera turns this picture itself");
      for (const turn of sensor.orientation.turns) expect(turn.says).toBeNull();
    });

    it("names the sensor for the controls the sensor will actually carry", () => {
      const deck = cameraDeck({
        camera: camera(),
        // A camera that mirrors in its sensor and cannot rotate — the mixed
        // case, which is why this is per control and not one answer for the
        // whole group.
        capabilities: { ...noCapabilities(), horizontalFlip: present(boolRange) },
        encoder,
        paths,
      });
      const by = Object.fromEntries(deck.orientation.turns.map((t) => [t.key, t.by]));
      expect(by).toEqual({ horizontalFlip: "sensor", verticalFlip: "board", rotation: "board" });
      // The one case the group's own line cannot carry, so each control says
      // it instead — and the line stands aside and points at them.
      const says = Object.fromEntries(deck.orientation.turns.map((t) => [t.key, t.says]));
      for (const key of Object.keys(says)) expect(typeof says[key], `${key} says nothing`).toBe("string");
      expect(says.horizontalFlip).toMatch(/camera turns this/i);
      expect(says.verticalFlip).toMatch(/board turns this/i);
      expect(says.rotation).toMatch(/board turns this/i);
      expect(deck.orientation.says).toContain("each control says which");
    });

    it("reads a board-turned control from what was stored, not from the device", () => {
      // The sensor has no such control, so there is no reading to have: the
      // stored request is the only fact, and it is the one the pipeline is
      // acting on. `true` reaches the page as 1, the same encoding
      // `commanded` and `applyControls` use.
      const deck = cameraDeck({
        camera: camera({ controls: { horizontalFlip: true, verticalFlip: null, rotation: 180 } as Camera["controls"] }),
        capabilities: noCapabilities(),
        encoder,
        paths,
      });
      const value = Object.fromEntries(deck.orientation.turns.map((t) => [t.key, t.value]));
      expect(value).toEqual({ horizontalFlip: 1, verticalFlip: null, rotation: 180 });
      expect(deck.values.horizontalFlip).toBeUndefined();
    });

    it("reads a sensor-turned control from the device's own read-back (R-CTL-10)", () => {
      const deck = cameraDeck({
        camera: camera({ controls: { horizontalFlip: false, verticalFlip: null, rotation: 0 } as Camera["controls"] }),
        // The device says it is mirrored; the configuration says it is not.
        // A control the sensor holds draws the device, never what was sent.
        capabilities: { ...noCapabilities(), horizontalFlip: present({ ...boolRange, current: 1 }) },
        encoder,
        paths,
      });
      const mirror = deck.orientation.turns.find((t) => t.key === "horizontalFlip");
      expect(mirror?.value).toBe(1);
    });

    it("says the same thing while nothing is turned, because the question is the same", () => {
      // `orientation()`'s own note answers *what is happening to the picture*
      // and says nothing at all at rest — and at rest is exactly when an
      // operator is deciding whether to turn something. The line under the
      // group answers the standing question instead, so it reads the same
      // before and after the mirror goes on.
      const still = cameraDeck({ camera: camera(), capabilities: noCapabilities(), encoder, paths });
      const turned = cameraDeck({
        camera: camera({ controls: { horizontalFlip: true, verticalFlip: null, rotation: 0 } as Camera["controls"] }),
        capabilities: noCapabilities(), encoder, paths,
      });
      expect(still.orientation.says).toBe(turned.orientation.says);
      expect(still.orientation.says).toContain("cannot turn the picture itself");
    });

    it("warns about a quarter turn the board is making, and about no other turn", () => {
      // A transpose swaps the picture's width and height, and the preview's
      // capsfilter is fixed at 640x360 — so an operator who can reach one
      // from this control has to be told from this control.
      const quarter = cameraDeck({
        camera: camera({ controls: { horizontalFlip: null, verticalFlip: null, rotation: 90 } as Camera["controls"] }),
        capabilities: noCapabilities(), encoder, paths,
      });
      expect(quarter.orientation.says).toContain("swaps its width and height");

      const half = cameraDeck({
        camera: camera({ controls: { horizontalFlip: null, verticalFlip: null, rotation: 180 } as Camera["controls"] }),
        capabilities: noCapabilities(), encoder, paths,
      });
      expect(half.orientation.says).not.toContain("quarter turn");

      // The sensor's own quarter turn costs nothing on this board, so it
      // carries no warning: the clause is about what the pipeline is doing.
      const atSensor = cameraDeck({
        camera: camera({ controls: { horizontalFlip: null, verticalFlip: null, rotation: 90 } as Camera["controls"] }),
        capabilities: {
          ...noCapabilities(),
          horizontalFlip: present(boolRange), verticalFlip: present(boolRange), rotation: present(degrees),
        },
        encoder, paths,
      });
      expect(atSensor.orientation.says).not.toContain("quarter turn");
    });

    it("still offers all three for a camera that answered nothing at all", () => {
      // `capabilities: null` is a probe that failed, not a camera that said
      // no. Every other group falls back to `noCapabilities()` and draws
      // facts; this one still draws controls, because the board can turn a
      // picture from a camera the probe could not read.
      const deck = cameraDeck({ camera: camera(), capabilities: null, encoder, paths });
      expect(deck.orientation.turns).toHaveLength(3);
      for (const turn of deck.orientation.turns) expect(turn.by).toBe("board");
    });
  });

  it("draws descriptors and values from the device, in display units", () => {
    const deck = cameraDeck({
      camera: camera(),
      capabilities: { ...noCapabilities(), brightness: present({ ...range, current: 64 }) },
      encoder,
      paths,
    });
    expect(deck.descriptors.brightness?.current).toBe(64);
    expect(deck.values.brightness).toBe(64);
    // A capability the device did not offer gets neither, so the deck draws a
    // fact rather than a control with an invented range (R-UI-20).
    expect(deck.descriptors.contrast).toBeUndefined();
  });

  /**
   * **`policy` is the configuration's and `applied` is a second name for it**
   * — equal today because nothing tracks a running pipeline's own settings,
   * kept apart because a respawn in flight is when they differ, and the deck
   * compares its draft against `applied` alone.
   */
  it("carries the stream and preview policy from the configuration, twice over", () => {
    const deck = cameraDeck({ camera: camera(), capabilities: null, encoder, paths });
    expect(deck.policy.stream).toMatchObject({ mode: "fixed", bitrate_kbps: 2000 });
    expect(deck.policy.preview).toMatchObject({ mode: "adaptive", size: "auto" });
    expect(deck.applied).toEqual(deck.policy);
  });

  /**
   * **The capture, as values and not only as a sentence** (R-VID-07,
   * R-CAM-14).
   *
   * `camera.spec` said `1280×720p30` before this block existed and that is
   * all it said: a string for a placard, which no picker can be set from and
   * which `YonderDeck.appliedForDraft()` cannot compare a staged `width`
   * against. The deck stages `width`, `height` and `framerate` under exactly
   * these names, so with nothing here to compare them to every staged size
   * would read pending for ever and `interruption()` would warn of a restart
   * for the size already running.
   */
  it("carries the capture the configuration holds, beside stream and preview", () => {
    const deck = cameraDeck({ camera: camera(), capabilities: null, encoder, paths });
    expect(deck.policy.capture).toEqual({ width: 1280, height: 720, framerate: 30, codec: "h264" });
    expect(deck.applied.capture).toEqual(deck.policy.capture);
  });

  /**
   * The values, not a restatement of the schema's defaults — a mutant that
   * wrote `1280`/`720`/`30` in this function would pass the test above and
   * fail this one.
   */
  it("carries this camera's own capture, not the shipped defaults", () => {
    const deck = cameraDeck({
      camera: camera({ width: 1920, height: 1080, framerate: 15 } as Partial<Camera>),
      capabilities: null, encoder, paths,
    });
    expect(deck.policy.capture).toEqual({ width: 1920, height: 1080, framerate: 15, codec: "h264" });
    // ...and the placard still says the same thing in words, so the two
    // cannot drift into disagreeing about one camera.
    expect(deck.camera.spec).toContain("1920×1080p15");
  });

  /** R-UI-24: an output states which way it has to travel and whether it can. */
  it("states each output's reach, from the paths this board actually has", () => {
    const behindNat = cameraDeck({
      camera: camera({
        outputs: [
          { kind: "rtp", host: "192.168.77.20", port: 5600, enabled: true },
          { kind: "rtsp", password: { secret: "rtsp_password" }, enabled: false },
        ],
      } as Partial<Camera>),
      capabilities: null,
      encoder,
      paths: { lan: false, mesh: false, cellular: true },
    });
    expect(behindNat.outputs[0]).toMatchObject({ kind: "rtp", enabled: true });
    expect(behindNat.outputs[0]?.reach.reachable).toBe(true);
    // A listener cannot be dialled from behind a carrier's NAT, and a stopped
    // output keeps everything but its `enabled`.
    expect(behindNat.outputs[1]).toMatchObject({ kind: "rtsp", enabled: false });
    expect(behindNat.outputs[1]?.reach.reachable).toBe(false);
  });

  /**
   * Board recording (§8.3) is unbuilt, so there is nothing to count.
   *
   * And **no `interruption` field at all**: what a draft would interrupt is a
   * fact about a draft this daemon has never seen, so an empty array here was
   * a promise the payload could not keep — `YonderDeck` drew it and the
   * warning never appeared. The deck computes it from its own staged draft
   * now. Asserted as absent rather than as `[]`, because `[]` is exactly the
   * value that made the defect invisible.
   */
  it("counts no captures, and promises no interruption it cannot know", () => {
    const deck = cameraDeck({ camera: camera(), capabilities: null, encoder, paths });
    expect(deck.captures).toEqual({ count: 0 });
    expect(Object.prototype.hasOwnProperty.call(deck, "interruption")).toBe(false);
  });

  /**
   * The count and the recorder are the *caller's* facts, carried rather than
   * found (R-CAM-17, R-CAM-18, R-STO-06). A caller with no video layer at all
   * passes neither, and the two absences are separate: a device that is not
   * recording still holds every capture it made before it stopped.
   */
  it("carries the recorder and the count it was given, and says null where it was given nothing", () => {
    const recorder = {
      recording: true, since: 1_700_000_000_000, destination: "board" as const,
      remainingSeconds: 7080, remainingPhotos: 3900, bytes: 4_100_000, ended: null,
    };
    const told = cameraDeck({
      camera: camera(), capabilities: null, encoder, paths, recorder, captures: 3,
    });
    expect(told.recorder).toEqual(recorder);
    expect(told.captures).toEqual({ count: 3 });

    const untold = cameraDeck({ camera: camera(), capabilities: null, encoder, paths });
    // Not `{ recording: false }`: that would be this payload claiming to know
    // something it has no source for.
    expect(untold.recorder).toBeNull();
  });
});

/**
 * The sentences the capture column, the picture's banner and the captures
 * panel share about one recorder (R-CAM-17, R-STO-06; blueprint L-45, L-46).
 *
 * Three surfaces say the same thing about the same fact, so it is said once.
 * The tests that matter here are the two the blueprint's own two rows are
 * about — a unit that follows the mode — and the one an operator acts on
 * differently from every other: *nothing knows* is not *none left*.
 */
/**
 * The board records a camera that cannot record itself (R-CAM-17, R-CAM-18).
 *
 * Read through the device's own answer, every camera this project has would
 * draw no shutter key at all: a USB camera has no card and no shutter, and
 * `probe/camera.ts` says so honestly. The board records it off its own
 * pipeline, so the question the deck asks is *who would carry a capture*.
 * Exactly the reasoning `deckOrientation()` already carries, one group along.
 */
describe("deckCapture", () => {
  const board: RecordingState = {
    recording: false, since: null, destination: "board",
    remainingSeconds: 7_080, remainingPhotos: 3_900, bytes: null, ended: null,
  };

  it("gives the board's own recorder to a camera that offers neither", () => {
    const caps = noCapabilities();
    expect(deckCapture(caps, board)).toEqual({
      recording: { state: "present", value: { medium: "board" } },
      stills: { state: "present", value: { source: "pipeline" } },
    });
  });

  it("leaves a camera that answered for itself alone", () => {
    // The device saying *this is mine* outranks anything composed here, which
    // is what makes this an addition rather than an override.
    const own = {
      ...noCapabilities(),
      recording: present({ medium: "camera" as const }),
      stills: present({ source: "camera" as const }),
    };
    expect(deckCapture(own, board)).toEqual({
      recording: own.recording, stills: own.stills,
    });
  });

  it("says nothing on a daemon with no recorder at all", () => {
    // `not-offered` stands where nothing here can record: an operator must be
    // able to tell *this device cannot* from *this page failed*.
    const caps = noCapabilities();
    expect(deckCapture(caps, null)).toEqual({
      recording: caps.recording, stills: caps.stills,
    });
  });

  it("reaches the deck, so the capture column is drawn at all", () => {
    const deck = cameraDeck({
      camera: camera(),
      capabilities: null,
      encoder: { element: "v4l2h264enc", hardware: true },
      paths: { lan: true, mesh: false, cellular: false },
      recorder: board,
    });
    expect(deck.capabilities.recording).toEqual({ state: "present", value: { medium: "board" } });
    expect(deck.capabilities.stills).toEqual({ state: "present", value: { source: "pipeline" } });
  });
});

describe("captureDestination", () => {
  const state = (over: Partial<RecordingState> = {}): RecordingState => ({
    recording: false, since: null, destination: "board",
    remainingSeconds: 7_080, remainingPhotos: 3_900, bytes: null, ended: null,
    ...over,
  });

  it("counts minutes in Video and photographs in Photo, off the same reading", () => {
    expect(captureDestination(state(), "video")).toBe("to this board · 118 min free");
    expect(captureDestination(state(), "photo")).toBe("to this board · 3900 photos free");
  });

  it("rounds a part-minute down, because an optimistic figure costs the recording", () => {
    expect(captureDestination(state({ remainingSeconds: 119 }), "video"))
      .toBe("to this board · 1 min free");
  });

  it("says the medium it cannot measure is unmeasured, never that it is full", () => {
    // Opposite facts, and an operator acts differently on each: *0 min free*
    // is a card to clear, *nothing knows* is a card this device does not hold.
    const camera = state({ destination: "camera", remainingSeconds: null, remainingPhotos: null });
    expect(captureDestination(camera, "video"))
      .toBe("to the camera's card · this device cannot see what is left on it");
    expect(captureDestination(state({ remainingSeconds: 0 }), "video"))
      .toBe("to this board · 0 min free");
  });

  it("says nothing at all where there is no recorder to say it about", () => {
    expect(captureDestination(null, "video")).toBe("");
  });
});

describe("endedWords", () => {
  const stopped = (ended: { at: number; reason: string } | null): RecordingState => ({
    recording: false, since: null, destination: "board",
    remainingSeconds: 0, remainingPhotos: 0, bytes: null, ended,
  });

  it("names the reserve, in the recorder's own words, when it ended by itself", () => {
    expect(endedWords(stopped({ at: 5, reason: "the card reached the 1024 MB reserve" })))
      .toBe("the recording ended by itself · the card reached the 1024 MB reserve");
  });

  it("says nothing after a stop somebody pressed", () => {
    // A sentence under the key after every stop would train an operator to
    // stop reading it, and this is the one line they must read.
    expect(endedWords(stopped(null))).toBe("");
  });

  it("says nothing while one is running", () => {
    expect(endedWords({
      recording: true, since: 1, destination: "board", remainingSeconds: 10,
      remainingPhotos: 10, bytes: 5, ended: { at: 1, reason: "an older one" },
    })).toBe("");
  });
});

describe("heldWords", () => {
  it("gives the two media the words three surfaces all say", () => {
    expect(heldWords("board")).toBe("this board");
    expect(heldWords("camera")).toBe("the camera's card");
  });
});

describe("aimPanel", () => {
  it("draws nothing but a fact for a camera with no gimbal", () => {
    expect(aimPanel(noCapabilities())).toMatchObject({ state: "not-offered", bounds: null });
  });

  it("keeps the panel and carries the reason for one that advertises and does not answer", () => {
    const panel = aimPanel({
      ...noCapabilities(),
      aim: advertised("advertises pan and tilt but there is no motor behind either"),
    });
    expect(panel.state).toBe("advertised");
    expect(panel.reason).toContain("no motor");
  });

  /**
   * **A reported position is a fact nothing reports yet**, and an envelope is
   * only drawn where the device answered both ends of both axes. §8.7's 20 Hz
   * attitude push is unbuilt; a zero here would be a claim about where a
   * gimbal is pointing that nothing measured — the same defect as an
   * unmeasured rate one field over.
   *
   * And the panel is inhibited, because R-CMD-04's motion guard is unbuilt:
   * a pad that could send a rate with no bounds check behind it would be the
   * console deciding what is safe.
   */
  it("answers bounds where the device gave them, and no position at all", () => {
    const panel = aimPanel({
      ...noCapabilities(),
      aim: present({
        yaw: { min: -180, max: 180 },
        pitch: { min: -90, max: 30 },
        mode: "follow",
      }),
    });
    expect(panel.state).toBe("present");
    expect(panel.bounds).toEqual({ pan: [-180, 180], tilt: [-90, 30] });
    expect(panel.pan).toBeNull();
    expect(panel.tilt).toBeNull();
    expect(panel.mode).toBe("follow");
    expect(panel.modes).toEqual([]);
    expect(panel.inhibited).toContain("guard is not built");
  });

  it("draws no envelope at all where only one end of an axis was answered", () => {
    const panel = aimPanel({
      ...noCapabilities(),
      aim: present({
        yaw: { min: -180, max: null },
        pitch: { min: -90, max: 30 },
        mode: "follow",
      }),
    });
    // Half an envelope is not an envelope: a gauge drawn against a bound
    // nothing reported puts a scale on the page no device agreed to.
    expect(panel.bounds).toBeNull();
  });
});

/**
 * The strip under the picture (R-VID-14, R-VID-11; blueprint L-20, L-22).
 *
 * Composed here, from the camera index and each camera's latest still, so
 * the words and the addresses have a test — and so a `change` node in
 * `flows.json` moves an object rather than assembling one (CLAUDE.md rule 2).
 */
describe("thumbStrip", () => {
  const NOW = 1_700_000_010_000;
  const nose = camera({ id: "nose", name: "Nose" });
  const tail = camera({ id: "tail", name: "Tail" });
  const belly = camera({ id: "belly", name: "Belly" });
  const running = (): RunState => "running";

  it("draws one thumb per camera, in configured order, the active one first-class among them", () => {
    const strip = thumbStrip({
      cameras: [nose, tail, belly], active: "tail", run: running,
      still: (id) => (id === "nose" ? { at: NOW - 4_200 } : id === "tail" ? { at: NOW - 1_000 } : null),
      now: NOW, stillsKbps: 12.4,
    });
    expect(strip.cameras.map((c) => c.id)).toEqual(["nose", "tail", "belly"]);
    expect(strip.cameras.map((c) => c.active)).toEqual([false, true, false]);
    expect(strip.cameras.map((c) => c.name)).toEqual(["Nose", "Tail", "Belly"]);
  });

  it("gives the others a still's age in whole seconds and an address that changes with the frame", () => {
    const at = NOW - 4_200;
    const strip = thumbStrip({
      cameras: [nose, tail], active: "tail", run: running,
      still: (id) => (id === "nose" ? { at } : null),
      now: NOW, stillsKbps: 0,
    });
    const [other] = strip.cameras;
    expect(other).toMatchObject({ id: "nose", ageSeconds: 4, stopped: false });
    // The address is the one the console serves, with the frame's own
    // stamp on it: a new still is a new address, so a browser re-fetches
    // exactly when there is something new — never a cached frame under a
    // fresh age, never the same frame twice.
    expect(other?.thumbSrc).toBe(`${stillUrl("nose")}?at=${String(at)}`);
    const later = thumbStrip({
      cameras: [nose, tail], active: "tail", run: running,
      still: () => ({ at: at + 5_000 }), now: NOW + 5_000, stillsKbps: 0,
    });
    expect(later.cameras[0]?.thumbSrc).not.toBe(other?.thumbSrc);
  });

  it("gives the active camera no still to fetch: its picture is the live one above", () => {
    const strip = thumbStrip({
      cameras: [nose, tail], active: "nose", run: running,
      still: () => ({ at: NOW - 1_000 }), now: NOW, stillsKbps: 0,
    });
    expect(strip.cameras[0]).toMatchObject({ id: "nose", active: true, thumbSrc: null });
    expect(strip.cameras[1]?.thumbSrc).not.toBeNull();
  });

  it("draws a stopped camera as stopped, never as a stale frame", () => {
    const strip = thumbStrip({
      cameras: [nose, tail], active: "nose",
      run: (id) => (id === "tail" ? "stopped" : "running"),
      // Even where a still is on offer for it — a frame from before the
      // pipeline stopped is not what the camera sees.
      still: () => ({ at: NOW - 1_000 }), now: NOW, stillsKbps: 0,
    });
    expect(strip.cameras[1]).toEqual({
      id: "tail", name: "Tail", active: false, ageSeconds: null, thumbSrc: null, stopped: true,
    });
    // `failed` is stopped too; `starting` is not.
    expect(thumbStrip({
      cameras: [tail], active: "nose", run: () => "failed", still: () => null, now: NOW, stillsKbps: 0,
    }).cameras[0]?.stopped).toBe(true);
    expect(thumbStrip({
      cameras: [tail], active: "nose", run: () => "starting", still: () => null, now: NOW, stillsKbps: 0,
    }).cameras[0]?.stopped).toBe(false);
  });

  it("draws a running camera with no still yet as waiting, not as stopped", () => {
    const strip = thumbStrip({
      cameras: [nose, tail], active: "nose", run: running, still: () => null, now: NOW, stillsKbps: 0,
    });
    expect(strip.cameras[1]).toMatchObject({ ageSeconds: null, thumbSrc: null, stopped: false });
  });

  it("never reports a negative age for a still stamped ahead of this composition", () => {
    const strip = thumbStrip({
      cameras: [nose, tail], active: "nose", run: running,
      still: () => ({ at: NOW + 400 }), now: NOW, stillsKbps: 0,
    });
    expect(strip.cameras[1]?.ageSeconds).toBe(0);
  });

  it("states what every still copy costs, in the blueprint's own words, counted in the path total", () => {
    expect(thumbStrip({
      cameras: [nose], active: "nose", run: running, still: () => null, now: NOW, stillsKbps: 12.4,
    }).downlink).toBe("12 kb/s of stills · counted in Path total");
    expect(thumbStrip({
      cameras: [nose], active: "nose", run: running, still: () => null, now: NOW, stillsKbps: 0,
    }).downlink).toBe("0 kb/s of stills · counted in Path total");
    // Never uppercased on the page — `kb/s` as `KB/S` says kilobytes — and
    // the unit is kb/s because stills are small against the Mb/s beside them.
    expect(thumbStrip({
      cameras: [nose], active: "nose", run: running, still: () => null, now: NOW, stillsKbps: 165.5,
    }).downlink).toMatch(/^166 kb\/s of stills/);
  });
});
