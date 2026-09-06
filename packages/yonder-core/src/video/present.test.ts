// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  aimPanel,
  ASSUMED_UPLINK_KBPS,
  atIp,
  cameraDeck,
  cameraIndex,
  cameraStrip,
  capabilityFacts,
  identityWords,
  LABELS,
  uplinkBudget,
} from "./present.js";
import { advertised, gated, noCapabilities, notOffered, present } from "./capability.js";
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
        "Auto exposure", "Auto focus",
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
    // One row per `CAPABILITY_KEYS` entry — eleven before this task's ten.
    expect(capabilityFacts(noCapabilities())).toHaveLength(21);
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
});

describe("cameraDeck", () => {
  const encoder = { element: "v4l2h264enc", hardware: true };
  const paths = { lan: true, mesh: false, cellular: false };

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
