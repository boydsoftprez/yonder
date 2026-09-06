// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  FLIP_KEYS, QUARTER_TURN_NOTE, TURNED_BY_SAYS, orientation, turnedBy, turningSays,
  type VideoDirection,
} from "./orientation.js";
import { advertised, gated, noCapabilities, present } from "./capability.js";
import type { Capability, CameraCapabilities, ControlRange } from "./capability.js";
import type { Camera } from "../schema/config.js";

/**
 * A switch, as `v4l2-ctl --list-ctrls` reports one: `min=0 max=1 step=1`.
 * The bench ELP answers this for neither flip — it lists neither name at all
 * — which is exactly why the board has to be able to do it.
 */
const boolRange: ControlRange = { min: 0, max: 1, step: 1, default: 0, current: 0, inactive: false };
/** `rotate`, as a camera that implements it reports it: degrees, in steps of 90. */
const degreeRange: ControlRange = { min: 0, max: 270, step: 90, default: 0, current: 0, inactive: false };

const sensorCan = (...keys: ("horizontalFlip" | "verticalFlip" | "rotation")[]): CameraCapabilities => {
  const caps: Record<string, unknown> = { ...noCapabilities() };
  for (const key of keys) caps[key] = present(key === "rotation" ? degreeRange : boolRange);
  return caps as CameraCapabilities;
};

type Controls = Partial<Camera["controls"]>;

describe("orientation", () => {
  it("uses the sensor when the camera has the control, and adds no element", () => {
    const o = orientation({ ...noCapabilities(), horizontalFlip: present(boolRange) },
      { horizontalFlip: true });
    expect(o).toMatchObject({ method: "sensor", flip: null });
  });

  it("uses the board when the camera does not have the control", () => {
    const o = orientation(noCapabilities(), { horizontalFlip: true });
    expect(o).toMatchObject({ method: "board", flip: "horiz" });
  });

  it("combines a flip and a rotation into one videoflip, not two", () => {
    expect(orientation(noCapabilities(), { horizontalFlip: true, rotation: 180 }).flip)
      .toBe("vert"); // mirror then half-turn is a vertical flip
  });

  it("adds nothing at all when nothing is asked for", () => {
    expect(orientation(noCapabilities(), {}).method).toBe("none");
    expect(orientation(noCapabilities(), {}).flip).toBeNull();
  });

  /**
   * The whole of the geometry, worked out rather than trusted, because
   * getting one of these backwards means an operator flips the picture and
   * it turns the wrong way — which is worse than not offering it at all.
   *
   * With x to the right and y **down** the frame, a clockwise quarter-turn
   * `R` is `(x, y) -> (-y, x)` and the mirror `H` is `(x, y) -> (-x, y)`.
   * Flips are applied first, then the rotation.
   */
  const CASES: readonly [Controls, VideoDirection, string][] = [
    [{ horizontalFlip: true }, "horiz", "the mirror alone"],
    [{ verticalFlip: true }, "vert", "the flip alone"],
    [{ horizontalFlip: true, verticalFlip: true }, "180", "both flips are a half-turn, and no mirror at all"],
    [{ rotation: 90 }, "90r", "degrees are clockwise"],
    [{ rotation: 180 }, "180", "a half-turn"],
    [{ rotation: 270 }, "90l", "three quarters clockwise is a quarter anticlockwise"],
    [{ horizontalFlip: true, rotation: 180 }, "vert", "(x,y) -> (-x,y) -> (x,-y): top for bottom"],
    [{ verticalFlip: true, rotation: 180 }, "horiz", "the same argument the other way round"],
    [{ horizontalFlip: true, rotation: 90 }, "ur-ll", "(x,y) -> (-x,y) -> (-y,-x): the upper-right/lower-left diagonal"],
    [{ horizontalFlip: true, rotation: 270 }, "ul-lr", "(x,y) -> (-x,y) -> (y,x): the transpose"],
    [{ verticalFlip: true, rotation: 90 }, "ul-lr", "(x,y) -> (x,-y) -> (y,x): the transpose again, from the other flip"],
    [{ verticalFlip: true, rotation: 270 }, "ur-ll", "and the other diagonal"],
    [{ horizontalFlip: true, verticalFlip: true, rotation: 180 }, "identity", "a half-turn undoing a half-turn"],
  ];

  it.each(CASES)("turns %o into %s — %s", (controls, direction) => {
    // `identity` is composed as no element at all, so it reads back as null
    // — a `videoflip` that turns nothing would still copy every frame.
    expect(orientation(noCapabilities(), controls).flip ?? "identity").toBe(direction);
  });

  it("reaches all eight orientations and never invents a ninth", () => {
    // The eight symmetries of a rectangle are every orientation a camera on
    // a mount can be in. A composition that could not reach one of them
    // would be an orientation an operator cannot ask for.
    const reached = new Set<string>();
    for (const horizontalFlip of [false, true]) {
      for (const verticalFlip of [false, true]) {
        for (const rotation of [0, 90, 180, 270] as const) {
          const o = orientation(noCapabilities(), { horizontalFlip, verticalFlip, rotation });
          reached.add(o.flip ?? "identity");
        }
      }
    }
    expect([...reached].sort()).toEqual(
      ["180", "90l", "90r", "horiz", "identity", "ul-lr", "ur-ll", "vert"],
    );
  });

  it("names the direction a quarter turn actually goes, not merely a quarter turn", () => {
    // The assertion the rest of this file would still pass without: swapping
    // `90r` for `90l` keeps every count and every set above intact.
    expect(orientation(noCapabilities(), { rotation: 90 }).flip).toBe("90r");
    expect(orientation(noCapabilities(), { rotation: 270 }).flip).toBe("90l");
    expect(orientation(noCapabilities(), { horizontalFlip: true, rotation: 90 }).flip).toBe("ur-ll");
    expect(orientation(noCapabilities(), { verticalFlip: true, rotation: 90 }).flip).toBe("ul-lr");
  });

  it("keeps the order — a mirror then a quarter turn is not a quarter turn then a mirror", () => {
    // The one pair in the group that does not commute, and the reason the
    // order is fixed in one place rather than left to each half. If the
    // board ever composed these the other way round, this is what would
    // catch it: mirror-then-90 is `ur-ll`, and 90-then-mirror is `ul-lr`.
    const mirrorThenQuarter = orientation(noCapabilities(), { horizontalFlip: true, rotation: 90 }).flip;
    // The sensor doing the quarter-turn first, and the board mirroring after,
    // is the *other* order — and the board is asked for the direction that
    // still lands on the same picture, not for a plain `horiz`.
    const quarterAtSensor = orientation(sensorCan("rotation"), { horizontalFlip: true, rotation: 90 });
    expect(mirrorThenQuarter).toBe("ur-ll");
    expect(quarterAtSensor).toMatchObject({ method: "board", flip: "vert" });
  });
});

describe("the split between the sensor and the board", () => {
  it("gives the board only what the sensor is not already doing", () => {
    // The failure this exists to close: the sensor mirrors, the board
    // mirrors too, and a mirrored mirror is no mirror at all — silently,
    // with config.yaml, the page and the launch line all saying it is
    // mirrored. The board gets the *remainder*, which here is the rotation.
    const o = orientation(sensorCan("horizontalFlip"), { horizontalFlip: true, rotation: 180 });
    expect(o).toMatchObject({ method: "board", flip: "180" });
    // ...and not the whole correction, which would be `vert`, nor a second
    // mirror, which would be `horiz`.
    expect(o.flip).not.toBe("vert");
    expect(o.flip).not.toBe("horiz");
  });

  it("adds nothing when the sensor can do every part of it", () => {
    const o = orientation(sensorCan("horizontalFlip", "verticalFlip", "rotation"),
      { horizontalFlip: true, verticalFlip: true, rotation: 90 });
    expect(o).toMatchObject({ method: "sensor", flip: null });
  });

  it("does the whole of it on the board when the sensor offers none of the three", () => {
    // The bench ELP, exactly: `probe/camera.ts` reads all three names off
    // `v4l2-ctl --list-ctrls` and this camera lists none of them.
    const o = orientation(noCapabilities(), { horizontalFlip: true, verticalFlip: true, rotation: 90 });
    expect(o).toMatchObject({ method: "board", flip: "90l" });
  });

  it("counts a control the camera lists but will not act on as one the sensor is not doing", () => {
    // `advertised` is a fault, not a capability (R-UI-21): the device takes
    // the command and does nothing, and `applyControls` refuses it. Treating
    // it as the sensor's would leave the picture unturned and say the sensor
    // had turned it.
    const caps = { ...noCapabilities(), horizontalFlip: advertised<ControlRange>(boolRange, "acknowledged, never applied") };
    expect(orientation(caps, { horizontalFlip: true })).toMatchObject({ method: "board", flip: "horiz" });
  });

  it("counts a gated control the same way, because applyControls refuses that too", () => {
    const caps = {
      ...noCapabilities(),
      verticalFlip: gated(boolRange, { id: "something_else", label: "something else" }),
    };
    expect(orientation(caps, { verticalFlip: true })).toMatchObject({ method: "board", flip: "vert" });
  });

  it("undoes the sensor's own work when the corrections asked for cancel out", () => {
    // A mirror, a flip and a half-turn compose to nothing. The sensor can
    // only do the mirror, so the board has to put the mirror back — an
    // element that looks like work for no reason and is the only way the
    // picture ends up the way it was asked for.
    const o = orientation(sensorCan("horizontalFlip"),
      { horizontalFlip: true, verticalFlip: true, rotation: 180 });
    expect(o).toMatchObject({ method: "board", flip: "horiz" });
  });

  it("says nothing is turned when nothing is turned, whatever the sensor could do", () => {
    expect(orientation(sensorCan("horizontalFlip", "rotation"), { horizontalFlip: false, rotation: 0 }))
      .toMatchObject({ method: "none", flip: null });
    // `null` is the schema's own "leave the camera alone", not a request.
    expect(orientation(noCapabilities(), { horizontalFlip: null, verticalFlip: null }))
      .toMatchObject({ method: "none", flip: null });
  });
});

describe("the sentence an operator is shown", () => {
  it("says which of the two is turning the picture, in each case", () => {
    expect(orientation(noCapabilities(), {}).note).toContain("not turned");
    expect(orientation(sensorCan("horizontalFlip"), { horizontalFlip: true }).note)
      .toContain("camera turns this picture itself");
    expect(orientation(noCapabilities(), { horizontalFlip: true }).note)
      .toContain("cannot turn the picture itself");
  });

  it("warns about a quarter turn, and about nothing else", () => {
    // A transpose is the dearest of the eight and the only one that swaps
    // the picture's width and height. Said as a kind of cost: nothing here
    // has been measured on a board, and no figure is invented to fill it.
    expect(orientation(noCapabilities(), { rotation: 90 }).note).toContain("quarter turn");
    expect(orientation(noCapabilities(), { rotation: 270 }).note).toContain("quarter turn");
    expect(orientation(noCapabilities(), { rotation: 180 }).note).not.toContain("quarter turn");
    expect(orientation(noCapabilities(), { horizontalFlip: true }).note).not.toContain("quarter turn");
    // No note anywhere carries a number, because none has been measured.
    for (const controls of [{}, { rotation: 90 as const }, { horizontalFlip: true }]) {
      expect(orientation(noCapabilities(), controls).note).not.toMatch(/\d/);
    }
  });
});

describe("which of the two carries a control", () => {
  it("is the sensor only where the sensor will actually write it", () => {
    // The same four states `applyControls` decides from, answered the same
    // way: `present` is the sensor's, and the other three all fall to the
    // board, because `applyControls` refuses every one of them.
    expect(turnedBy(present(boolRange))).toBe("sensor");
    expect(turnedBy(noCapabilities().horizontalFlip)).toBe("board");
    expect(turnedBy(advertised<ControlRange>(boolRange, "acknowledged, never applied"))).toBe("board");
    expect(turnedBy(gated(boolRange, { id: "x", label: "x" }))).toBe("board");
  });

  it("never answers that nobody carries it, on any camera", () => {
    // R-CTL-15's own premise, and the reason a page must ask this rather
    // than reading the capability state: turning the picture is available on
    // every camera, so there is no third answer and no absence.
    const everyState: Capability<ControlRange>[] = [
      present(boolRange),
      { state: "not-offered" },
      advertised<ControlRange>(boolRange, "acknowledged, never applied"),
      gated(boolRange, { id: "x", label: "x" }),
    ];
    for (const capability of everyState) {
      expect(["sensor", "board"]).toContain(turnedBy(capability));
    }
  });

  it("agrees with the element the pipeline composes, on the same camera", () => {
    // The one guarantee this function exists for: the sentence beside a
    // control and the `videoflip` in the launch line are the same decision.
    // A camera whose sensor mirrors composes nothing; one whose sensor does
    // not composes `horiz`.
    expect(turnedBy(sensorCan("horizontalFlip").horizontalFlip)).toBe("sensor");
    expect(orientation(sensorCan("horizontalFlip"), { horizontalFlip: true }).flip).toBeNull();
    expect(turnedBy(noCapabilities().horizontalFlip)).toBe("board");
    expect(orientation(noCapabilities(), { horizontalFlip: true }).flip).toBe("horiz");
  });

  it("names the three, and names each of the two, in words for an operator", () => {
    expect([...FLIP_KEYS]).toEqual(["horizontalFlip", "verticalFlip", "rotation"]);
    expect(TURNED_BY_SAYS.sensor).toMatch(/camera turns this/i);
    expect(TURNED_BY_SAYS.board).toMatch(/board turns this/i);
    // Never a V4L2 name in a sentence an operator reads, and no number: the
    // board's cost has not been measured, here or in `note`.
    for (const says of Object.values(TURNED_BY_SAYS)) {
      expect(says).not.toMatch(/horizontal_flip|vertical_flip|rotate|videoflip|\d/);
    }
  });
});

describe("the one line beneath the group", () => {
  it("says the same thing whether or not anything is turned yet", () => {
    // `note` reports the picture and says nothing at rest; this reports the
    // camera, and at rest is exactly when an operator is deciding whether to
    // turn something and needs to know what it will cost.
    expect(turningSays(noCapabilities(), {})).toBe(turningSays(noCapabilities(), { horizontalFlip: true }));
    expect(turningSays(noCapabilities(), {})).toContain("cannot turn the picture itself");
    const all = sensorCan("horizontalFlip", "verticalFlip", "rotation");
    expect(turningSays(all, {})).toBe(turningSays(all, { horizontalFlip: true }));
    expect(turningSays(all, {})).toContain("camera turns this picture itself");
  });

  it("borrows orientation()'s own two sentences rather than writing its own", () => {
    // One wording for one fact. A second copy here would drift from `note`
    // the first time either was reworded, and the page would then say one
    // thing about the camera and another about the picture.
    expect(turningSays(noCapabilities(), { horizontalFlip: true }))
      .toBe(orientation(noCapabilities(), { horizontalFlip: true }).note);
    const all = sensorCan("horizontalFlip", "verticalFlip", "rotation");
    expect(turningSays(all, { horizontalFlip: true }))
      .toBe(orientation(all, { horizontalFlip: true }).note);
  });

  it("stands aside where the three disagree, because one line cannot carry that", () => {
    const mixed = sensorCan("horizontalFlip");
    expect(turningSays(mixed, {})).toContain("each control says which");
    expect(turningSays(mixed, {})).not.toContain("cannot turn the picture itself");
  });

  it("carries the quarter turn's cost, and only for the board's own quarter turn", () => {
    expect(turningSays(noCapabilities(), { rotation: 90 })).toContain(QUARTER_TURN_NOTE);
    expect(turningSays(noCapabilities(), { rotation: 270 })).toContain(QUARTER_TURN_NOTE);
    expect(turningSays(noCapabilities(), { rotation: 180 })).not.toContain("quarter turn");
    expect(turningSays(noCapabilities(), {})).not.toContain("quarter turn");
    // The sensor's own quarter turn costs this board nothing, so it carries
    // no warning: `transposes` is about what the pipeline is doing.
    const all = sensorCan("horizontalFlip", "verticalFlip", "rotation");
    expect(orientation(all, { rotation: 90 }).transposes).toBe(false);
    expect(turningSays(all, { rotation: 90 })).not.toContain("quarter turn");
  });

  it("reports a transpose as a field, not as words a caller has to read", () => {
    expect(orientation(noCapabilities(), { rotation: 90 }).transposes).toBe(true);
    expect(orientation(noCapabilities(), { rotation: 270 }).transposes).toBe(true);
    expect(orientation(noCapabilities(), { rotation: 180 }).transposes).toBe(false);
    expect(orientation(noCapabilities(), { horizontalFlip: true }).transposes).toBe(false);
    expect(orientation(noCapabilities(), {}).transposes).toBe(false);
    // Every one of the four directions that transposes says so, so nothing
    // downstream has to keep a second list of which four they are.
    for (const controls of [
      { rotation: 90 as const },
      { rotation: 270 as const },
      { horizontalFlip: true, rotation: 90 as const },
      { verticalFlip: true, rotation: 90 as const },
    ]) {
      const o = orientation(noCapabilities(), controls);
      expect(["90r", "90l", "ur-ll", "ul-lr"]).toContain(o.flip);
      expect(o.transposes).toBe(true);
    }
  });
});
