// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import YonderSoftKeys from "./YonderSoftKeys.vue";
import type { SoftKey } from "../shapes.js";

/**
 * `nodes.test.ts` explains why most of this package's Vue halves go
 * untested: they draw what they are given and decide nothing. This file
 * does not test `press()` or the tone classes for that reason — nothing
 * about which key fires which action has changed.
 *
 * What R-UI-25 found is a rule, not a decision: `.y-keys` never declared
 * `flex-wrap`, so a rail past its own width did not shrink and did not
 * scroll — it simply ran on, and whatever clipped it (a page's own
 * `overflow: hidden`, a viewport edge) hid the keys past the fold with no
 * sign anything was missing. A key nobody can see is a key that does not
 * exist. `jsdom` cannot say whether a sixth key sits on screen or past it,
 * but it reports this rail's own stylesheet precisely, so this holds the
 * rule that keeps that question from mattering: the rail wraps rather than
 * running past its edge, and it is never the rail itself, rather than an
 * ancestor, that turns an overrun into a horizontal scrollbar — swapping a
 * key nobody can see for a key nobody knows to scroll for.
 */

const SIX_KEYS: SoftKey[] = [
  { label: "Live", action: "live" },
  { label: "Setup", action: "setup" },
  { label: "Capture", action: "capture" },
  { label: "Full rate", action: "fullrate" },
  { label: "Detect again", action: "detect" },
  { label: "Apply", action: "apply", tone: "warn" },
];

function keys(list: SoftKey[]) {
  return mount(YonderSoftKeys, {
    props: { id: "n1", props: { keys: list } },
    global: {
      provide: { $dataTracker: () => {}, $socket: { emit() {}, on() {}, off() {} } },
      mocks: { $store: undefined },
    },
  });
}

describe("mounting", () => {
  it("mounts the .vue file and renders one button per key, its label included", () => {
    const w = keys([{ label: "Apply", action: "apply" }]);
    expect(w.findAll(".y-keys__key")).toHaveLength(1);
    expect(w.get(".y-keys__key").text()).toBe("Apply");
  });
});

describe("R-UI-25 — a key nobody can see is a key that does not exist", () => {
  it("six soft keys all render and the rail wraps, never scrolls", () => {
    // A key nobody can see is a key that does not exist. A scrolling rail
    // hides the last key behind a gesture nobody knows to make, on a page an
    // operator reaches for while an aircraft is flying.
    const w = keys(SIX_KEYS);
    expect(w.findAll(".y-keys__key")).toHaveLength(6);
    const rail = getComputedStyle(w.find(".y-keys").element);
    expect(rail.flexWrap).toBe("wrap");
    expect(rail.overflowX).not.toBe("scroll");
    expect(rail.overflowX).not.toBe("auto");
  });
});
