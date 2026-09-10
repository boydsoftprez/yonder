// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import YonderAimPad from "./YonderAimPad.vue";

/**
 * The aim pad is the only control in this library where a press becomes
 * movement on an aircraft (R-CAM-11, R-CMD-04). A press is an instruction to
 * move at a rate for as long as it is held; the instant the operator stops,
 * the aircraft must stop. Every one of the eight ways a gesture can end has
 * to emit exactly one `stop` — not zero, which leaves a gimbal moving, and
 * not two, which is a command nobody sent. That is what most of this file
 * exists to prove, one ending and one overlapping pair at a time.
 *
 * Three environment traps, confirmed directly against this project's own
 * installed jsdom/`@vue/test-utils` before writing a single assertion
 * against them (the same three `task-20-brief.md` names):
 *
 * 1. **jsdom has no pointer capture at all.** `'setPointerCapture' in
 *    someElement` is `false` and calling it throws
 *    `TypeError: el.setPointerCapture is not a function` — not a stub that
 *    quietly no-ops. `YonderAimPad.vue` calls it through `?.`, the same
 *    guard the blueprint's own `DraftAimDial.vue` already uses, and the
 *    "attempts pointer capture" test below stubs the method itself to prove
 *    the call happens, while every other test in this file leaves it
 *    unstubbed and un-thrown — proof the guard is what keeps a missing
 *    implementation from taking the component down with it.
 * 2. **jsdom performs no layout.** Each dial gets an explicit 132px layout
 *    fixture; scaled/offset and invalid-layout tests replace those bounds.
 * 3. **`@vue/test-utils@2.5.0`'s own `trigger("pointerdown", { clientX })`
 *    throws in this project's jsdom** — `setbar.component.test.ts`'s own
 *    top comment explains the cause (jsdom's `PointerEvent` inherits
 *    `clientX` from `MouseEvent.prototype` rather than redeclaring it, which
 *    defeats `trigger()`'s own property-descriptor guard). `YonderHoldKey`'s
 *    test file dispatches pointer events directly rather than through
 *    `trigger()` for the same reason; `point()`/`down()`/`move()` below are
 *    that same choice, extended to carry a coordinate the way
 *    `setbar.component.test.ts`'s own `press()` already does.
 */

/**
 * Mirrors `YonderAimPad.vue`'s own geometry constants by hand, the same way
 * `setbar.component.test.ts` reasons about `TRACK_WIDTH` without importing
 * it — a plain part exports no test-only constants. Confirmed against the
 * component's own `at()` before writing a single test against it.
 */
const CENTER = 59;
const VIEWBOX = 118;
const DIAL_SIZE = 132;
const DEAD = 15;
const RIM = 44;

/**
 * SVG points mapped into the explicit default 132px layout fixture.
 * Scaled and offset cases below supply client coordinates independently.
 */
function toClient(xSvg: number, ySvg: number) {
  return {
    clientX: ((xSvg + CENTER) / VIEWBOX) * DIAL_SIZE,
    clientY: ((ySvg + CENTER) / VIEWBOX) * DIAL_SIZE,
  };
}

function pad(props: {
  axes?: { pan?: string; tilt?: string; roll?: string };
  atLimit?: { pitch?: boolean; yaw?: boolean };
  inhibited?: string | null;
}) {
  const wrapper = mount(YonderAimPad, { props });
  wrapper.find('.y-aim__dial').element.getBoundingClientRect = () => ({ left: 0, top: 0, width: DIAL_SIZE, height: DIAL_SIZE }) as DOMRect;
  return wrapper;
}

function dialOf(w: VueWrapper): Element {
  return w.find(".y-aim__dial").element;
}

/** A real `PointerEvent`, `clientX`/`clientY`/`pointerId` set through the
 * constructor's own init dict — see this file's top comment, trap 3. */
function point(type: string, xSvg: number, ySvg: number, pointerId = 1): PointerEvent {
  const { clientX, clientY } = toClient(xSvg, ySvg);
  return new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true, cancelable: true });
}

function down(el: Element, xSvg: number, ySvg: number, pointerId = 1): void {
  el.dispatchEvent(point("pointerdown", xSvg, ySvg, pointerId));
}

function move(el: Element, xSvg: number, ySvg: number, pointerId = 1): void {
  el.dispatchEvent(point("pointermove", xSvg, ySvg, pointerId));
}

/** The four release events (and `lostpointercapture`, and the two overlap
 * tests) carry no coordinate and need none — a plain `Event` reaches the
 * same listener a real gesture would, the same reasoning
 * `holdkey.component.test.ts`'s own `fire()` gives for using one. */
function fire(el: Element | Window | Document, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

/** Verbatim from `holdkey.component.test.ts`. */
function goHidden(): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  localStorage.clear();
});

function slews(w: VueWrapper): Array<{ pan: number; tilt: number; seq: number; gesture: string }> {
  return ((w.emitted("slew") ?? []) as unknown[]).map((call) => (call as unknown[])[0]) as Array<{
    pan: number;
    tilt: number;
    seq: number;
    gesture: string;
  }>;
}

function stops(w: VueWrapper): Array<{ gesture: string }> {
  return ((w.emitted("stop") ?? []) as unknown[]).map((call) => (call as unknown[])[0]) as Array<{
    gesture: string;
  }>;
}

describe("mounting", () => {
  it("mounts and draws the dial with the puck at rest", () => {
    const w = pad({});
    expect(w.find(".y-aim__dial").exists()).toBe(true);
    expect(w.find(".y-aim__puck-core").exists()).toBe(true);
    expect(Number(w.find(".y-aim__puck-core").attributes("cx"))).toBe(CENTER);
    expect(Number(w.find(".y-aim__puck-core").attributes("cy"))).toBe(CENTER);
  });
});

describe('stick expo', () => {
  it('offers independent speed selection, respects the camera cap, and ends an old hold on changes', async () => {
    const w = mount(YonderAimPad, { props: { maxRate: 120 } });
    dialOf(w).getBoundingClientRect = () => ({ left: 0, top: 0, width: DIAL_SIZE, height: DIAL_SIZE }) as DOMRect;
    expect(w.get('input[aria-label="Maximum gimbal speed"]').element.value).toBe('60');
    down(dialOf(w), RIM, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(60);
    await w.get('input[aria-label="Maximum gimbal speed"]').setValue('120');
    expect(stops(w)).toHaveLength(1);
    move(dialOf(w), RIM, 0);
    expect(slews(w)).toHaveLength(1);
    down(dialOf(w), RIM, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(120);
    await w.setProps({ maxRate: 10 });
    expect(stops(w)).toHaveLength(2);
    expect(w.get('input[aria-label="Maximum gimbal speed"]').element.value).toBe('10');
    down(dialOf(w), RIM, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(10);
    w.unmount();
  });
  it('defaults to half expo, preserves directions and reaches the reported maximum at full throw', () => {
    const w = mount(YonderAimPad, { props: { maxRate: 10 } });
    dialOf(w).getBoundingClientRect = () => ({ left: 0, top: 0, width: DIAL_SIZE, height: DIAL_SIZE }) as DOMRect;
    expect(w.get('input[aria-label="Stick expo"]').element.value).toBe('50');
    const halfThrow = (DEAD + RIM) / 2;
    down(dialOf(w), halfThrow, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(3.125);
    move(dialOf(w), -halfThrow, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(-3.125);
    move(dialOf(w), 0, -halfThrow);
    expect(slews(w).at(-1)?.tilt).toBeCloseTo(3.125);
    move(dialOf(w), 400, -400);
    const last = slews(w).at(-1)!;
    expect(Math.hypot(last.pan, last.tilt)).toBeCloseTo(10);
    expect(last.pan).toBeCloseTo(last.tilt);
    w.unmount();
  });

  it('supports linear and cubic response and remembers the browser preference', async () => {
    const w = pad({});
    await w.get('input[aria-label="Stick expo"]').setValue('0');
    down(dialOf(w), (DEAD + RIM) / 2, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(15);
    await w.get('input[aria-label="Stick expo"]').setValue('100');
    expect(stops(w)).toHaveLength(1);
    move(dialOf(w), RIM, 0); // changing the response cannot resume the old hold
    expect(slews(w)).toHaveLength(1);
    down(dialOf(w), (DEAD + RIM) / 2, 0);
    expect(slews(w).at(-1)?.pan).toBeCloseTo(3.75);
    fire(dialOf(w), 'pointerup');
    expect(stops(w)).toHaveLength(2);
    w.unmount();
    const restored = pad({});
    expect(restored.get('input[aria-label="Stick expo"]').element.value).toBe('100');
    restored.unmount();
  });

  it.each(['NaN', '-10', '101', ''])('uses the default for an invalid saved preference %s', saved => {
    localStorage.setItem('yonder:aim:expo', saved);
    const w = pad({});
    expect(w.get('input[aria-label="Stick expo"]').element.value).toBe('50');
    w.unmount();
  });
});

describe("a rate, never a position", () => {
  /**
   * Given in the plan text (task-20-brief.md, Step 1) with `...` for a
   * body. A position-emitting implementation would satisfy a loose
   * "emits something while dragging" check; this instead proves the two
   * signatures a rate carries and a position does not — bounded by the
   * pad's own maximum regardless of how far the pointer goes, and small
   * near the dead zone's own edge, large at the rim.
   */
  it("emits a rate while dragging, never a position", () => {
    const w = pad({});
    const dial = dialOf(w);

    down(dial, 20, 0); // just past the dead zone (15), straight out along pan+
    let last = slews(w).at(-1)!;
    expect(last.pan).toBeGreaterThan(0);
    expect(last.pan).toBeLessThan(10); // near the dead zone's own edge: a small rate
    expect(last.tilt).toBeCloseTo(0, 5);

    move(dial, RIM, 0); // exactly at the rim: full rate
    last = slews(w).at(-1)!;
    expect(last.pan).toBeCloseTo(30, 5);

    move(dial, 400, 0); // far beyond the rim
    last = slews(w).at(-1)!;
    // A rate saturates at the pad's own maximum; a position would keep
    // growing with the pointer instead of stopping at 30.
    expect(last.pan).toBeCloseTo(30, 5);
    expect(Math.abs(last.pan)).toBeLessThanOrEqual(30);
  });

  it("pushing up yields a positive tilt rate, matching the Up label", () => {
    // Screen y grows downward; "up" is negative SVG y. A dropped sign here
    // would point the reading the wrong way against the pad's own label.
    const w = pad({});
    down(dialOf(w), 0, -20);
    const last = slews(w).at(-1)!;
    expect(last.tilt).toBeGreaterThan(0);
    expect(last.pan).toBeCloseTo(0, 5);
  });
});

describe("seq and gesture", () => {
  /**
   * Given in the plan text with `...` for a body.
   */
  it("increments seq on every slew and carries one gesture id per drag", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 0, -20);
    move(dial, 0, -25);
    move(dial, 0, -30);

    const s = slews(w);
    expect(s).toHaveLength(3);
    expect(s.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(s[1].gesture).toBe(s[0].gesture);
    expect(s[2].gesture).toBe(s[0].gesture);
  });

  it("never shares a gesture id between two separate drags", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0);
    fire(dial, "pointerup");
    down(dial, 20, 0);

    const s = slews(w);
    expect(s[1].gesture).not.toBe(s[0].gesture);
  });
});

describe("the dead zone ends the gesture", () => {
  /**
   * Given in the plan text with `...` for a body.
   */
  it("the dead zone emits stop; leaving it again starts a new gesture id", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0); // gesture A starts
    move(dial, 0, 0); // back to dead centre: stop
    move(dial, 20, 0); // out again: a new gesture

    const s = stops(w);
    expect(s).toHaveLength(1);
    const gestureA = slews(w)[0].gesture;
    expect(s[0].gesture).toBe(gestureA);

    const gestureB = slews(w).at(-1)!.gesture;
    expect(gestureB).not.toBe(gestureA);
  });

  it("re-entering the dead zone twice in one hold still emits only one stop per excursion", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0);
    move(dial, 0, 0); // stop #1
    move(dial, 0, 0); // still centred — must not repeat the stop
    move(dial, 20, 0); // a new gesture
    move(dial, 0, 0); // stop #2, for the new gesture

    expect(stops(w)).toHaveLength(2);
  });
});

/**
 * Given verbatim in the plan text:
 * `for (const ev of [...]) it(\`emits exactly one stop on ${ev}\`, ...)`.
 */
describe("every ending emits exactly one stop", () => {
  for (const ev of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
    it(`emits exactly one stop on ${ev}`, () => {
      const w = pad({});
      const dial = dialOf(w);
      down(dial, 20, 0);
      fire(dial, ev);
      expect(stops(w)).toHaveLength(1);
    });
  }

  it("emits stop when the window blurs", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    fire(window, "blur");
    expect(stops(w)).toHaveLength(1);
  });

  it("emits stop when the page hides (visibilitychange to hidden)", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    goHidden();
    expect(stops(w)).toHaveLength(1);
  });

  it("emits stop on pagehide", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    fire(window, "pagehide");
    expect(stops(w)).toHaveLength(1);
  });

  it("emits nothing at all when nothing was ever pressed", () => {
    const w = pad({});
    fire(dialOf(w), "pointerup");
    fire(window, "blur");
    goHidden();
    fire(window, "pagehide");
    expect(stops(w)).toHaveLength(0);
  });
});

/**
 * The coordinator's own resolution 5: the eight endings overlap in a real
 * browser, and a stop must survive the overlap without doubling.
 */
describe("overlapping endings still emit exactly one stop", () => {
  it("a pointerup that arrives with a lostpointercapture", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    fire(dialOf(w), "pointerup");
    fire(dialOf(w), "lostpointercapture");
    expect(stops(w)).toHaveLength(1);
  });

  it("a pointercancel that arrives with a lostpointercapture", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    fire(dialOf(w), "pointercancel");
    fire(dialOf(w), "lostpointercapture");
    expect(stops(w)).toHaveLength(1);
  });

  it("a hidden tab firing both visibilitychange and pagehide", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    goHidden();
    fire(window, "pagehide");
    expect(stops(w)).toHaveLength(1);
  });

  it("a blur that arrives together with visibilitychange", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    fire(window, "blur");
    goHidden();
    expect(stops(w)).toHaveLength(1);
  });
});

describe("inhibited: emits nothing, and says why", () => {
  /**
   * Given in the plan text with `...` for a body and this exact inline
   * comment: `inhibited: "envelope unknown — run the range finder"`. That
   * wording is the range finder's own — removed from this plan after the
   * operator rejected it (task-20-brief.md resolution 6, and
   * docs/console/design/instrument-library/README.md's own account of the
   * same round). Reusing it here would reintroduce exactly what the brief
   * says not to, so this uses a different, generic reason instead — the
   * prop is a general inhibition reason and the deck supplies whatever is
   * true, not necessarily anything about an envelope or a range finder.
   */
  const REASON = "gimbal not responding";

  it("emits nothing while inhibited, and shows the reason", () => {
    const w = pad({ inhibited: REASON });
    expect(w.text()).toContain(REASON);

    const dial = dialOf(w);
    down(dial, 20, 0);
    move(dial, 30, 0);
    fire(dial, "pointerup");
    expect(w.emitted("slew")).toBeUndefined();
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("shows no reason at all when not inhibited", () => {
    const w = pad({});
    expect(w.find(".y-aim__reason").exists()).toBe(false);
  });

  /**
   * `note` is what is drawn; `inhibited` is what refuses the press. They
   * were one prop until K-63, when the first photograph of a panel that
   * says the same sentence at its own head showed it twice, 40 px apart.
   * The two tests below are the pair: an unset `note` keeps the inhibition's
   * own words for a caller with nowhere else to put them (`YonderDeck`'s aim
   * block), and `note: ""` silences the sentence **without** softening the
   * guard by a single press.
   */
  it("defaults to saying the inhibition's own words", () => {
    expect(pad({ inhibited: REASON }).find(".y-aim__reason").text()).toBe(REASON);
  });

  it("an empty note draws nothing and still refuses every press", () => {
    const w = pad({ inhibited: REASON, note: "" });
    expect(w.find(".y-aim__reason").exists()).toBe(false);
    expect(w.text()).not.toContain(REASON);

    const dial = dialOf(w);
    down(dial, 20, 0);
    move(dial, 40, 0);
    fire(dial, "pointerup");
    expect(w.emitted("slew")).toBeUndefined();
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("a note of its own is drawn in place of the inhibition's words", () => {
    // The panel's own case: a short `not answering` under the dial while the
    // head carries the device's full reason. Two sentences, one each.
    const w = pad({ inhibited: REASON, note: "not answering" });
    expect(w.find(".y-aim__reason").text()).toBe("not answering");
    expect(w.text()).not.toContain(REASON);
  });

  /**
   * Not one of the plan's own eight — the test above dispatches a real
   * pointerdown, which a CSS-only gate (`pointer-events: none`) would not
   * stop, since a dispatched event bypasses hit-testing entirely. This
   * dispatches a bare `Event` with no coordinate and no pointerId at all,
   * so it also proves the guard runs before `at()` would even be reached.
   */
  it("the guard inside down() stops a press even when dispatched directly, with no coordinate", () => {
    const w = pad({ inhibited: REASON });
    dialOf(w).dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    expect(w.emitted("slew")).toBeUndefined();
  });

  /**
   * Found by mutation testing, not anticipated up front: removing `down()`'s
   * own `if (this.inhibited) return` (and leaving `updateFromEvent()`'s
   * separate inhibited check in place) left every other test in this
   * `describe` block green, because `down()` always calls
   * `updateFromEvent()` at its own end, and that function's guard alone was
   * enough to stop the emission. Nothing in this file distinguished "the
   * press was refused outright" from "the press was accepted, captured,
   * and only *then* refused" — both look identical from `emitted()` alone.
   * This is the difference: capturing the pointer (and recording
   * `pointerId`) is a real side effect a fully-inhibited control must not
   * have, and only a test that inspects that side effect — not the emitted
   * events — can tell the two implementations apart.
   */
  it("captures nothing at all while inhibited — not even the pointer", () => {
    const w = pad({ inhibited: REASON });
    const dial = dialOf(w) as unknown as { setPointerCapture: (id: number) => void };
    dial.setPointerCapture = vi.fn();
    down(dial, 20, 0);
    expect(dial.setPointerCapture).not.toHaveBeenCalled();
  });

  it("stops an in-flight gesture the instant it becomes inhibited (R-CMD-04)", async () => {
    const w = pad({ inhibited: null });
    const dial = dialOf(w);
    down(dial, 20, 0);
    expect(slews(w)).toHaveLength(1);
    await w.setProps({ inhibited: REASON });
    expect(stops(w)).toHaveLength(1);
  });

  it("a held pointer cannot resume slewing after becoming inhibited without a fresh press", async () => {
    const w = pad({ inhibited: null });
    const dial = dialOf(w);
    down(dial, 20, 0);
    await w.setProps({ inhibited: REASON });
    move(dial, 30, 0); // still physically held, now inhibited
    expect(slews(w)).toHaveLength(1); // only the original press's slew
    expect(stops(w)).toHaveLength(1); // exactly one stop, from becoming inhibited
  });
});

describe("the struck axis — one the device advertises and will not answer", () => {
  /**
   * Given in the plan text with `...` for a body.
   */
  it("draws the struck axis for one that will not answer", () => {
    const present = pad({ axes: { pan: "present", tilt: "present", roll: "present" } });
    expect(present.find(".y-aim__struck").exists()).toBe(false);

    const struck = pad({ axes: { pan: "present", tilt: "present", roll: "advertised" } });
    expect(struck.find(".y-aim__struck").exists()).toBe(true);
    expect(struck.find(".y-aim__struck-label").text()).toContain("ROLL");
  });

  it("defaults to present when axes is not given at all", () => {
    expect(pad({}).find(".y-aim__struck").exists()).toBe(false);
  });

  it("omits an axis the camera does not offer", () => {
    // R-CMD-04's own spirit, applied to a reading rather than a command:
    // an axis this page was never told about is not assumed safe.
    const w = pad({ axes: { pan: "present", tilt: "present" } });
    expect(w.find(".y-aim__struck").exists()).toBe(false);
  });
});

describe("the haloed puck", () => {
  /**
   * Given in the plan text with `...` for a body.
   */
  it("draws the haloed puck at the centre at rest and under the pointer while pushing", async () => {
    // A raw `dispatchEvent()` (not `@vue/test-utils`' own `trigger()`)
    // updates this component's reactive `px`/`py` synchronously, but Vue's
    // own DOM patch is a microtask — reading a rendered `cx`/`cy` attribute
    // straight after `down()`/`fire()` without a tick reads the *previous*
    // render, not this one. Confirmed directly: without the `await` below,
    // this test passed for the wrong reason (the halo's `cx` never moved
    // off "59" because the DOM never repainted) rather than failing loudly,
    // which `emitted()`-based assertions elsewhere in this file do not need
    // — `$emit` itself is synchronous — only a rendered-attribute check does.
    const w = pad({});
    const halo = () => w.find(".y-aim__puck-halo");
    const core = () => w.find(".y-aim__puck-core");

    expect(Number(halo().attributes("cx"))).toBe(CENTER);
    expect(Number(halo().attributes("cy"))).toBe(CENTER);

    const dial = dialOf(w);
    down(dial, 20, -10);
    await w.vm.$nextTick();
    expect(Number(halo().attributes("cx"))).not.toBe(CENTER);
    expect(Number(core().attributes("cx"))).toBe(Number(halo().attributes("cx")));
    expect(Number(core().attributes("cy"))).toBe(Number(halo().attributes("cy")));

    fire(dial, "pointerup");
    await w.vm.$nextTick();
    expect(Number(halo().attributes("cx"))).toBe(CENTER);
    expect(Number(halo().attributes("cy"))).toBe(CENTER);
  });

  it("returns the puck to centre when the drag re-enters the dead zone, even without releasing", async () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0);
    move(dial, 0, 0);
    await w.vm.$nextTick();
    expect(Number(w.find(".y-aim__puck-core").attributes("cx"))).toBe(CENTER);
  });

  /**
   * Found by mutation testing: dropping the `Math.min(d, RIM)` clamp on the
   * puck's own drawn position (while leaving the *rate*'s own separate
   * `Math.min(1, ...)` clamp untouched) left "emits a rate ... never a
   * position" green, because that test only reads the emitted `slew`
   * payload, which this mutation never touches — only the puck's own
   * drawn `cx`/`cy` drifts past the rim. The rate contract and the drawn
   * puck are two different facts, each needing its own assertion.
   */
  it("clamps the drawn puck to the rim even when the pointer goes further", async () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 400, 0); // far beyond the rim
    await w.vm.$nextTick();
    const cx = Number(w.find(".y-aim__puck-core").attributes("cx"));
    expect(cx).toBeCloseTo(CENTER + RIM, 5);
  });
});

describe("at the limit", () => {
  it("shows the pill when either axis reports it, and not otherwise", () => {
    expect(pad({}).find(".y-aim__limit").exists()).toBe(false);
    expect(pad({ atLimit: { pitch: true, yaw: false } }).find(".y-aim__limit").exists()).toBe(true);
    expect(pad({ atLimit: { pitch: false, yaw: true } }).find(".y-aim__limit").exists()).toBe(true);
    expect(pad({ atLimit: { pitch: false, yaw: false } }).find(".y-aim__limit").exists()).toBe(false);
  });
});

describe("pointer capture", () => {
  it("attempts pointer capture on press, guarded so a jsdom without it cannot throw", () => {
    // jsdom does not implement setPointerCapture at all here (confirmed: an
    // unstubbed element throws "el.setPointerCapture is not a function").
    // Stubbing it directly on this one element proves the call happens;
    // every other test in this file leaves it unstubbed and never throws,
    // which is what proves the `?.` guard actually protects the call.
    const w = pad({});
    const dial = dialOf(w) as unknown as { setPointerCapture: (id: number) => void };
    dial.setPointerCapture = vi.fn();
    down(dialOf(w), 20, 0, 7);
    expect(dial.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("never throws when setPointerCapture does not exist, across a full drag", () => {
    const w = pad({});
    const dial = dialOf(w);
    expect(() => {
      down(dial, 20, 0);
      move(dial, 25, 0);
      fire(dial, "pointerup");
    }).not.toThrow();
  });
});

describe("re-entrancy guards", () => {
  it("ignores a move with nothing pressed", () => {
    const w = pad({});
    move(dialOf(w), 20, 0);
    expect(w.emitted("slew")).toBeUndefined();
  });

  it("ignores a second, concurrent pointerdown while one is already active", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0, 1);
    const afterFirst = slews(w).length;
    down(dial, 30, 0, 2);
    expect(slews(w)).toHaveLength(afterFirst);
  });

  it("ignores a move from a pointer other than the one being held", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0, 1);
    const afterDown = slews(w).length;
    move(dial, 30, 0, 2);
    expect(slews(w)).toHaveLength(afterDown);
    move(dial, 30, 0, 1);
    expect(slews(w)).toHaveLength(afterDown + 1);
  });

  it("allows a fresh press after a full release", () => {
    const w = pad({});
    const dial = dialOf(w);
    down(dial, 20, 0);
    fire(dial, "pointerup");
    down(dial, 20, 0);
    expect(slews(w).length).toBeGreaterThanOrEqual(2);
  });
});

describe("teardown", () => {
  it("releases if torn down mid-hold", () => {
    const w = pad({});
    down(dialOf(w), 20, 0);
    w.unmount();
    expect(stops(w)).toHaveLength(1);
  });

it("a press refused while inhibited cannot start slewing when the inhibition lifts", async () => {
    // **The guard's real job, and nothing pinned it until review.** The
    // shipped `down()` refuses a press while inhibited *and* records no
    // pointer id. A surgical mutant that skipped only the capture, while
    // still recording the id, passed all thirty-nine tests here — including
    // "captures nothing at all while inhibited" — and yet let a slew fire:
    // press while inhibited, the deck clears the inhibition while the
    // operator is still holding, then a move with no fresh press starts the
    // gimbal moving. That is a command nobody sent, which is exactly what
    // R-CMD-04 forbids. The pad may only ever move on a press it accepted.
    const w = pad({ inhibited: "gimbal not responding" });
    const dial = dialOf(w);
    down(dial, 0, 0);
    move(dial, 40, 0);
    expect(w.emitted("slew"), "a press while inhibited must not slew").toBeUndefined();

    await w.setProps({ inhibited: null });
    move(dial, 40, 0);
    expect(
        w.emitted("slew"),
        "the inhibition lifting is not a press — a gesture may only begin with one",
    ).toBeUndefined();

    // And a fresh press, now that it is allowed, does move.
    down(dial, 0, 0);
    move(dial, 40, 0);
    expect(w.emitted("slew")).toHaveLength(1);
});
});

it('keeps captured motion outside the pad until real release and stops only once', () => {
  const w = pad({}); const el = dialOf(w) as SVGElement;
  let captured: number | null = null;
  el.setPointerCapture = vi.fn(id => { captured = id; });
  el.hasPointerCapture = vi.fn(id => captured === id);
  el.releasePointerCapture = vi.fn(() => { captured = null; });
  down(el, RIM, 0, 7);
  const gesture = slews(w).at(-1)?.gesture;
  fire(el, 'pointerleave');
  expect(stops(w)).toHaveLength(0);
  move(el, 400, 0, 7);
  expect(slews(w).at(-1)).toMatchObject({ gesture, pan: 30 });
  fire(el, 'pointerup'); fire(el, 'lostpointercapture');
  expect(stops(w)).toEqual([{ gesture }]);
});

it.each([
  { left: 40, top: 80, width: 264, height: 264 },
  { left: 20, top: 30, width: 198, height: 99 },
  { left: 25, top: 35, width: 99, height: 198 },
])('maps the painted dial rim using centered SVG meet scaling %j', rect => {
  const w = pad({}); const el = dialOf(w);
  el.getBoundingClientRect = () => rect as DOMRect;
  // The SVG paints a square dial centered inside wide or tall viewports.
  const paintedRim = 44 * Math.min(rect.width, rect.height) / 118;
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const dispatch = (dx: number, dy: number, type = 'pointermove') => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: center.x + dx, clientY: center.y + dy }));
  dispatch(0, 0, 'pointerdown'); expect(slews(w)).toHaveLength(0);
  dispatch(paintedRim, 0); expect(slews(w).at(-1)?.pan).toBeCloseTo(30);
  expect(slews(w).at(-1)?.tilt).toBeCloseTo(0);
  dispatch(0, -paintedRim); expect(slews(w).at(-1)?.tilt).toBeCloseTo(30);
  dispatch(0, paintedRim); expect(slews(w).at(-1)?.tilt).toBeCloseTo(-30);
  dispatch(-paintedRim, 0); expect(slews(w).at(-1)?.pan).toBeCloseTo(-30);
});

it.each(['width', 'height'].flatMap(axis => [0, -1, NaN, Infinity].map(value => ({ axis, value }))))('ends the hold on invalid bounds %j without resuming on layout recovery', ({ axis, value }) => {
  const w = pad({}); const el = dialOf(w);
  down(el, RIM, 0);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 132, height: 132, [axis]: value }) as DOMRect;
  move(el, RIM, 0); expect(stops(w)).toHaveLength(1);
  const before = slews(w).length;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 132, height: 132 }) as DOMRect;
  move(el, RIM, 0); expect(slews(w)).toHaveLength(before);
});
