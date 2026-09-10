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
    camera?: string;
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
    const element = w.find(".y-aim__dial").element;
    element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 132, height: 132 }) as DOMRect;
    return element;
}
function recentreBtn(w: VueWrapper<any>) {
    return w.find(".y-aimpanel__recentre");
}
function rateValue(w: VueWrapper<any>) {
    return w.find(".y-aimpanel__rate-v");
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
        // absence would prove nothing about precedence. The *sentence*,
        // naming which mode is actually active, is what discriminates.
        const { wrapper } = mountAimWithStore(
            makeReport({ mode: "FPV" }),
            makeReport({ mode: "Tilt lock" }),
        );
        expect(wrapper.findComponent({ name: "YonderSegmented" }).props("value")).toBe("FPV");
        expect(wrapper.findComponent({ name: "YonderSegmented" }).props("value")).not.toBe("Tilt lock");
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
        expect(wrapper.findComponent({ name: "YonderSegmented" }).props("value")).toBe("Tilt lock");
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

    it("keeps observed position readable when the joint scale is unknown", () => {
        const { wrapper } = mountAim(makeReport({
            bounds: null, inhibited: "position has not been established yet",
        }));
        expect(wrapper.findAll('.y-aimpanel__position dd').map(item => item.text())).toEqual(['12.4°', '-6.0°']);
        expect(wrapper.find('.y-pg').exists()).toBe(false);
        expect(wrapper.text()).toContain("position has not been established yet");
    });

    it("bounds being null is a fact about reporting, independent of aimState — the pad and Recentre stay live", () => {
        // Proves the two facts are wired from two different payload fields,
        // not one flag doing both jobs: present with no bounds yet still
        // lets the operator slew and Recentre; only the two readings go dead.
        const { wrapper } = mountAim(makeReport({ bounds: null, inhibited: null }));
        expect(recentreBtn(wrapper).attributes("disabled")).toBeUndefined();
        expect(wrapper.find(".y-pg__ptr").exists()).toBe(false);
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

describe("the mode sentence", () => {
    it("states the current mode as a full sentence", () => {
        const { wrapper } = mountAim(makeReport({ mode: "Tilt lock" }));
        expect(wrapper.findComponent({ name: "YonderSegmented" }).props("value")).toBe("Tilt lock");
    });

    it("draws nothing where the sentence would be when no mode is reported", () => {
        const { wrapper } = mountAim(makeReport({ mode: "" }));
        expect(wrapper.find(".y-aimpanel__modeline").exists()).toBe(false);
    });

    it("the sentence stays even when there is no selectable control beneath it", () => {
        // modes: [] hides YonderSegmented's own control entirely (its own
        // "not-offered draws nothing" rule) but the current mode is still a
        // reading, not a control, and states it regardless.
        const { wrapper } = mountAim(makeReport({ mode: "Follow", modes: [] }));
        expect(wrapper.find(".y-seg").exists()).toBe(false);
        expect(wrapper.text()).toContain("Gimbal mode: Follow.");
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
        expect(wrapper.find(".y-pg__ptr").exists()).toBe(false);
        expect(wrapper.find(".y-aimpanel__position").exists()).toBe(true);
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
        expect(wrapper.find(".y-aim__reason").exists()).toBe(false);
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

describe("not-offered: no Aim drawer", () => {
    it("keeps an absent layout marker, but draws neither an Aim panel nor its handle", () => {
        const { wrapper } = mountAim(makeReport({ state: "not-offered" }));
        expect(wrapper.attributes("data-aim-state")).toBe("absent");
        expect(wrapper.find(".y-aimpanel__handle").exists()).toBe(false);
        expect(wrapper.find(".y-aimpanel__drawer").exists()).toBe(false);
        expect(wrapper.find(".y-aim__dial").exists()).toBe(false);
        expect(wrapper.find(".y-pg").exists()).toBe(false);
        expect(wrapper.find(".y-aimpanel__recentre").exists()).toBe(false);
        expect(wrapper.find(".y-col").exists()).toBe(false);
    });
});

describe("the collapsible Aim drawer", () => {
    it("keeps capable but inoperative cameras reachable through the touch-sized Aim handle", () => {
        const { wrapper } = mountAim(makeReport({ state: "advertised", reason: "no motor" }));
        const handle = wrapper.find(".y-aimpanel__handle");
        expect(wrapper.attributes("data-aim-state")).toBe("open");
        expect(handle.exists()).toBe(true);
        expect(handle.attributes("aria-expanded")).toBe("true");
        expect(handle.element).toHaveProperty("tagName", "BUTTON");
        expect(wrapper.find(".y-aimpanel__drawer").exists()).toBe(true);
    });

    it("closes without unmounting the controls, stops an active slew, and persists the choice for that camera", async () => {
        const cameraKey = "drawer-camera-17";
        window.localStorage.removeItem(`yonder.aim.drawer.${cameraKey}`);
        const { wrapper, emit } = mountAim(makeReport(), "a1");
        await wrapper.setProps({ cameraKey });
        const el = dial(wrapper);
        press(el, 0, 0); drag(el, 40, 0);
        expect(slewCalls(emit).length).toBeGreaterThan(0);

        await wrapper.find(".y-aimpanel__handle").trigger("click");
        expect(wrapper.attributes("data-aim-state")).toBe("closed");
        expect(wrapper.find(".y-aimpanel__handle").attributes("aria-expanded")).toBe("false");
        expect(wrapper.find(".y-aimpanel__drawer").exists()).toBe(true);
        expect(stopCalls(emit)).toHaveLength(1);
        expect(window.localStorage.getItem(`yonder.aim.drawer.${cameraKey}`)).toBe("closed");

        const before = slewCalls(emit).length;
        drag(el, 40, 0);
        expect(slewCalls(emit)).toHaveLength(before);
        wrapper.unmount();

        const restored = mountAim(makeReport(), "a2").wrapper;
        await restored.setProps({ cameraKey });
        expect(restored.attributes("data-aim-state")).toBe("closed");
        restored.unmount();
        window.localStorage.removeItem(`yonder.aim.drawer.${cameraKey}`);
    });

    it("uses the report's actual camera identity when selection switches between cameras", async () => {
        const first = "usb:1-2.4";
        const second = "rtsp:thermal-01";
        window.localStorage.removeItem(`yonder.aim.drawer.${encodeURIComponent(first)}`);
        window.localStorage.removeItem(`yonder.aim.drawer.${encodeURIComponent(second)}`);
        const { wrapper } = mountAim(makeReport({ camera: first }));

        await wrapper.find(".y-aimpanel__handle").trigger("click");
        expect(wrapper.attributes("data-aim-state")).toBe("closed");
        expect(window.localStorage.getItem(`yonder.aim.drawer.${encodeURIComponent(first)}`)).toBe("closed");

        await wrapper.setProps({ props: { report: makeReport({ camera: second }) } });
        expect(wrapper.attributes("data-aim-state")).toBe("open");
        await wrapper.find(".y-aimpanel__handle").trigger("click");
        expect(window.localStorage.getItem(`yonder.aim.drawer.${encodeURIComponent(second)}`)).toBe("closed");

        await wrapper.setProps({ props: { report: makeReport({ camera: first }) } });
        expect(wrapper.attributes("data-aim-state")).toBe("closed");
        wrapper.unmount();
        window.localStorage.removeItem(`yonder.aim.drawer.${encodeURIComponent(first)}`);
        window.localStorage.removeItem(`yonder.aim.drawer.${encodeURIComponent(second)}`);
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
    it("omits roll when the camera offers no roll control", () => {
        const { wrapper } = mountAim(makeReport());
        expect(wrapper.find(".y-aim__struck").exists()).toBe(false);
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


it('stops an active pad when selection retires the prior camera report', async () => {
    const { wrapper, emit } = mountAim(makeReport());
    const el = dial(wrapper);
    press(el, 0, 0); drag(el, 40, 0);
    expect(slewCalls(emit).length).toBeGreaterThan(0);
    await wrapper.setProps({ props: { report: { state: 'gated', reason: 'Waiting for the selected camera report.', inhibited: 'Waiting for the selected camera report.', url: null, generation: null, pan: null, tilt: null, bounds: null, mode: null, modes: [] } } });
    expect(emit.mock.calls.some(call => call[2]?.payload?.stop)).toBe(true);
    const count = slewCalls(emit).length;
    drag(el, 40, 0);
    expect(slewCalls(emit)).toHaveLength(count);
    expect(wrapper.text()).toContain('Waiting for the selected camera report.');
    wrapper.unmount();
});

it('labels the position reference explicitly without putting it over the video',()=>{
  const native=mountAim({...makeReport({bounds:null}),positionFrame:'handle'});
  expect(native.wrapper.get('.y-aimpanel__reported').text()).toBe('Position relative to handle');native.wrapper.unmount();
  const world=mountAim({...makeReport({bounds:null}),positionFrame:'world'});
  expect(world.wrapper.get('.y-aimpanel__reported').text()).toBe('Camera attitude in the world');world.wrapper.unmount();
});


it("states an inhibition once and explains unreported axes separately", () => {
    const report = { ...makeReport(), pan: null, tilt: null, inhibited: "No guarded camera transport." };
    const { wrapper } = mountAim(report);
    expect(wrapper.text().split(report.inhibited).length - 1).toBe(1);
    expect(wrapper.find('.y-aim__dial').classes()).toContain('is-inhibited');
    expect(wrapper.findAll('.y-pg__val').map(value => value.text())).toEqual(['—', '—']);
    expect(wrapper.findAll('.y-pg__reason').map(value => value.text())).toEqual([
        'Not reported by this camera.', 'Not reported by this camera.',
    ]);
});
