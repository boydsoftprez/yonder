// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import YonderAim from "./YonderAim.vue";
import YonderAimPad from "./YonderAimPad.vue";
import YonderSegmented from "./YonderSegmented.vue";

/**
 * `task-23-brief.md`'s own Step 1 names ten behaviours in prose and gives no
 * bodies; the coordinator's resolutions in that same file specify the
 * behaviour and leave the assertions here, on the same evidence Tasks
 * 19–22 already recorded: a body dictated verbatim has twice carried a
 * mistake about JavaScript an implementer had to find, and what has held
 * across this whole plan is the behaviour named, not a guess at the code
 * that proves it. Every mutation this file's own tests were checked
 * against is named in `task-23-report.md`, including the ones that stayed
 * green.
 *
 * **R-UI-28 is the point of this whole file, not one test in it.** Every
 * mount below uses `props.report` alone — no `$store` mixin, no sibling
 * widget — except the one test in "the live report" that exists
 * specifically to prove the *opposite* precedence (a live store entry wins
 * over the configured fallback when both are present). That the other
 * dozen-plus tests never need a store at all is the real proof that this
 * panel draws from its own payload with nothing shared; "mounts alone from
 * its payload" is written to assert that it draws (pad, gauges, badge, all
 * present), not merely that mounting without a store fails to throw.
 *
 * **This file does not re-prove `YonderAimPad`'s own state machine** — the
 * gesture id, the eight endings, the dead zone, its own two inhibited
 * guards are `aimpad.component.test.ts`'s job, already done in Task 20 and
 * read in full before writing a line here. What is this file's job: that a
 * press reaching the pad while this panel says `inhibited` produces no
 * emission through *this* node's own socket, that a press while live *does*
 * relay through it verbatim, and that this panel does not reintroduce the
 * subtle defect Task 20's review found by holding its own stale copy of
 * `inhibited` (coordinator resolution 6) — `padInhibited` in `YonderAim.vue`
 * is a computed, never assigned into `data()`.
 */

interface AimReport {
    state: string;
    reason: string;
    pan: number;
    tilt: number;
    bounds: { pan: [number, number]; tilt: [number, number] } | null;
    atLimit: { pitch: boolean; yaw: boolean };
    mode: string;
    modes: string[];
    inhibited: string | null;
}

/** A live, fully-answering report — the base every test narrows with its
 * own overrides, the same idiom `deck.component.test.ts`'s own
 * `makeReport()` uses. */
function makeReport(overrides: Partial<AimReport> = {}): AimReport {
    return {
        state: "present",
        reason: "",
        pan: 12.4,
        tilt: -6.0,
        bounds: { pan: [-180, 180], tilt: [-90, 90] },
        atLimit: { pitch: false, yaw: false },
        mode: "Follow",
        modes: ["Follow", "Tilt lock", "FPV"],
        inhibited: null,
        ...overrides,
    };
}

/** Mounts from `props.report` alone — no `$store`, no sibling widget. This
 * is the shape R-UI-28 requires the Cockpit to be able to rely on, so it is
 * also the shape almost every test in this file uses, deliberately, rather
 * than reaching for a store mock out of habit. */
function mountAim(report: unknown, id = "a1") {
    const emit = vi.fn();
    const wrapper = mount(YonderAim, {
        props: { id, props: { report } },
        global: { provide: { $socket: { emit }, $dataTracker: () => {} } },
    });
    return { wrapper, emit };
}

/** The one place this file mounts against a live `$store` at all — see
 * "the live report" below. */
function mountAimWithStore(live: unknown, configuredFallback: unknown = null, id = "a1") {
    const emit = vi.fn();
    const store = { state: { data: { messages: { [id]: { payload: live } } } } };
    const wrapper = mount(YonderAim, {
        props: { id, props: { report: configuredFallback } },
        global: {
            provide: { $socket: { emit }, $dataTracker: () => {} },
            mixins: [{ computed: { $store: () => store } }],
        },
    });
    return { wrapper, emit };
}

function badge(w: VueWrapper<any>) {
    return w.find(".y-col__q");
}
function legend(w: VueWrapper<any>) {
    return w.find(".y-col__legend");
}
function reasonLine(w: VueWrapper<any>) {
    return w.find(".y-aimpanel__reason");
}
function dial(w: VueWrapper<any>): Element {
    return w.find(".y-aim__dial").element;
}
function recentreBtn(w: VueWrapper<any>) {
    return w.find(".y-aimpanel__recentre");
}
function rateValue(w: VueWrapper<any>) {
    return w.find(".y-aimpanel__rate-v");
}

/**
 * The sentences this panel draws for the three modes the blueprint draws
 * (`MODE_SENTENCES` in `YonderAim.vue`), mirrored here by hand rather than
 * imported — the same reasoning `TRACK_WIDTH` below is mirrored for: a test
 * that imported the table would assert the component agrees with itself,
 * and what L-38 is actually about is the words on the page.
 */
const SAYS = {
    follow: "Pan and tilt follow the handle.",
    tiltLock: "Tilt holds where it is. Pan follows the handle.",
    fpv: "Pan, tilt and roll follow the aircraft.",
};

/**
 * Where a part sits relative to another, which is what L-33, L-36 and L-39
 * are each about. Every one of those three shipped *built* and drifted, and
 * a test asking only whether both parts exist would have stayed green on
 * the panel the first photograph disagrees with — so these read document
 * order, not presence.
 */
function drawnBefore(a: Element, b: Element) {
    return Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
}

/** A `.y-aimpanel__sub` block heading by its own words. */
function subHeading(w: VueWrapper<any>, text: string): Element {
    const found = w.findAll(".y-aimpanel__sub").find((h) => h.text() === text);
    if (!found) {
        throw new Error(`no sub-heading reading "${text}" among ` +
            w.findAll(".y-aimpanel__sub").map((h) => `"${h.text()}"`).join(", "));
    }
    return found.element;
}

/** How many times a sentence appears in what the panel draws. One is the
 * whole point of the "said once" tests: two is K-63's second part. */
function times(haystack: string, needle: string) {
    return haystack.split(needle).length - 1;
}

/** Finds a mounted `YonderPositionGauge` by its own label — the same
 * "find by the label element's own text" idiom
 * `deck.component.test.ts`'s own `controlByLabel()` uses for every ported
 * part in this library. */
function gaugeByLabel(w: VueWrapper<any>, label: string) {
    const blocks = w.findAll(".y-pg");
    const match = blocks.find((b) => b.find(".y-pg__label").text() === label);
    if (!match) throw new Error(`no .y-pg labelled "${label}" among ${blocks.length} found`);
    return match;
}

function slewCalls(emit: ReturnType<typeof vi.fn>) {
    return emit.mock.calls.filter(([, , msg]) => msg?.payload?.slew);
}
function stopCalls(emit: ReturnType<typeof vi.fn>) {
    return emit.mock.calls.filter(([, , msg]) => msg?.payload?.stop);
}

/**
 * Raw `PointerEvent` dispatch, mirroring `aimpad.component.test.ts`'s own
 * `point()`/`down()`/`move()`/`fire()` exactly — the same three jsdom traps
 * that file's own header documents at length (no pointer capture, no
 * layout, and `@vue/test-utils`' own `trigger("pointerdown", {clientX})`
 * throwing in this project's jsdom) apply here too, because the dial these
 * helpers drive is `YonderAimPad`'s own, composed unchanged inside this
 * panel. This file does not re-derive the pad's own rate arithmetic (that
 * is Task 20's proof, not this one's) — a press just past the dead zone,
 * straight out along pan+, is enough to prove *this* panel relays whatever
 * the pad emits, or refuses to let a press begin one at all.
 */
const CENTER = 59;
const VIEWBOX = 118;
const DIAL_SIZE = 132;

function toClient(xSvg: number, ySvg: number) {
    return {
        clientX: ((xSvg + CENTER) / VIEWBOX) * DIAL_SIZE,
        clientY: ((ySvg + CENTER) / VIEWBOX) * DIAL_SIZE,
    };
}
function point(type: string, xSvg: number, ySvg: number, pointerId = 1): PointerEvent {
    const { clientX, clientY } = toClient(xSvg, ySvg);
    return new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true, cancelable: true });
}
function press(el: Element, xSvg = 20, ySvg = 0): void {
    el.dispatchEvent(point("pointerdown", xSvg, ySvg));
}
function drag(el: Element, xSvg: number, ySvg: number): void {
    el.dispatchEvent(point("pointermove", xSvg, ySvg));
}
function release(el: Element): void {
    el.dispatchEvent(new Event("pointerup", { bubbles: true, cancelable: true }));
}

describe("mounts alone from its payload (R-UI-28)", () => {
    /**
     * Coordinator resolution 1: "Test that by mounting it on its own and
     * asserting it draws, not by asserting an absence." No `$store`, no
     * sibling widget — `mountAim()` never provides one — and this asserts
     * the panel actually renders its content from `props.report` alone:
     * the pad, both gauges with real values, and the live badge.
     */
    it("draws the pad, both gauges and the live badge from props.report with no store at all", () => {
        const { wrapper } = mountAim(makeReport({ pan: 90, tilt: -45 }));
        expect(wrapper.find(".y-aim__dial").exists()).toBe(true);
        expect(gaugeByLabel(wrapper, "Pan").text()).toContain("90.0");
        expect(gaugeByLabel(wrapper, "Tilt").text()).toContain("-45.0");
        expect(badge(wrapper).text()).toBe("RATE CONTROL");
        expect(legend(wrapper).text()).toBe("Aim");
    });

    it("shows a waiting placeholder, and draws nothing else, before any report arrives", () => {
        const { wrapper } = mountAim(undefined);
        expect(wrapper.text()).toContain("Waiting for this camera's report.");
        expect(wrapper.find(".y-aim__dial").exists()).toBe(false);
        expect(wrapper.find(".y-col").exists()).toBe(false);
    });
});

describe("the live report wins over the configured fallback", () => {
    it("prefers $store's live message over props.report when both are present", () => {
        // Both fixtures share the identical `modes` list, so "Tilt lock"
        // legitimately appears in the mounted tree either way, as one of
        // the segmented control's own button labels — asserting its plain
        // absence would prove nothing about precedence. The *sentence*
        // saying what the active mode does is what discriminates.
        const { wrapper } = mountAimWithStore(
            makeReport({ mode: "FPV" }),
            makeReport({ mode: "Tilt lock" }),
        );
        expect(wrapper.text()).toContain(SAYS.fpv);
        expect(wrapper.text()).not.toContain(SAYS.tiltLock);
    });

    it("falls back to the configured report when the store has no message yet", () => {
        const store = { state: { data: { messages: {} } } };
        const wrapper = mount(YonderAim, {
            props: { id: "a1", props: { report: makeReport({ mode: "Tilt lock" }) } },
            global: {
                provide: { $socket: { emit: vi.fn() }, $dataTracker: () => {} },
                mixins: [{ computed: { $store: () => store } }],
            },
        });
        expect(wrapper.text()).toContain(SAYS.tiltLock);
    });
});

describe("position against bounds", () => {
    /** `YonderPositionGauge`'s own `TRACK_WIDTH`, mirrored by hand rather
     * than imported — a plain part exports no test-only constants, the
     * same reasoning `positiongauge.component.test.ts`'s own header states. */
    const TRACK_WIDTH = 96;

    it("places each pointer at (value - min) / (max - min) of the track, against this report's own bounds", () => {
        const { wrapper } = mountAim(makeReport({
            pan: 90, tilt: -45, bounds: { pan: [-180, 180], tilt: [-90, 90] },
        }));
        const panPtr = gaugeByLabel(wrapper, "Pan").find(".y-pg__ptr");
        const tiltPtr = gaugeByLabel(wrapper, "Tilt").find(".y-pg__ptr");
        // (90 - -180) / 360 = 0.75
        expect(parseFloat((panPtr.element as HTMLElement).style.left)).toBeCloseTo(0.75 * TRACK_WIDTH, 5);
        // (-45 - -90) / 180 = 0.25
        expect(parseFloat((tiltPtr.element as HTMLElement).style.left)).toBeCloseTo(0.25 * TRACK_WIDTH, 5);
    });

    it("reads both axes dead, with the reason, when bounds is null", () => {
        const { wrapper } = mountAim(makeReport({
            bounds: null, inhibited: "position has not been established yet",
        }));
        const pan = gaugeByLabel(wrapper, "Pan");
        const tilt = gaugeByLabel(wrapper, "Tilt");
        expect(pan.find(".y-pg__val").text()).toBe("—");
        expect(tilt.find(".y-pg__val").text()).toBe("—");
        expect(pan.classes()).toContain("is-dead");
        expect(pan.text()).toContain("position has not been established yet");
    });

    /**
     * K-65. `aimPanel()` answers `pan: null` for a gimbal that is `present`
     * and has never said where it is pointing — §8.7's attitude push is
     * unbuilt — and its own comment says why: *a zero would be a claim*.
     * This panel drew that claim: `PAN 0.0 °`, with a pointer on the track,
     * under a heading reading `Reported position`. Nothing reported it.
     */
    it("an axis nothing has reported reads dead, not zero", () => {
        const { wrapper } = mountAim(makeReport({ pan: null as unknown as number, tilt: null as unknown as number }));
        for (const label of ["Pan", "Tilt"]) {
            const g = gaugeByLabel(wrapper, label);
            expect(g.find(".y-pg__val").text()).toBe("—");
            expect(g.find(".y-pg__ptr").exists()).toBe(false);
            expect(g.classes()).toContain("is-dead");
        }
    });

    it("says why it has no reading in its own words, not the head's", () => {
        const { wrapper } = mountAim(makeReport({
            pan: null as unknown as number,
            tilt: null as unknown as number,
            inhibited: "the motion guard is not built yet, so nothing is sent",
        }));
        const pan = gaugeByLabel(wrapper, "Pan");
        expect(pan.text()).toContain("this gimbal has not said where it is pointing");
        // The head's own sentence is said once, above — never again under a
        // gauge. That repetition is the defect K-63 closed.
        expect(pan.text()).not.toContain("the motion guard is not built yet");
    });

    it("is per axis: one reported and one not draws one reading and one dash", () => {
        const { wrapper } = mountAim(makeReport({ pan: 42.5, tilt: null as unknown as number }));
        const pan = gaugeByLabel(wrapper, "Pan");
        const tilt = gaugeByLabel(wrapper, "Tilt");
        expect(pan.find(".y-pg__val").text()).toContain("42.5");
        expect(pan.classes()).not.toContain("is-dead");
        expect(tilt.find(".y-pg__val").text()).toBe("—");
        expect(tilt.classes()).toContain("is-dead");
    });

    it("bounds being null is a fact about reporting, independent of aimState — the pad and Recentre stay live", () => {
        // Proves the two facts are wired from two different payload fields,
        // not one flag doing both jobs: present with no bounds yet still
        // lets the operator slew and Recentre; only the two readings go dead.
        const { wrapper } = mountAim(makeReport({ bounds: null, inhibited: null }));
        expect(recentreBtn(wrapper).attributes("disabled")).toBeUndefined();
        expect(gaugeByLabel(wrapper, "Pan").classes()).toContain("is-dead");
    });
});

describe("the blueprint's own order: the reading, then the rate, then the mode", () => {
    /**
     * Every one of these three was recorded *built* against the source and
     * every one of them is wrong in the first photograph anything took of
     * this panel with a gimbal answering (`camera-live-pair.*.png`, Task
     * 48). They are order-and-presence assertions for that reason: the
     * parts were all there, in the wrong places, with one of them missing
     * outright.
     */
    it("draws a Reported position heading above the two gauges (L-33)", () => {
        const { wrapper } = mountAim(makeReport());
        const heading = subHeading(wrapper, "Reported position");
        expect(drawnBefore(heading, gaugeByLabel(wrapper, "Pan").element)).toBe(true);
        expect(drawnBefore(heading, gaugeByLabel(wrapper, "Tilt").element)).toBe(true);
        // And under the dial, not over it — it heads the gauges, not the pad.
        expect(drawnBefore(wrapper.find(".y-aim__dial").element, heading)).toBe(true);
    });

    it("draws the commanded rate below both gauges, not above them (L-36)", () => {
        const { wrapper } = mountAim(makeReport());
        const rate = wrapper.find(".y-aimpanel__rate").element;
        expect(drawnBefore(gaugeByLabel(wrapper, "Pan").element, rate)).toBe(true);
        expect(drawnBefore(gaugeByLabel(wrapper, "Tilt").element, rate)).toBe(true);
        expect(subHeading(wrapper, "Commanded rate")).toBeTruthy();
    });

    it("draws the rate against its bounds, from the pad's own rim rate (L-36)", () => {
        // 30 is `YonderAimPad`'s own exported MAX_RATE — the fastest this pad
        // can ask for — and it is imported rather than written down twice.
        // The payload states no maximum of the gimbal's own; see
        // `YonderAim.vue`'s doc comment on the rate block.
        const { wrapper } = mountAim(makeReport());
        const bounds = wrapper.find(".y-aimpanel__rate-b");
        expect(bounds.exists()).toBe(true);
        const ends = bounds.findAll("span").map((e) => e.text());
        expect(ends).toEqual(["0", "30 °/s"]);
    });

    it("keeps the rate's ceiling and the rate the pad emits the same number", async () => {
        // Proves the bound is the pad's own, not a `30` typed beside it: push
        // to the rim and the reading has to reach exactly the stated ceiling.
        const { wrapper } = mountAim(makeReport());
        const ceiling = wrapper.find(".y-aimpanel__rate-b").findAll("span")[1]!.text();
        press(dial(wrapper), 44, 0);
        await wrapper.vm.$nextTick();
        expect(`${rateValue(wrapper).text().replace("°/s", "")} °/s`).toBe(ceiling);
    });
});

describe("the mode control, and the fact where it cannot be drawn", () => {
    it("offers exactly the modes the device states", () => {
        const { wrapper } = mountAim(makeReport({ modes: ["Follow", "Tilt lock", "FPV"] }));
        expect(wrapper.findAll(".y-seg__opt").map((b) => b.text()))
            .toEqual(["Follow", "Tilt lock", "FPV"]);
        expect(wrapper.text()).not.toContain("has not said what it can be set to");
    });

    it("draws no control at all when the device states no modes (R-UI-20)", () => {
        // K-63's fourth part. `aimPanel` answers `modes: []` because §8.7's
        // `0x44` enumeration is unbuilt, and an empty labelled group is a
        // control offering nothing.
        const { wrapper } = mountAim(makeReport({ modes: [] }));
        expect(wrapper.find(".y-seg").exists()).toBe(false);
        expect(wrapper.find(".y-seg__group").exists()).toBe(false);
    });

    it("states the fact where the control would have been, naming the mode it is in", () => {
        // The other half of R-UI-20: never simply absent. Before this the
        // control vanished silently and the panel said nothing at all where
        // the blueprint draws three modes.
        const { wrapper } = mountAim(makeReport({ mode: "Follow", modes: [] }));
        const fact = wrapper.find(".y-aimpanel__nomode");
        expect(fact.exists(), "no fact drawn where the mode control would have been").toBe(true);
        expect(fact.find(".y-aimpanel__nomode-l").text()).toBe("Gimbal mode");
        expect(fact.find(".y-aimpanel__nomode-v").text())
            .toBe("Follow — and this gimbal has not said what it can be set to");
    });

    it("puts the fact exactly where the control would have been", () => {
        // Under the commanded rate and over the mode sentence, in the row the
        // control holds when there is one — not appended somewhere else.
        const { wrapper } = mountAim(makeReport({ mode: "Follow", modes: [] }));
        const fact = wrapper.find(".y-aimpanel__nomode").element;
        expect(drawnBefore(wrapper.find(".y-aimpanel__rate").element, fact)).toBe(true);
        expect(drawnBefore(fact, wrapper.find(".y-aimpanel__modeline").element)).toBe(true);
    });

    it("states what was reported, and never that the gimbal has no other mode", () => {
        // `modes: []` is a gimbal that has not listed its modes. Saying it
        // has none would be this console answering a question nothing asked.
        const { wrapper } = mountAim(makeReport({ mode: "", modes: [] }));
        expect(wrapper.find(".y-aimpanel__nomode-v").text())
            .toBe("this gimbal has not said what it can be set to");
        expect(wrapper.text()).not.toContain("Tilt lock");
        expect(wrapper.text()).not.toContain("FPV");
    });
});

describe("the commanded-rate block only when present", () => {
    it("shows the rate block while present", () => {
        const { wrapper } = mountAim(makeReport({ state: "present" }));
        expect(wrapper.find(".y-aimpanel__rate").exists()).toBe(true);
    });

    it("omits the rate block when the device is not answering", () => {
        const { wrapper } = mountAim(makeReport({ state: "advertised", reason: "no motor" }));
        expect(wrapper.find(".y-aimpanel__rate").exists()).toBe(false);
    });

    it("reads the magnitude of the pad's own last relayed slew, and resets to 0 on stop", async () => {
        const { wrapper } = mountAim(makeReport({ state: "present" }));
        expect(rateValue(wrapper).text()).toContain("0");
        press(dial(wrapper), 44, 0); // at the rim: full rate, 30 deg/s
        await wrapper.vm.$nextTick();
        expect(rateValue(wrapper).text()).toContain("30");
        release(dial(wrapper));
        await wrapper.vm.$nextTick();
        expect(rateValue(wrapper).text()).toContain("0");
    });
});

describe("the RATE CONTROL / NOT ANSWERING badge", () => {
    it("reads RATE CONTROL, in the select tone, while present", () => {
        const { wrapper } = mountAim(makeReport({ state: "present" }));
        expect(badge(wrapper).text()).toBe("RATE CONTROL");
        expect(badge(wrapper).classes()).toContain("tone-select");
    });

    it("reads NOT ANSWERING, in the waiting tone, while advertised and not answering", () => {
        const { wrapper } = mountAim(makeReport({ state: "advertised", reason: "no motor behind either" }));
        expect(badge(wrapper).text()).toBe("NOT ANSWERING");
        expect(badge(wrapper).classes()).toContain("tone-waiting");
    });

    it("reads NOT ANSWERING, in the neutral fallback tone, while gated", () => {
        const { wrapper } = mountAim(makeReport({ state: "gated", reason: "recording has it" }));
        expect(badge(wrapper).text()).toBe("NOT ANSWERING");
        expect(badge(wrapper).classes()).not.toContain("tone-waiting");
        expect(badge(wrapper).classes()).not.toContain("tone-select");
    });
});

describe("the mode sentence says what the mode does, under the control", () => {
    it("says what the mode does, not what it is called", () => {
        const { wrapper } = mountAim(makeReport({ mode: "Tilt lock" }));
        expect(wrapper.find(".y-aimpanel__modeline").text()).toBe(SAYS.tiltLock);
        // The name is already on the button above it. Restating it there was
        // L-38's drift: `Gimbal mode: Tilt lock.` told an operator nothing
        // the control did not already say.
        expect(wrapper.find(".y-aimpanel__modeline").text()).not.toContain("Gimbal mode:");
    });

    it("reads the device's own word for the mode whatever case it sends it in", () => {
        // `aimPanel` answers the DJI probe's own lower-case `follow`; this
        // file's fixtures say `Follow`. One mode, one sentence.
        expect(mountAim(makeReport({ mode: "follow" })).wrapper.text()).toContain(SAYS.follow);
        expect(mountAim(makeReport({ mode: "Follow" })).wrapper.text()).toContain(SAYS.follow);
    });

    it("sits below the segmented control, not above it", () => {
        // L-39. Above it, the sentence explained a control the operator had
        // not reached yet.
        const { wrapper } = mountAim(makeReport({ mode: "Follow" }));
        const control = wrapper.find(".y-seg").element;
        const sentence = wrapper.find(".y-aimpanel__modeline").element;
        expect(drawnBefore(control, sentence)).toBe(true);
    });

    it("draws nothing where the sentence would be when no mode is reported", () => {
        const { wrapper } = mountAim(makeReport({ mode: "" }));
        expect(wrapper.find(".y-aimpanel__modeline").exists()).toBe(false);
    });

    it("says nothing about a mode nobody has written a sentence for, rather than inventing one", () => {
        // The mode itself is not lost — the control marks it — but what it
        // *does* is a fact about a gimbal this project has not seen.
        const { wrapper } = mountAim(makeReport({ mode: "Sport", modes: ["Follow", "Sport"] }));
        expect(wrapper.find(".y-aimpanel__modeline").exists()).toBe(false);
        const on = wrapper.findAll(".y-seg__opt").find((b) => b.classes().includes("on"));
        expect(on?.text()).toBe("Sport");
    });

    it("the sentence stays even when there is no selectable control beneath it", () => {
        // modes: [] replaces the control with a stated fact (below), but the
        // current mode is still a reading rather than a control and what it
        // does is still worth saying.
        const { wrapper } = mountAim(makeReport({ mode: "Follow", modes: [] }));
        expect(wrapper.find(".y-seg").exists()).toBe(false);
        expect(wrapper.text()).toContain(SAYS.follow);
    });

    it("changing the mode control posts { mode } through the socket", async () => {
        const { wrapper, emit } = mountAim(makeReport({ mode: "Follow" }));
        const fpvBtn = wrapper.findAll(".y-seg__opt").find((b) => b.text() === "FPV")!;
        await fpvBtn.trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);
        const [event, id, msg] = emit.mock.calls[0]!;
        expect(event).toBe("widget-action");
        expect(id).toBe("a1");
        expect(msg).toEqual({ payload: { mode: "FPV" } });
    });
});

describe("Recentre gimbal", () => {
    it("emits { recentre: true } on press", async () => {
        const { wrapper, emit } = mountAim(makeReport());
        await recentreBtn(wrapper).trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0]![2]).toEqual({ payload: { recentre: true } });
    });

    it("a second press while one is pending emits nothing", async () => {
        const { wrapper, emit } = mountAim(makeReport());
        await recentreBtn(wrapper).trigger("click");
        await recentreBtn(wrapper).trigger("click");
        await recentreBtn(wrapper).trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it("a fresh report clears the pending guard, and a further press emits again", async () => {
        const emit = vi.fn();
        const wrapper = mount(YonderAim, {
            props: { id: "a1", props: { report: makeReport() } },
            global: { provide: { $socket: { emit }, $dataTracker: () => {} } },
        });
        await recentreBtn(wrapper).trigger("click");
        await recentreBtn(wrapper).trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);

        // A fresh message — same content is enough; it is a new object, and
        // this panel's own contract is "a report arrived", not "the report
        // changed" (see YonderAim.vue's own doc comment on why).
        await wrapper.setProps({ props: { report: makeReport() } });
        await recentreBtn(wrapper).trigger("click");
        expect(emit).toHaveBeenCalledTimes(2);
    });

    /**
     * The two independent guards, the same shape `YonderShutter`'s own
     * `pending` documents and tests: `:disabled` stops an ordinary press,
     * and `pressRecentre`'s own `if (this.recentreDisabled) return` stops a
     * *dispatched* click, which reaches a disabled button's listener in a
     * real browser even though `.click()` does not (confirmed by
     * `YonderSegmented`'s and `YonderShutter`'s own header comments against
     * this same jsdom).
     */
    it("carries the disabled attribute whenever a press must do nothing, and a dispatched click still does nothing", () => {
        const { wrapper, emit } = mountAim(makeReport({ state: "advertised", reason: "no motor" }));
        expect(recentreBtn(wrapper).attributes("disabled")).toBeDefined();
        recentreBtn(wrapper).element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
        expect(emit).not.toHaveBeenCalled();
    });

    it("is disabled while a live capability is temporarily inhibited, not only while dead", () => {
        // §8.7: one guard covers rate, mode and Recentre together.
        const { wrapper } = mountAim(makeReport({ state: "present", inhibited: "attitude is stale" }));
        expect(recentreBtn(wrapper).attributes("disabled")).toBeDefined();
    });
});

describe("the mode control follows the same guard as the pad and Recentre", () => {
    it("is disabled while a live capability is temporarily inhibited", () => {
        // §8.7's own opening line: one daemon guard covers rate, mode and
        // Recentre together, from every surface — this is that rule,
        // applied to the mode control specifically. YonderSegmented itself
        // disables an option only when its own `state` prop is not
        // 'present', so this is `modeControlState`'s own "inhibited reads
        // as advertised too" branch, proven rather than merely documented.
        const { wrapper } = mountAim(makeReport({ state: "present", inhibited: "attitude is stale" }));
        const opts = wrapper.findAll(".y-seg__opt");
        expect(opts.length).toBeGreaterThan(0);
        for (const opt of opts) expect(opt.attributes("disabled")).toBeDefined();
    });

    it("stays enabled when present and not inhibited", () => {
        const { wrapper } = mountAim(makeReport({ state: "present", inhibited: null }));
        for (const opt of wrapper.findAll(".y-seg__opt")) expect(opt.attributes("disabled")).toBeUndefined();
    });
});

describe("inhibited shows the reason, and the pad emits nothing", () => {
    const REASON = "attitude is stale; movement is held until it refreshes";

    it("shows the reason while present but inhibited", () => {
        const { wrapper } = mountAim(makeReport({ inhibited: REASON }));
        expect(wrapper.text()).toContain(REASON);
    });

    /**
     * K-63's second part. `effectiveReason` and the pad's own `inhibited`
     * are both true here and both resolved to this same sentence, so an
     * operator read it above the dial and again below it. It is said once,
     * at the head, and the second assertion is the one that matters: a fix
     * that silenced the *head* instead would leave the count at one and
     * move the panel's own fact under the dial, where it heads nothing.
     */
    it("says the reason exactly once, at the head, and not again under the dial", () => {
        // The state the gate photographs (`scripts/fixtures/camera-pair.json`
        // through `aimPanel()`): a gimbal answering `present` under §8.7's
        // unbuilt-guard inhibition, with a known envelope and `modes: []`.
        // The head and the pad both resolved to this sentence and both drew
        // it, 40 px apart.
        const { wrapper } = mountAim(makeReport({ inhibited: REASON, modes: [] }));
        expect(times(wrapper.text(), REASON)).toBe(1);
        expect(reasonLine(wrapper).text()).toBe(REASON);
        expect(wrapper.find(".y-aim__reason").exists()).toBe(false);
    });

    it("silences the pad's sentence without loosening the pad's guard", () => {
        // The suppression is the drawn note, never the guard: the press must
        // still be refused with nothing written under the dial.
        const { wrapper, emit } = mountAim(makeReport({ inhibited: REASON }));
        expect(wrapper.find(".y-aim__reason").exists()).toBe(false);
        press(dial(wrapper), 40, 0);
        drag(dial(wrapper), 44, 0);
        expect(emit).not.toHaveBeenCalled();
    });

    it("keeps the pad's own short sentence where the head is saying a different one", () => {
        // Not present: the head carries the device's own full reason and the
        // pad says `not answering`. Two different sentences, one each — the
        // arrangement Task 23 chose, and the reason the fix above is keyed on
        // which state the panel is in rather than on comparing two strings.
        const { wrapper } = mountAim(makeReport({ state: "advertised", reason: "no motor behind either" }));
        expect(reasonLine(wrapper).text()).toBe("no motor behind either");
        expect(wrapper.find(".y-aim__reason").text()).toBe("not answering");
    });

    it("a press on the pad emits no slew and no stop through this panel's own socket", () => {
        const { wrapper, emit } = mountAim(makeReport({ inhibited: REASON }));
        const el = dial(wrapper);
        press(el, 20, 0);
        drag(el, 40, 0);
        release(el);
        expect(emit).not.toHaveBeenCalled();
    });

    it("does not reintroduce Task 20's own defect: an inhibition that lifts mid-hold must not let a held pointer resume slewing without a fresh press", async () => {
        // padInhibited is a computed here, never copied into data() — this
        // is the regression this whole test exists to catch, one layer up
        // from YonderAimPad's own identical test.
        const emit = vi.fn();
        const wrapper = mount(YonderAim, {
            props: { id: "a1", props: { report: makeReport({ inhibited: REASON }) } },
            global: { provide: { $socket: { emit }, $dataTracker: () => {} } },
        });
        const el = dial(wrapper);
        press(el, 0, 0);
        drag(el, 40, 0);
        expect(slewCalls(emit)).toHaveLength(0);

        await wrapper.setProps({ props: { report: makeReport({ inhibited: null }) } });
        drag(el, 40, 0); // still physically held, no fresh press
        expect(slewCalls(emit)).toHaveLength(0);

        press(el, 0, 0); // a genuinely fresh press, now that it is allowed
        drag(el, 40, 0);
        expect(slewCalls(emit).length).toBeGreaterThan(0);
    });
});

describe("the dead state, with its reason", () => {
    const REASON = "this camera advertises pan and tilt but there is no motor behind either — it accepts the command and nothing moves";

    it("keeps every control drawn — the pad, both gauges, the mode line and Recentre — marked and carrying the reason, rather than hiding any of them", () => {
        const { wrapper } = mountAim(makeReport({
            state: "advertised", reason: REASON, bounds: null, mode: "", modes: [],
        }));
        expect(reasonLine(wrapper).text()).toBe(REASON);
        expect(badge(wrapper).text()).toBe("NOT ANSWERING");
        expect(wrapper.find(".y-aim__dial").exists()).toBe(true);
        expect(gaugeByLabel(wrapper, "Pan").classes()).toContain("is-dead");
        expect(gaugeByLabel(wrapper, "Tilt").classes()).toContain("is-dead");
        expect(recentreBtn(wrapper).attributes("disabled")).toBeDefined();
    });

    /**
     * **The pad refuses, and says so shortly; the panel says why in full.**
     *
     * The pad used to repeat the panel's whole sentence, and so did both
     * position gauges and the mode control — four copies of one fact, more
     * prose than the panel was tall, drawn over the dial it was explaining.
     * The operator reported it as an overlap in the pan and tilt area.
     *
     * A camera that is not answering at all is not a fact about the dial, or
     * about either axis: it is a fact about the panel, and its head carries
     * it once. What the pad owes is that it will not respond.
     */
    it("the pad refuses a press and says so, while the panel carries the reason in full", () => {
        const { wrapper, emit } = mountAim(makeReport({ state: "advertised", reason: REASON }));
        expect(wrapper.find(".y-aim__reason").text()).toBe("not answering");
        expect(wrapper.find(".y-aimpanel__reason").text()).toBe(REASON);
        // Said once between them, never four times.
        expect(wrapper.findAll("*").filter((e) => e.element.children.length === 0
            && e.text().includes(REASON))).toHaveLength(1);
        press(dial(wrapper), 20, 0);
        expect(emit).not.toHaveBeenCalled();
    });

    it("falls back to a plain reason when the device is dead but none was given", () => {
        const { wrapper } = mountAim(makeReport({ state: "gated", reason: "" }));
        expect(wrapper.find(".y-aim__reason").text()).toBe("not answering");
    });
});

describe("not-offered: a stated fact, and nothing else", () => {
    it("draws one fact row and no control at all", () => {
        const { wrapper } = mountAim(makeReport({ state: "not-offered" }));
        expect(wrapper.text()).toContain("this camera has none");
        expect(wrapper.find(".y-aim__dial").exists()).toBe(false);
        expect(wrapper.find(".y-pg").exists()).toBe(false);
        expect(wrapper.find(".y-aimpanel__recentre").exists()).toBe(false);
        expect(wrapper.find(".y-col").exists()).toBe(false);
    });
});

describe("the struck axis stays drawn", () => {
    /**
     * Roll has no report field in this node's own payload at all (unlike
     * the pad's generic `axes` prop) — `YonderAim.vue`'s own `PAD_AXES`
     * hardcodes it exactly as `YonderDeck.buildAim()` does, for the
     * identical reason. This proves the wiring reaches the child, not
     * `YonderAimPad`'s own struck-axis logic, which is
     * `aimpad.component.test.ts`'s job already.
     */
    it("draws roll struck through, every time this panel is live", () => {
        const { wrapper } = mountAim(makeReport());
        expect(wrapper.find(".y-aim__struck").exists()).toBe(true);
        expect(wrapper.find(".y-aim__struck-label").text()).toContain("ROLL");
    });
});

describe("at the limit relays straight through", () => {
    it("shows the pad's own limit pill when atLimit reports it", () => {
        const { wrapper } = mountAim(makeReport({ atLimit: { pitch: true, yaw: false } }));
        expect(wrapper.find(".y-aim__limit").exists()).toBe(true);
    });
});

describe("every emission goes through the socket", () => {
    it("relays slew verbatim, with gesture and seq, exactly as the pad computed them", () => {
        const { wrapper, emit } = mountAim(makeReport());
        // **More than one slew, deliberately.** Comparing only the first
        // relayed event let a hardcoded `seq: 1` through, because the first
        // slew's own seq is 1 — the assertion agreed with the mutant by
        // coincidence. Drag on so the counter advances past any constant
        // somebody might have frozen it at.
        const el = dial(wrapper);
        press(el, 20, 0);
        drag(el, 30, 0);
        drag(el, 40, 0);
        expect(slewCalls(emit).length).toBeGreaterThan(2);
        const [event, id, msg] = slewCalls(emit).at(-1)!;
        expect(event).toBe("widget-action");
        expect(id).toBe("a1");
        // **The pad's own values, not merely values of the right type.**
        // This asserted `typeof` only, and review proved that hollow: a
        // hardcoded `seq: 1` and a hardcoded `gesture: "fixed"` each left all
        // thirty-six tests green. The daemon discards a stale or duplicated
        // command by the compound (gesture, seq) pair, so a refactor breaking
        // this relay would silently defeat that on a live gimbal command with
        // nothing here able to notice. Compare against what the pad emitted.
        const padSlew = wrapper.findComponent(YonderAimPad).emitted("slew");
        expect(padSlew, "the pad must have emitted for this to mean anything").toBeTruthy();
        const fromPad = padSlew!.at(-1)![0] as { seq: number; gesture: string };
        expect(fromPad.seq, "the pad's counter must have moved for this to discriminate").toBeGreaterThan(1);
        expect(msg.payload.slew.seq).toBe(fromPad.seq);
        expect(msg.payload.slew.gesture).toBe(fromPad.gesture);
        expect(typeof msg.payload.slew.pan).toBe("number");
        expect(typeof msg.payload.slew.tilt).toBe("number");
    });

    it("relays stop with gesture and no seq — the pad's own design, not this panel's own deck-style enrichment", () => {
        const { wrapper, emit } = mountAim(makeReport());
        press(dial(wrapper), 20, 0);
        release(dial(wrapper));
        expect(stopCalls(emit)).toHaveLength(1);
        const msg = stopCalls(emit)[0]![2];
        expect(msg.payload.stop).toHaveProperty("gesture");
        expect(msg.payload.stop).not.toHaveProperty("seq");
        expect(msg.payload.stop).not.toHaveProperty("pan");
        expect(msg.payload.stop).not.toHaveProperty("tilt");
    });

    it("every one of slew, stop, mode and recentre is posted as widget-action for this node's own id", async () => {
        const { wrapper, emit } = mountAim(makeReport());
        press(dial(wrapper), 20, 0);
        release(dial(wrapper));
        const fpvBtn = wrapper.findAll(".y-seg__opt").find((b) => b.text() === "FPV")!;
        await fpvBtn.trigger("click");
        await recentreBtn(wrapper).trigger("click");

        expect(emit.mock.calls.length).toBeGreaterThanOrEqual(4);
        for (const call of emit.mock.calls) {
            expect(call[0]).toBe("widget-action");
            expect(call[1]).toBe("a1");
        }
        const keys = new Set(emit.mock.calls.map((c) => Object.keys(c[2].payload)[0]));
        expect(keys).toEqual(new Set(["slew", "stop", "mode", "recentre"]));
    });

describe("an inhibition is not a fault, on every control that shows one", () => {
    it("draws the mode control gated, never in the caution tone", () => {
        // Review found this reading `advertised` — which in this codebase
        // means a fault, drawn in caution — while the panel and the pad drew
        // the same inhibition neutral. Two severity signals for one condition
        // on one screen. R-UI-21: drawing a gate in caution tells an operator
        // something is broken when nothing is.
        //
        // It had no test at all: swapping the state left all thirty-six green.
        const w = mountAim(makeReport({ inhibited: "gimbal not responding" })).wrapper;
        const seg = w.findComponent(YonderSegmented);
        expect(seg.props("state"), "an inhibition is a gate, not a fault").toBe("gated");
    });
});
});
