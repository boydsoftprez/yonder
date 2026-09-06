// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_KEYS, present, summarise, type CameraCapabilities } from "./capability.js";
import { COMPRESSED, CONTROL_MAP, gateIfInactive } from "./probe/camera.js";
import { parseControls, parseFormats } from "./probe/parse.js";
import { noCapabilities } from "./capability.js";

/**
 * The harness fixture, held to the model it stands in for.
 *
 * `scripts/fixtures/camera-globalshutter.json` is the only camera CI has, and
 * `scripts/verify-pages.sh` builds every camera page from it. Its own note
 * claims a change to the shape `detectCameras()` returns "shows up here as a
 * diff rather than as a page that renders nothing".
 *
 * It did not. When the capability model gained ten keys the fixture kept its
 * eleven, `summarise()` read `.state` off `undefined`, `GET /cameras` answered
 * 500, and both camera pages rendered with no camera at all — while the whole
 * unit suite stayed green, because nothing in it had ever loaded this file.
 * The page gate caught it only because somebody ran the page gate.
 *
 * These tests are that missing diff. They are cheap, they run with the unit
 * suite, and they fail the moment the fixture stops being a thing the shipped
 * code can read.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = join(ROOT, "scripts", "fixtures", "camera-globalshutter.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  recorded: { capabilitiesRebuiltFrom: string; formatsRebuiltFrom: string };
  found: { device: string; capabilities: CameraCapabilities }[];
};

describe("the harness camera fixture", () => {
  it("carries every capability the model declares", () => {
    // Not a subset check in one direction only: a key the fixture has and the
    // model does not is just as much a stale fixture, and reads as a capability
    // the pages will silently never draw.
    expect(Object.keys(fixture.found[0].capabilities).sort())
      .toEqual([...CAPABILITY_KEYS].sort());
  });

  it("can be summarised, which is what GET /cameras does to it", () => {
    // The exact call that threw. A missing key is not a formatting problem
    // here — it is a 500 and two blank pages.
    expect(() => summarise(fixture.found[0].capabilities)).not.toThrow();
  });

  /**
   * **The two keys no probe reads, named rather than exempted.**
   *
   * `recording` and `stills` are not V4L2 controls: `CONTROL_MAP` has no
   * entry for either, `v4l2-ctl` says nothing about them, and `probeCamera`
   * therefore leaves both at `noCapabilities()`'s `not-offered` — which is
   * the *model's* default, not the board's answer. Where a recording or a
   * still can go is the daemon's fact (spec §8.3, R-CAM-17, R-CAM-18), and
   * the daemon in this harness is the fixture, so the fixture states them.
   *
   * Named here so the exception cannot widen quietly. The test below holds
   * three things at once: that these two and only these two differ from the
   * rebuild, that the rebuild genuinely could not answer them, and that each
   * carries the sentence the page draws under an inoperative key (spec §4).
   */
  const SEEDED = ["recording", "stills"] as const;

  it("names the two keys no probe reads, and answers both", () => {
    // Nothing outside `SEEDED` may be a key the probe cannot fill: `aim` is
    // the one to watch, since spec §11 adds `pan_absolute`/`tilt_absolute` to
    // CONTROL_MAP and it would otherwise silently join this exemption.
    const readable = new Set<string>([...CONTROL_MAP.map(([, key]) => key), "formats", "aim"]);
    expect(CAPABILITY_KEYS.filter((k) => !readable.has(k))).toEqual([...SEEDED]);

    for (const key of SEEDED) {
      const cap = fixture.found[0].capabilities[key] as { state: string; reason?: string };
      // Advertised, not present: the console can command a capture and the
      // board has nowhere to put the file, which is a control that is drawn
      // and will not act — spec §4's own row, with its reason.
      expect(cap.state).toBe("advertised");
      expect(String(cap.reason ?? ""), `${key} must say why`).not.toBe("");
    }
  });

  it("is the board's answer, not a hand-written one", () => {
    // Rebuilding it the way probeCamera does must reproduce it exactly. This
    // is what stops the next person filling a new key in by eye: a guess and
    // the capture disagree here, loudly, before the guess reaches a page.
    const capture = readFileSync(join(ROOT, fixture.recorded.capabilitiesRebuiltFrom), "utf8");
    const ranges = parseControls(capture);
    // `formats` is derived too, and from its own capture. Copying it across
    // from the fixture would have exempted the one capability the pages build
    // their whole resolution picker from.
    const formatsText = readFileSync(join(ROOT, fixture.recorded.formatsRebuiltFrom), "utf8");
    const compressed = parseFormats(formatsText).filter((f) => COMPRESSED.has(f.fourcc));
    const rebuilt: CameraCapabilities = {
      ...noCapabilities(),
      formats: present(compressed),
    };
    for (const [v4l2Name, key] of CONTROL_MAP) {
      const range = ranges.get(v4l2Name);
      if (range) Object.assign(rebuilt, { [key]: gateIfInactive(range, key) });
    }
    // Exact, for every key but the two the probe cannot read at all — those
    // are carried across from the fixture here so that a hand edit to any
    // *other* key still fails, and are held to their own contract by the test
    // above rather than being silently skipped.
    for (const key of SEEDED) {
      expect(rebuilt[key], `${key} must be one the rebuild cannot answer`)
        .toEqual({ state: "not-offered" });
      Object.assign(rebuilt, { [key]: fixture.found[0].capabilities[key] });
    }
    expect(fixture.found[0].capabilities).toEqual(rebuilt);
  });

  it("keeps the three gates the recorded camera actually reported", () => {
    // The states this fixture exists to photograph. All-present would render
    // every control live and cover none of R-UI-21's gated drawing, which is
    // most of what this branch built.
    const caps = fixture.found[0].capabilities;
    const gated = CAPABILITY_KEYS.filter((k) => caps[k].state === "gated");
    expect(gated).toEqual(["focus", "exposure", "whiteBalance"]);
  });
});
