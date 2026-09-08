// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_KEYS, present, summarise,
  type AimCapability, type CameraCapabilities, type Capability,
} from "./capability.js";
import { COMPRESSED, CONTROL_MAP, gateIfInactive } from "./probe/camera.js";
import { parseControls, parseFormats } from "./probe/parse.js";
import { noCapabilities } from "./capability.js";
import { aimPanel } from "./present.js";
import { refuse } from "./pipeline.js";
import { Camera } from "../schema/config.js";

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

/**
 * The second camera and the gimbal, held to the same standard.
 *
 * `scripts/fixtures/camera-pair.json` is an overlay, not a recording: it says
 * what a *second* socket and a gimbal would answer, and `verify-pages.sh`
 * merges it onto the recorded fixture above. That merge is what the page gate
 * photographs the state overlay, the drag hint and the thumbnail strip
 * against — blueprint L-10 to L-13, L-17 and L-20 to L-22 — and every one of
 * those is drawn only where this file answers something the shipped code can
 * read.
 *
 * The failure these tests are for is silent. A `device` that no sweep reports
 * makes `refuse()` stop the start, so the strip has nothing running in it; an
 * `aim` the model cannot read makes `aimPanel` fall through to `not-offered`,
 * so the hint is never drawn. Both come out as a capture that looks like a
 * page defect, on a page whose only fault is that the fixture never arrived.
 */
const PAIR = join(ROOT, "scripts", "fixtures", "camera-pair.json");
const pair = JSON.parse(readFileSync(PAIR, "utf8")) as {
  aim: Capability<AimCapability>;
  second: { device: string; card: string; byPath: string; camera: unknown };
};

describe("the harness camera-pair overlay", () => {
  it("configures its second camera on a by-path name the sweep it adds reports", () => {
    // The pair the merge in verify-pages.sh asserts, asserted again here so
    // it fails with the unit suite rather than six minutes into a gate run.
    // A camera configured on a device nothing found is refused before it is
    // spawned — "this board has no /dev/v4l/by-path/…" — and the strip then
    // draws a second camera that never starts.
    expect((pair.second.camera as { device: string }).device).toBe(pair.second.byPath);
  });

  it("is a camera this device's own schema will take", () => {
    // The entry goes into the applied document through POST /apply, so a key
    // this schema does not have is a whole apply refused, not one field
    // dropped: `.strict()` is deliberate one file over.
    expect(() => Camera.parse(pair.second.camera)).not.toThrow();
  });

  it("asks for a size and a rate the recorded camera actually offers", () => {
    // `refuse()` checks a start against the *formats*, and the second camera
    // is the recorded camera on another socket — so its capture pair has to be
    // one that camera answered. Through `refuse` itself rather than a
    // comparison of its own: a second opinion here would eventually differ
    // from the one that decides.
    const second = Camera.parse(pair.second.camera);
    const refusal = refuse({
      camera: second,
      capabilities: fixture.found[0].capabilities,
      encoder: {
        element: "v4l2h264enc", device: "/dev/video11", hardware: true,
        codec: "h264", detail: "hardware H.264 on /dev/video11",
      },
      rtspBase: "rtsp://127.0.0.1:8554",
      knownDevices: new Set([fixture.found[0].device, pair.second.byPath]),
    });
    expect(refusal).toBeNull();
  });

  it("answers a gimbal the panel draws as present, with both ends of both axes", () => {
    // The whole of what L-17 and the Aim panel need. A half-known envelope is
    // `bounds: null` and a state the panel draws dead — which would photograph
    // as a gimbal that answered and cannot be aimed, and say nothing about
    // whether the fixture or the panel was at fault.
    const panel = aimPanel({ ...noCapabilities(), aim: pair.aim });
    expect(panel.state).toBe("present");
    expect(panel.bounds).not.toBeNull();
    expect(panel.mode).not.toBeNull();
  });

  it("leaves the recorded camera's own answer alone, so the pair are not the same camera", () => {
    // The overlay puts the gimbal on the *first* camera only. The second is
    // the board's own answer, which is `not-offered` — so the strip's two rows
    // differ in what they are and not only in where they are, and
    // `capabilityFacts` still has a camera with no aim to say so about.
    expect(fixture.found[0].capabilities.aim).toEqual({ state: "not-offered" });
  });
});
