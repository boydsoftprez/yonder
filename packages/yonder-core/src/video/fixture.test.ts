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
