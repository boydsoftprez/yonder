// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyCameraDraft, deckDraft, draftPathFor, interruption, validateDraft } from "./draft.js";
import { DRAFT_PATHS } from "./draft-shape.js";
import { Camera, ConfigSchema, DEFAULT_CONFIG, PREVIEW_RUNGS, type Config } from "../schema/config.js";

const RUNGS = [...PREVIEW_RUNGS];

it('stages preview codec independently and reports its pipeline restart', () => {
  const { draft } = deckDraft({ previewCodec: 'h265' });
  expect(draft).toEqual({ preview: { codec: 'h265' } });
  expect(interruption(draft, {})).toContain('restarts the picture');
  expect(interruption(deckDraft({ previewCodec: 'h264' }).draft, {})).toEqual([]);
});

/** The smallest real document with one camera in it, parsed by the schema so
 * every default is the schema's own rather than a copy of them here. */
function configWithCamera(): Config {
  return ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    cameras: [{
      id: "front",
      name: "Front camera",
      source: "usb",
      device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    }],
  });
}

describe("validateDraft", () => {
  it("names floor > ceiling and does not fix it", () => {
    expect(validateDraft({ preview: { floor_kbps: 2000, ceiling_kbps: 300 } }, RUNGS))
      .toEqual([expect.objectContaining({ path: "preview.floor_kbps" })]);
    // Never repaired: the values themselves stay exactly as given, and the
    // caller gets a problem list back, not a corrected draft.
    const draft = { preview: { floor_kbps: 2000, ceiling_kbps: 300 } };
    validateDraft(draft, RUNGS);
    expect(draft).toEqual({ preview: { floor_kbps: 2000, ceiling_kbps: 300 } });
  });

  // The brief's own check is on `preview`; `stream` carries the identical
  // Floor · Ceiling control (spec §7) and would silently escape this rule if
  // the two scopes were not each wired to it.
  it("names floor > ceiling on stream too, not only preview", () => {
    expect(validateDraft({ stream: { floor_kbps: 5000, ceiling_kbps: 1000 } }, RUNGS))
      .toEqual([expect.objectContaining({ path: "stream.floor_kbps" })]);
  });

  it("says nothing about floor and ceiling when only one side of the draft carries them", () => {
    // A draft is partial by construction: an operator who has only touched
    // the floor has not yet said anything about the ceiling, and that is not
    // the same fault as having set the floor above it.
    expect(validateDraft({ preview: { floor_kbps: 2000 } }, RUNGS)).toEqual([]);
    expect(validateDraft({ stream: { ceiling_kbps: 500 } }, RUNGS)).toEqual([]);
  });

  it("refuses a held size the camera cannot make", () => {
    // "auto" is always legal; a pinned size must be a rung this camera offers.
    const problems = validateDraft({ preview: { size: "1280x720" } }, ["854x480", "640x360"]);
    expect(problems).toEqual([expect.objectContaining({ path: "preview.size" })]);
    expect(validateDraft({ preview: { size: "auto" } }, ["854x480"])).toEqual([]);
  });

  // The given test above never pins a size that *is* offered, so an
  // implementation that flags every non-"auto" size regardless of
  // `supportedRungs` — ignoring the argument entirely — would still pass it.
  // This is the test that catches that.
  it("accepts a held size the camera does offer", () => {
    expect(validateDraft({ preview: { size: "854x480" } }, ["1280x720", "854x480", "640x360"]))
      .toEqual([]);
  });

  it("names the smallest automatic size being larger than the largest", () => {
    expect(validateDraft({ preview: { ladder_bottom: "1280x720", ladder_top: "640x360" } }, RUNGS))
      .toEqual([expect.objectContaining({ path: "preview.ladder_bottom" })]);
  });

  it("accepts the ladder the other way round, and accepts the two ends equal", () => {
    expect(validateDraft({ preview: { ladder_bottom: "640x360", ladder_top: "1280x720" } }, RUNGS))
      .toEqual([]);
    expect(validateDraft({ preview: { ladder_bottom: "854x480", ladder_top: "854x480" } }, RUNGS))
      .toEqual([]);
  });

  it("reports every problem a draft has, not only the first one found", () => {
    // Proves the three checks are independent rather than one short-circuiting
    // the others — a draft wrong in two ways at once must say so twice.
    const problems = validateDraft({
      preview: {
        floor_kbps: 2000, ceiling_kbps: 300,
        ladder_bottom: "1280x720", ladder_top: "640x360",
        size: "1280x720",
      },
    }, ["854x480"]);
    expect(problems.map((p) => p.path).sort()).toEqual([
      "preview.floor_kbps", "preview.ladder_bottom", "preview.size",
    ]);
  });

  it("says nothing about a draft with nothing wrong with it", () => {
    expect(validateDraft({
      width: 1920, height: 1080, framerate: 30, codec: "h264",
      stream: { mode: "adaptive", floor_kbps: 1000, ceiling_kbps: 5000 },
      preview: {
        mode: "adaptive", size: "854x480", ladder_bottom: "640x360", ladder_top: "1280x720",
        floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
      },
    }, RUNGS)).toEqual([]);
  });
});

describe("interruption", () => {
  it("says restarts the picture for a source change, preview branch only for a rung", () => {
    expect(interruption({ width: 1920 }, { width: 1280 })).toEqual(["restarts the picture"]);
    expect(interruption({ preview: { size: "640x360" } }, { preview: { size: "854x480" } }))
      .toEqual(["preview branch only"]);
    expect(interruption({ preview: { ceiling_kbps: 1500 } }, { preview: { ceiling_kbps: 2000 } }))
      .toEqual([]);
  });

  // The given case above only ever compares a *different* value. An
  // implementation that fires on "the draft touched this field" rather than
  // "the draft's value differs from what is applied" would still pass it —
  // this is the test that catches that, on both branches interruption has.
  it("says nothing when the draft repeats the value already applied", () => {
    expect(interruption({ width: 1280 }, { width: 1280 })).toEqual([]);
    expect(interruption({ preview: { size: "auto" } }, { preview: { size: "auto" } })).toEqual([]);
  });

  it("says nothing at all for two empty drafts", () => {
    expect(interruption({}, {})).toEqual([]);
  });

  it("groups height, framerate and codec with width, as the same source change", () => {
    expect(interruption({ height: 1080 }, { height: 720 })).toEqual(["restarts the picture"]);
    expect(interruption({ framerate: 60 }, { framerate: 30 })).toEqual(["restarts the picture"]);
    expect(interruption({ codec: "h264" }, {})).toEqual(["restarts the picture"]);
  });

  // Spec §8.1 names "preview-only size/rate reconfiguration" as one
  // mechanism; the given test only drives size, so rate needs its own case.
  it("treats a preview rate change the same as a rung change", () => {
    expect(interruption({ preview: { framerate: 30 } }, { preview: { framerate: 15 } }))
      .toEqual(["preview branch only"]);
  });

  it("reports both interruptions when a draft touches both a source field and a preview rung", () => {
    expect(interruption(
      { width: 1920, preview: { size: "640x360" } },
      { width: 1280, preview: { size: "854x480" } },
    )).toEqual(["restarts the picture", "preview branch only"]);
  });

  it("does not confuse a stream bitrate change for anything else", () => {
    // stream carries no size/rate concept parallel to preview's; only its
    // floor/ceiling/mode exist, and none of those interrupt anything.
    expect(interruption({ stream: { mode: "adaptive", floor_kbps: 1000, ceiling_kbps: 5000 } }, {}))
      .toEqual([]);
  });
});

describe("deckDraft — the seam between the deck's names and the schema's", () => {
  /**
   * `YonderDeck` stages under the blueprint's UI-facing names, flat, because
   * the browser's own `pending(camera, applied)` compares one flat map
   * spanning both the image-control domain and this one. The configuration is
   * nested and schema-cased. Getting this wrong is silent: a path nobody
   * translates is an Apply that reports success and changes nothing.
   */
  it("renames every path the deck stages, into the shape the config has", () => {
    const { draft, name, unknown } = deckDraft({
      name: "Nose mast",
      streamMode: "Adaptive",
      streamFloor: 500,
      streamCeiling: 3000,
      streamBitrate: 2500,
      previewMode: "Fixed",
      previewSize: "854x480",
      previewLadderBottom: "640x360",
      previewLadderTop: "1280x720",
      previewFloor: 200,
      previewCeiling: 1500,
      previewBitrate: 600,
      previewRate: 15,
    });
    expect(unknown).toEqual([]);
    expect(name).toBe("Nose mast");
    expect(draft).toEqual({
      // The Fixed target is a camera leaf, not a `stream` one — the one path
      // whose two sides land in different places, which is why this seam is
      // a function and not a rename table.
      bitrate_kbps: 2500,
      stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 3000 },
      preview: {
        mode: "fixed", size: "854x480",
        ladder_bottom: "640x360", ladder_top: "1280x720",
        floor_kbps: 200, ceiling_kbps: 1500, bitrate_kbps: 600, framerate: 15,
      },
    });
  });

  /** A draft is partial at every level: an untouched field is not a field. */
  it("carries only what was staged, and no empty sub-objects", () => {
    expect(deckDraft({ previewRate: 30 }).draft).toEqual({ preview: { framerate: 30 } });
    expect(deckDraft({}).draft).toEqual({});
  });

  /**
   * **Named, never dropped.** A browser holding a draft from a console two
   * versions back is the case: ignoring the field it cannot apply would be an
   * Apply that reported success and left one edit unmade.
   */
  it("names a staged path it does not know rather than discarding it", () => {
    const { draft, unknown } = deckDraft({ streamFloor: 500, streamWobble: 1, brightness: 64 });
    expect(unknown).toEqual(["streamWobble", "brightness"]);
    expect(draft).toEqual({ stream: { floor_kbps: 500 } });
  });

  /** Both casings of a mode, because the deck sends the UI one and a test
   * or a script may send the schema's. Anything else is not a mode. */
  it("takes a mode in either casing, and nothing else", () => {
    expect(deckDraft({ streamMode: "Adaptive" }).draft.stream?.mode).toBe("adaptive");
    expect(deckDraft({ streamMode: "fixed" }).draft.stream?.mode).toBe("fixed");
    expect(deckDraft({ streamMode: "sideways" }).draft.stream?.mode).toBeUndefined();
  });
});

describe("applyCameraDraft", () => {
  it("writes only what the draft carries, and leaves the rest of the document alone", () => {
    const before = configWithCamera();
    const out = applyCameraDraft(before, "front", { framerate: 25, preview: { framerate: 10 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const camera = out.config.cameras[0]!;
    expect(camera.framerate).toBe(25);
    expect(camera.preview.framerate).toBe(10);
    // A spread of the draft over the camera would have written
    // `stream: undefined` over a real envelope for a draft that never
    // mentioned it — which is the whole reason this is not a spread.
    expect(camera.preview.bitrate_kbps).toBe(before.cameras[0]!.preview.bitrate_kbps);
    expect(camera.stream).toEqual(before.cameras[0]!.stream);
    // And the document it was given is untouched.
    expect(before.cameras[0]!.framerate).not.toBe(25);
  });

  it("refuses a camera that is not configured", () => {
    const out = applyCameraDraft(configWithCamera(), "nose", { framerate: 25 });
    expect(out.ok).toBe(false);
  });
});

describe("a turn the board performs", () => {
  it("warns that it restarts the picture, because it does", () => {
    // It is an element in the launch line, so the line differs, so the
    // pipeline respawns. This reached the operator empty once: the Apply
    // confirmed, the picture cut, and nothing had said it would.
    expect(interruption({ controls: { horizontalFlip: true } }, { controls: { horizontalFlip: false } }))
      .toContain("restarts the picture");
    expect(interruption({ controls: { rotation: 90 } }, { controls: { rotation: 0 } }))
      .toContain("restarts the picture");
  });

  it("says nothing when the turn is the one the camera already has", () => {
    // Staged and unstaged before Apply. A warning about a restart that will
    // not happen teaches an operator to stop reading them.
    expect(interruption({ controls: { horizontalFlip: true } }, { controls: { horizontalFlip: true } }))
      .toEqual([]);
  });


  /**
   * **Every other field was carried and this one was dropped, silently.**
   *
   * `deckDraft()` translated it, `validateDraft()` passed it, the route
   * answered 200 with a confirmation id — and the value never reached the
   * camera. The operator would have pressed Mirror, watched it confirm, and
   * seen nothing turn.
   */
  it("reaches the camera, so an Apply that says it worked did", () => {
    const before = configWithCamera();
    const out = applyCameraDraft(before, "front", { controls: { horizontalFlip: true } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.config.cameras[0]?.controls.horizontalFlip).toBe(true);
  });

  it("leaves every other control alone, because a draft names one thing", () => {
    const before = configWithCamera();
    before.cameras[0]!.controls.brightness = 40;
    const out = applyCameraDraft(before, "front", { controls: { verticalFlip: true } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Assigning rather than merging would set this back to the schema's null
    // and quietly undo a control the operator had set.
    expect(out.config.cameras[0]?.controls.brightness).toBe(40);
    expect(out.config.cameras[0]?.controls.verticalFlip).toBe(true);
  });
});

describe("DRAFT_PATHS — one table, read in both directions", () => {
  /**
   * **The agreement check.** `deckDraft()` is a `switch` and `DRAFT_PATHS` is
   * a map; nothing in the language holds them to each other, and two
   * hand-kept lists of thirteen names are two chances to disagree. So every
   * key in the map is fed to `deckDraft` and the resulting draft is walked to
   * the dotted place the map claims it lands in. A path added to one and not
   * the other fails here rather than as a refusal message that never finds
   * its field.
   */
  it("puts every path it names where it says it does", () => {
    for (const [ui, path] of Object.entries(DRAFT_PATHS)) {
      // A value distinguishable from `undefined` for every field, whatever
      // its type — a mode has to be a word `fromUiMode` recognises.
      const value = ui.endsWith("Mode") ? "Adaptive" : 7;
      const { draft, unknown } = deckDraft({ [ui]: value });
      expect(unknown, `${ui} is in the table and unknown to deckDraft`).toEqual([]);
      const landed = path.split(".").reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k], draft,
      );
      expect(landed, `${ui} should land at ${path}`).toBeDefined();
    }
  });

  /** And the reverse, which is what puts a refusal's message on the row it
   * belongs to: the deck knows `previewFloor`, the route answers
   * `preview.floor_kbps`. */
  it("finds the staged path a schema-keyed problem is about", () => {
    expect(draftPathFor("preview.floor_kbps")).toBe("previewFloor");
    expect(draftPathFor("bitrate_kbps")).toBe("streamBitrate");
    expect(draftPathFor("somewhere.else")).toBeNull();
  });
});

describe('staged output enablement', () => {
  it('translates output controls and rejects non-boolean values before apply', () => {
    const translated = deckDraft({ outputRtp: false, outputRtsp: true });
    expect(translated.unknown).toEqual([]);
    expect(translated.draft.outputs).toEqual({ rtp: false, rtsp: true });
    expect(validateDraft({ outputs: { rtsp: 'yes' } } as any, [])).toEqual([{ path: 'outputs.rtsp', message: 'Output enablement must be true or false' }]);
  });
  it('merges output switches without changing destinations and refuses unconfigured kinds', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cameras = [Camera.parse({ id: 'cam0', name: 'Camera', source: 'usb', device: 'test-camera', outputs: [{ kind: 'rtp', host: '192.0.2.1', port: 5600, enabled: true }] })];
    const result = applyCameraDraft(config, 'cam0', { outputs: { rtp: false } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cameras[0].outputs).toEqual([{ ...config.cameras[0].outputs[0], enabled: false }]);
    expect(config.cameras[0].outputs[0].enabled).toBe(true);
    const rtsp = applyCameraDraft(config, 'cam0', { outputs: { rtsp: true } });
    expect(rtsp.ok).toBe(true);
    if (rtsp.ok) expect(rtsp.config.cameras[0].outputs).toContainEqual({ kind: 'rtsp', enabled: true, password: { secret: 'rtsp_password' } });
    expect(config.cameras[0].outputs).toHaveLength(1);
  });
  it('stages, validates, and applies an RTP destination without guessing one', () => {
    const translated = deckDraft({ rtpHost: '192.0.2.44', rtpPort: 5604, outputRtp: true });
    expect(translated.draft.outputs).toEqual({ rtpHost: '192.0.2.44', rtpPort: 5604, rtp: true });
    expect(validateDraft({ outputs: { rtpHost: 'receiver', rtpPort: 0 } }, [])).toEqual([
      { path: 'outputs.rtpHost', message: 'must be an IPv4 address, for example 192.168.1.50' },
      { path: 'outputs.rtpPort', message: 'must be a whole port number from 1 to 65535' },
    ]);

    const config = structuredClone(DEFAULT_CONFIG);
    config.cameras = [Camera.parse({ id: 'cam0', name: 'Camera', source: 'usb', device: 'test-camera', outputs: [] })];
    const added = applyCameraDraft(config, 'cam0', translated.draft);
    expect(added).toMatchObject({ ok: true });
    if (added.ok) expect(added.config.cameras[0].outputs).toEqual([
      { kind: 'rtp', host: '192.0.2.44', port: 5604, enabled: true },
    ]);
    // Disabling an absent output is a no-op; it cannot invent a destination.
    expect(applyCameraDraft(config, 'cam0', { outputs: { rtp: false } })).toMatchObject({ ok: true });
  });
  it('adds a typed but disabled RTP destination until the operator enables it', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cameras = [Camera.parse({ id: 'cam0', name: 'Camera', source: 'usb', device: 'test-camera', outputs: [] })];
    const added = applyCameraDraft(config, 'cam0', { outputs: { rtpHost: '192.0.2.44', rtpPort: 5604 } });
    expect(added).toMatchObject({ ok: true });
    if (added.ok) expect(added.config.cameras[0].outputs).toEqual([
      { kind: 'rtp', host: '192.0.2.44', port: 5604, enabled: false },
    ]);
  });
  it('changes an RTP destination and preserves it while stopping the output', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cameras = [Camera.parse({ id: 'cam0', name: 'Camera', source: 'usb', device: 'test-camera', outputs: [{ kind: 'rtp', host: '192.0.2.1', port: 5600 }] })];
    const changed = applyCameraDraft(config, 'cam0', { outputs: { rtpHost: '198.51.100.7', rtpPort: 5604, rtp: false } });
    expect(changed).toMatchObject({ ok: true });
    if (changed.ok) expect(changed.config.cameras[0].outputs).toEqual([
      { kind: 'rtp', host: '198.51.100.7', port: 5604, enabled: false },
    ]);
  });
});

it('stages stream color separately, preserves native controls, and rejects invalid values', () => {
  const config = configWithCamera();
  const { draft } = deckDraft({ imageBrightness: 12, imageContrast: 115, imageHue: -30 });
  expect(draft.image).toEqual({ brightness: 12, contrast: 115, hue: -30 });
  const result = applyCameraDraft(config, 'front', draft);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.config.cameras[0].image).toEqual({ brightness: 12, contrast: 115, saturation: 100, hue: -30 });
    expect(result.config.cameras[0].controls).toEqual(config.cameras[0].controls);
  }
  expect(config.cameras[0].image.brightness).toBe(0);
  expect(applyCameraDraft(config, 'front', { image: { brightness: 101 } }).ok).toBe(false);
  expect(applyCameraDraft(config, 'front', { image: { hue: NaN } }).ok).toBe(false);
});

it("validates preview against the effective capture, and accepts a matching simultaneous edit", () => {
  const before = configWithCamera();
  expect(applyCameraDraft(before, "front", { preview: { size: "1920x1080" } }))
    .toMatchObject({ ok: false, error: expect.stringContaining("larger") });
  expect(applyCameraDraft(before, "front", { width: 1920, height: 1080, preview: { size: "1920x1080" } }).ok).toBe(true);
  before.cameras[0].preview.size = "1280x720";
  expect(applyCameraDraft(before, "front", { width: 640, height: 360 }).ok).toBe(false);
  expect(applyCameraDraft(before, "front", { width: 640, height: 360, preview: { size: "640x360" } }).ok).toBe(true);
});
