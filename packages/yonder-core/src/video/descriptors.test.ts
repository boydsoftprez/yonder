// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { DESCRIPTORS, describe, sentenceLabel } from "./descriptors.js";
import { CAPABILITY_KEYS } from "./capability.js";

// `describe` here is this file's own conversion function (`./descriptors.js`),
// not vitest's grouping helper — the two share a name, and the task brief's
// test bodies call the bare identifier, so vitest's `describe` is not
// imported at all rather than shadowed or aliased away from what the brief
// wrote. `it` needs no group to run at the top level.

// --- The five tests the task brief specifies verbatim ---------------------

it("converts absolute exposure at 100 µs per raw unit — current, bounds and step together", () => {
  const d = describe("exposure", { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: false });
  expect(d).toMatchObject({ current: 15600, min: 100, max: 1_000_000, step: 100, unit: "µs" });
});
it("round-trips a display value to the same raw value", () => {
  expect(DESCRIPTORS.exposure.toRaw(DESCRIPTORS.exposure.toDisplay(156))).toBe(156);
});
it("shutter is open under Manual (1) and closed under Aperture priority (3)", () => {
  expect(DESCRIPTORS.exposure.openWhen!(1)).toBe(true);
  expect(DESCRIPTORS.exposure.openWhen!(3)).toBe(false);
});
it("zoom on a UVC camera is device steps with no ratio", () => {
  expect(DESCRIPTORS.zoom.unit).toBe(""); expect(DESCRIPTORS.zoom.toDisplay(30)).toBe(30);
});
// A blocklist of three wrong spellings passes `µS`, `MHZ` and every other
// miscasing nobody thought of, which is the failure it was written to catch.
// A closed vocabulary inverts that: a unit reaches this table only by being
// added here deliberately, which is the one place the casing rule is applied.
const UNITS = new Set(["", "µs", "K"]);
it("every unit is one this project has written down, in that spelling", () => {
  for (const [key, d] of Object.entries(DESCRIPTORS)) {
    expect(UNITS, `${key} carries an unlisted unit ${JSON.stringify(d.unit)}`).toContain(d.unit);
  }
});

// --- Round-trip over the whole device domain, not the one value above -----
//
// The task brief's ambiguity note is explicit: "toDisplay and toRaw must
// round-trip exactly for every value a device can hold, not merely for the
// one the test uses." The bench's own `exposure_time_absolute` is documented
// min=1 max=10000 step=1 (probe/fixtures/list-ctrls-menus-globalshutter.txt),
// so that whole integer range — not a sample of it — is what "every value a
// device can hold" means here.

it("round-trips every raw value exposure_time_absolute can hold on the bench (1..10000), not just 156", () => {
  for (let raw = 1; raw <= 10_000; raw++) {
    expect(DESCRIPTORS.exposure.toRaw(DESCRIPTORS.exposure.toDisplay(raw))).toBe(raw);
  }
});

// --- Both branches of every gate this file actually wires, not only
// exposure's ------------------------------------------------------------
//
// Three tests already shipped in this plan asserting nothing: one branch
// with no coverage was one of them. `whiteBalance` and `focus` are gated
// exactly like `exposure` (R-UI-21) and are just as able to have their
// `openWhen` sense flipped by a typo, so both get the same open/closed pair
// exposure's test does, read off the same fixture.

it("white balance temperature is open once auto white balance is off (0), closed while it is on (1)", () => {
  expect(DESCRIPTORS.whiteBalance.openWhen!(0)).toBe(true);
  expect(DESCRIPTORS.whiteBalance.openWhen!(1)).toBe(false);
});
it("focus is open once continuous auto-focus is off (0), closed while it is on (1)", () => {
  expect(DESCRIPTORS.focus.openWhen!(0)).toBe(true);
  expect(DESCRIPTORS.focus.openWhen!(1)).toBe(false);
});

// --- describe() actually converts every field, for a second unit besides
// µs, and for the identity conversion too --------------------------------

it("white balance temperature is kelvin, unconverted — the bench's own 2800..6500 range, default 4600", () => {
  const d = describe("whiteBalance", {
    min: 2800, max: 6500, step: 1, default: 4600, current: 4600, inactive: false,
  });
  expect(d).toMatchObject({ label: "Temperature", unit: "K", current: 4600, min: 2800, max: 6500, step: 1 });
});
it("zoom's whole range describes as device steps end to end, not just the one value toDisplay(30) checks", () => {
  const d = describe("zoom", { min: 0, max: 60, step: 1, default: 0, current: 30, inactive: false });
  expect(d).toMatchObject({ label: "Zoom", unit: "", min: 0, max: 60, step: 1, current: 30, default: 0 });
});

// --- Every key, not a sample of them ------------------------------------
//
// `CAPABILITY_KEYS` is the exhaustive list `capability.ts` already keeps for
// exactly this reason (a capability added there and forgotten elsewhere).
// Reused here rather than a hand-typed list, so a 22nd capability shows up
// in these loops automatically instead of six keys quietly going unchecked
// the way the plan's own retrospective warns sampling causes.

it("every descriptor names its own key correctly", () => {
  for (const key of CAPABILITY_KEYS) expect(DESCRIPTORS[key].key).toBe(key);
});

it("only the three controls the bench fixture actually gates carry gates and openWhen", () => {
  const gatedKeys = CAPABILITY_KEYS.filter((key) => DESCRIPTORS[key].gates !== undefined);
  expect([...gatedKeys].sort()).toEqual(["exposure", "focus", "whiteBalance"]);
  for (const key of CAPABILITY_KEYS) {
    const d = DESCRIPTORS[key];
    if (gatedKeys.includes(key)) expect(typeof d.openWhen).toBe("function");
    else expect(d.openWhen).toBeUndefined();
  }
});

// --- Fix round 1: `label` is the heading form for every key, and
// `sentenceLabel` is the one place that derives the mid-sentence form from
// it. The prior version of this file stored the three gate labels lowercase
// directly on `label`, which is exactly the "three of nineteen wrong"
// defect a sampled test would miss — so this checks every key, not the
// three that used to be different. --------------------------------------

it("every label reads as a heading, capitalised the same way for every key — checked over all of them, not a sample", () => {
  for (const key of CAPABILITY_KEYS) {
    expect(DESCRIPTORS[key].label).toMatch(/^[A-Z]/);
  }
});

it("sentenceLabel lowercases the heading for use inside a sentence — the exact shape a gated control needs", () => {
  // The exact shape Task 7 reads: DESCRIPTORS[key].gates[0], then
  // sentenceLabel of that key, for the label a `gated()` capability carries
  // as `by.label` (capability.ts, capability.test.ts, present.test.ts all
  // fix this at "auto exposure", lowercase, for the same reason).
  expect(sentenceLabel(DESCRIPTORS.exposure.gates![0])).toBe("auto exposure");
  expect(sentenceLabel(DESCRIPTORS.whiteBalance.gates![0])).toBe("auto white balance");
  expect(sentenceLabel(DESCRIPTORS.focus.gates![0])).toBe("auto focus");
  // Named literally, as the brief specifies.
  expect(sentenceLabel("autoExposure")).toBe("auto exposure");
});

it("sentenceLabel is a plain first-letter lowercase, not special-cased to the three gate keys", () => {
  expect(sentenceLabel("exposure")).toBe("shutter");
  // Already lowercase after the first letter, and the first letter has
  // nowhere further to go — a fixed point, not a no-op that would pass
  // against a function that never touched its argument at all (the
  // exposure/autoExposure cases above already rule that out, but this one
  // is here so a single-word, already-terse label is covered too).
  expect(sentenceLabel("zoom")).toBe("zoom");
});
