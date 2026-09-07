// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { cameraFor, stillUrl } from "./media-path.js";

describe("cameraFor", () => {
  it("strips a trailing -preview", () => {
    expect(cameraFor("cam0-preview")).toBe("cam0");
  });

  it("leaves a full-rate path — one with no -preview suffix — alone", () => {
    expect(cameraFor("cam0")).toBe("cam0");
  });

  /**
   * A camera whose own id ends in `-preview` is exactly the trap
   * `schema/config.ts`'s own uniqueness check exists for (`claim(...)`, "a
   * camera called nose and a camera called nose-preview both want
   * nose-preview") — this function is not where that is guarded against, but
   * it must still do the one thing its name says: strip *one* trailing
   * occurrence, not recurse.
   */
  it("strips exactly one trailing occurrence, never recursing", () => {
    expect(cameraFor("nose-preview-preview")).toBe("nose-preview");
  });

  it("does not strip the suffix from the middle of a path", () => {
    expect(cameraFor("preview-cam0")).toBe("preview-cam0");
  });

  it("returns an empty string unchanged", () => {
    expect(cameraFor("")).toBe("");
  });
});

describe("stillUrl", () => {
  it("is the console's own still route for the camera, never a media path", () => {
    expect(stillUrl("cam0")).toBe("/video/cam0/still");
    // A caller holding a stream path gets the same address: a still is
    // neither the preview nor the full-rate copy, so there is no suffix.
    expect(stillUrl("cam0-preview")).toBe("/video/cam0/still");
  });

  it("encodes the id, so it cannot be a path of its own", () => {
    expect(stillUrl("a/b")).toBe("/video/a%2Fb/still");
  });
});
