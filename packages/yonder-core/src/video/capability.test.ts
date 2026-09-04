// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  present, notOffered, advertised, summarise, CAPABILITY_KEYS,
  type CameraCapabilities,
} from "./capability.js";

const FIXED: CameraCapabilities = {
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30] }]),
  zoom: notOffered(), focus: notOffered(), exposure: notOffered(),
  whiteBalance: notOffered(), brightness: notOffered(), contrast: notOffered(),
  rotation: notOffered(), aim: notOffered(), recording: notOffered(), stills: notOffered(),
};

describe("the three states", () => {
  it("narrows on state, so a value cannot be read off a capability that has none", () => {
    const z = notOffered<number>();
    // @ts-expect-error — there is no `value` on a capability that is not offered
    void z.value;
    const p = present(3);
    expect(p.state === "present" && p.value).toBe(3);
  });

  it("makes an advertised capability carry its reason", () => {
    const a = advertised<number>("acknowledged at fifteen values; the frame stayed 1280x720");
    expect(a.state).toBe("advertised");
    expect(a.state === "advertised" && a.reason).toContain("1280x720");
  });
});

describe("summarise", () => {
  // The Cameras index page's one line per camera (spec section 5). It explains
  // why a camera's page has no Aim group before anyone goes looking for one.
  it("names every capability, so nothing is silently missing", () => {
    const line = summarise(FIXED);
    for (const key of CAPABILITY_KEYS) expect(line).toContain(key);
  });

  it("reads as facts, not as a list of blanks", () => {
    expect(summarise(FIXED)).toBe(
      "formats: 1 · zoom: none · focus: none · exposure: none · whiteBalance: none · " +
      "brightness: none · contrast: none · rotation: none · aim: none · recording: none · stills: none",
    );
  });

  it("marks an advertised capability apart from an absent one", () => {
    const line = summarise({ ...FIXED, zoom: advertised("accepted, does not reshape the feed") });
    expect(line).toContain("zoom: unanswered");
    expect(line).not.toContain("zoom: none");
  });
});
