// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  present, notOffered, advertised, gated, summarise, noCapabilities, CAPABILITY_KEYS,
  type CameraCapabilities,
} from "./capability.js";

const FIXED: CameraCapabilities = {
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30] }]),
  zoom: notOffered(), focus: notOffered(), exposure: notOffered(),
  whiteBalance: notOffered(), brightness: notOffered(), contrast: notOffered(),
  rotation: notOffered(), aim: notOffered(), recording: notOffered(), stills: notOffered(),
  saturation: notOffered(), hue: notOffered(), autoWhiteBalance: notOffered(),
  gamma: notOffered(), gain: notOffered(), powerLineFrequency: notOffered(),
  sharpness: notOffered(), backlightCompensation: notOffered(),
  autoExposure: notOffered(), autoFocus: notOffered(),
};

// The bench's own exposure_time_absolute: a real range, held while
// auto_exposure is in an automatic mode (probe/parse.test.ts; R-UI-21).
const range = { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true };
const by = { id: "auto_exposure", label: "auto exposure" };

describe("the four states", () => {
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

  it("keeps the old one-argument form working, with nothing to draw", () => {
    const a = advertised<number>("no bench evidence yet");
    if (a.state !== "advertised") throw new Error("narrowing");
    expect(a.value).toBeUndefined();
  });

  it("advertised keeps a value too, so the dead control can be drawn", () => {
    const cap = advertised(range, "the frame never moved");
    if (cap.state !== "advertised") throw new Error("narrowing");
    expect(cap.value).toEqual(range);
    expect(cap.reason).toContain("never moved");
  });

  it("keeps the value, because the control is real and in range", () => {
    const cap = gated(range, by);
    if (cap.state !== "gated") throw new Error("narrowing");
    expect(cap.value.max).toBe(10000);
    expect(cap.by.label).toBe("auto exposure");
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
      "brightness: none · contrast: none · rotation: none · aim: none · recording: none · stills: none · " +
      "saturation: none · hue: none · autoWhiteBalance: none · gamma: none · gain: none · " +
      "powerLineFrequency: none · sharpness: none · backlightCompensation: none · " +
      "autoExposure: none · autoFocus: none",
    );
  });

  it("marks an advertised capability apart from an absent one", () => {
    const line = summarise({ ...FIXED, zoom: advertised("accepted, does not reshape the feed") });
    expect(line).toContain("zoom: unanswered");
    expect(line).not.toContain("zoom: none");
  });

  it("summarises as the control that has charge, not as unanswered", () => {
    const s = summarise({ ...noCapabilities(), exposure: gated(range, by) });
    expect(s).toContain("exposure: auto exposure has it");
    expect(s).not.toContain("unanswered");
  });

  // The one branch none of the tests above exercise: every other fixture's
  // present capability is `formats`, which takes the count line instead.
  it("says yes for a present capability that is not formats", () => {
    const line = summarise({ ...FIXED, zoom: present(range) });
    expect(line).toContain("zoom: yes");
  });
});

describe("the capabilities the devices answer", () => {
  // Read off the bench camera tonight with `v4l2-ctl --list-ctrls`: eighteen
  // controls, of which eight already had a field before this task. These ten
  // had nowhere to live (R-CTL-11 … R-CTL-14).
  const NEW = ["gain", "backlightCompensation", "gamma", "sharpness", "saturation", "hue",
    "powerLineFrequency", "autoExposure", "autoWhiteBalance", "autoFocus"] as const;

  it("carries every control the bench camera reports", () => {
    for (const k of NEW) expect(CAPABILITY_KEYS).toContain(k);
  });

  it("defaults every key to not-offered", () => {
    const caps = noCapabilities();
    for (const k of CAPABILITY_KEYS) expect(caps[k].state).toBe("not-offered");
  });

  /**
   * The real guard, and the only one of the three that would catch
   * `CAPABILITY_KEYS` and `CameraCapabilities` drifting apart. The compiler
   * catches an entry in `CAPABILITY_KEYS` that is not a real field — the
   * `satisfies` clause on its declaration — but not the other direction: a
   * real field on `CameraCapabilities` that `CAPABILITY_KEYS` never names
   * compiles cleanly and simply does not appear on `summarise` or
   * `capabilityFacts`, which is the exact silent omission R-UI-20 exists to
   * catch, one level up from the page it governs. Sorted and compared both
   * ways, so a key present on only one side fails it either way round.
   */
  it("has one key per field, and no field without a key", () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(noCapabilities()).sort());
  });
});
