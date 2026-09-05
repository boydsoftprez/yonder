// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { interruption, validateDraft } from "./draft.js";
import { PREVIEW_RUNGS } from "../schema/config.js";

const RUNGS = [...PREVIEW_RUNGS];

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
