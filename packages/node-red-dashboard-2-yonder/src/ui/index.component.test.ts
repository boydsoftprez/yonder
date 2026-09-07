// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import YonderIndex from "./YonderIndex.vue";

/**
 * `task-24-brief.md`'s own Step 1 names eight behaviours in prose and gives
 * no bodies; the coordinator's resolutions in that same file specify the
 * behaviour and leave the assertions here, the same shape Tasks 19–23 each
 * used. Every mutation this file's own tests were checked against is named
 * in `task-24-report.md`, including the ones that stayed green.
 *
 * **R-CAM-12 is the point of this whole file, not one test in it.** A
 * rejection row that does not carry its own reason, and an empty found list
 * that renders as blank space, are the two failures the requirement exists
 * to prevent — both get a test that fails first, so the fix that makes it
 * pass is provably the fix and not a coincidence.
 */

/** A small, exhaustive `CameraCapabilities` fixture — mirrored here rather
 * than imported, the same choice `gallery/specimens.js`'s own module
 * comment makes and for the identical reason: `yonder-core/presentation`
 * exports the *types* and `summarise()` itself, never the four state
 * constructors, so a caller outside `yonder-core` builds the plain object
 * shape directly rather than reaching past the package boundary into
 * `video/capability.ts`'s own source. One `gated` and one `not-offered` key
 * are enough to prove `summarise()`'s real output reaches the page — the
 * other twenty-one are `present` only because `summarise()` has no `default:`
 * branch and throws on a key it cannot read at all. */
function makeCapabilities(overrides: Record<string, unknown> = {}) {
    const range = { min: 0, max: 100, step: 1, default: 0, current: 0, inactive: false };
    return {
        formats: { state: "present", value: [{ fourcc: "H264", width: 1920, height: 1080, rates: [30] }] },
        zoom: { state: "not-offered" },
        focus: { state: "not-offered" },
        exposure: {
            state: "gated",
            value: { ...range, inactive: true },
            by: { id: "autoExposure", label: "auto exposure" },
        },
        whiteBalance: { state: "present", value: range },
        brightness: { state: "present", value: range },
        contrast: { state: "present", value: range },
        rotation: { state: "not-offered" },
        aim: { state: "not-offered" },
        recording: { state: "not-offered" },
        stills: { state: "not-offered" },
        saturation: { state: "present", value: range },
        hue: { state: "present", value: range },
        autoWhiteBalance: { state: "present", value: range },
        gamma: { state: "present", value: range },
        gain: { state: "present", value: range },
        powerLineFrequency: { state: "present", value: range },
        sharpness: { state: "present", value: range },
        backlightCompensation: { state: "present", value: range },
        autoExposure: { state: "present", value: range },
        autoFocus: { state: "present", value: range },
        // R-CTL-05's mirror and flip. Present here for the reason the note
        // above gives for the other twenty-one — `summarise()` has no
        // `default:` and throws on a key it cannot read at all — not because
        // any recorded camera answers them.
        horizontalFlip: { state: "present", value: range },
        verticalFlip: { state: "present", value: range },
        ...overrides,
    };
}

interface CameraRow {
    id: string | null;
    name: string;
    bus: string;
    spec: string;
    /** R-CAM-05 in words, from `identityWords()` — see the row test below. */
    identity: string;
    state: string;
    tone: string;
    rate: number | null;
    /** The socket, which is what an adoption names (R-CAM-05). */
    device?: string;
    /** Null on a camera that answered nothing — see the absent-camera rows. */
    capabilities: ReturnType<typeof makeCapabilities> | null;
    /** Why this camera may not be taken out of the configuration, or null. */
    removal: string | null;
}
interface RejectedRow {
    device: string;
    reason: string;
}
interface IndexReport {
    cameras: CameraRow[];
    rejected: RejectedRow[];
}

/** Two found cameras, one streaming and one idle, and one rejected device —
 * the base every test narrows with its own overrides, the same idiom
 * `aim.component.test.ts`'s own `makeReport()` uses. */
function makeReport(overrides: Partial<IndexReport> = {}): IndexReport {
    return {
        cameras: [
            {
                id: "nose",
                name: "Nose",
                bus: "USB · UVC",
                spec: "1920×1080 · 30 fps · H.264 · hardware",
                identity: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0"
                    + " — an enumeration number; it may mean a different camera after a reboot",
                state: "Streaming",
                tone: "good",
                rate: 1.9,
                capabilities: makeCapabilities(),
                removal: null,
            },
            {
                id: "gimbal",
                name: "Gimbal",
                bus: "USB accessory",
                spec: "1280×720 · 30 fps · H.264 · re-encoded",
                identity: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index2"
                    + " — survives a reboot",
                state: "Idle",
                tone: "neutral",
                rate: null,
                capabilities: makeCapabilities({
                    aim: {
                        state: "advertised",
                        value: undefined,
                        reason: "this camera advertises pan and tilt but there is no motor behind either",
                    },
                }),
                removal: null,
            },
        ],
        rejected: [
            {
                device: "/dev/video2",
                reason: "Offers raw frames only — the fastest it will do at 1920×1080 is 5 fps.",
            },
        ],
        ...overrides,
    };
}

/** Mounts from `props.report` alone, against a mocked `$socket` — the same
 * harness `aim.component.test.ts`'s own `mountAim()` uses. */
function mountIndex(report: unknown, id = "i1") {
    const emit = vi.fn();
    const wrapper = mount(YonderIndex, {
        props: { id, props: { report } },
        global: { provide: { $socket: { emit }, $dataTracker: () => {} } },
    });
    return { wrapper, emit };
}

/** The one place this file mounts against a live `$store` at all — see
 * "the live report" below. */
function mountIndexWithStore(live: unknown, configuredFallback: unknown = null, id = "i1") {
    const emit = vi.fn();
    const store = { state: { data: { messages: { [id]: { payload: live } } } } };
    const wrapper = mount(YonderIndex, {
        props: { id, props: { report: configuredFallback } },
        global: {
            provide: { $socket: { emit }, $dataTracker: () => {} },
            mixins: [{ computed: { $store: () => store } }],
        },
    });
    return { wrapper, emit };
}

function camRows(w: VueWrapper<any>) {
    return w.findAll(".y-idx__cam");
}
function rejRows(w: VueWrapper<any>) {
    return w.findAll(".y-idx__rej");
}

describe("a found camera's row", () => {
    it("carries the name and the bus", () => {
        const { wrapper } = mountIndex(makeReport());
        const nose = camRows(wrapper)[0]!;
        expect(nose.find(".y-idx__nm b").text()).toBe("Nose");
        expect(nose.find(".y-idx__nm span").text()).toBe("USB · UVC");
    });

    /**
     * **R-CAM-05's sentence, on the page rather than only in the payload.**
     *
     * `cameraIndex()` composes `identity` on every row and `identityWords()`
     * is where the wording lives — and for one commit nothing rendered it,
     * which is precisely the state the requirement was written against: the
     * stable-identity work stops at the type and an operator never learns
     * whether the camera they configured will still be the one that name
     * means after a reboot.
     */
    it("carries the identity sentence, which is the only form R-CAM-05 has", () => {
        const { wrapper } = mountIndex(makeReport());
        expect(camRows(wrapper)[0]!.find(".y-idx__id").text())
            .toBe(makeReport().cameras[0]!.identity);
    });

    it("carries the spec", () => {
        const { wrapper } = mountIndex(makeReport());
        expect(camRows(wrapper)[0]!.find(".y-idx__a").text()).toBe("1920×1080 · 30 fps · H.264 · hardware");
    });

    it("carries the probe summary, from summarise() and not a second sentence", () => {
        // Real output, not a stub: a `gated` key reads "the control that has
        // charge of it" in the operator's own words, and a `not-offered` key
        // reads "none" — both are `summarise()`'s own literal wording
        // (`video/capability.ts`), never composed again here.
        const { wrapper } = mountIndex(makeReport());
        const summary = camRows(wrapper)[0]!.find(".y-idx__b").text();
        expect(summary).toContain("exposure: auto exposure has it");
        expect(summary).toContain("zoom: none");
        expect(summary).toContain("formats: 1");
    });

    it("carries the annunciator badge, in the tone its own row names", () => {
        const { wrapper } = mountIndex(makeReport());
        const [nose, gimbal] = camRows(wrapper);
        const noseBadge = nose!.find(".y-idx__ann");
        expect(noseBadge.text()).toBe("Streaming");
        expect(noseBadge.classes()).toContain("tone-good");
        const gimbalBadge = gimbal!.find(".y-idx__ann");
        expect(gimbalBadge.text()).toBe("Idle");
        expect(gimbalBadge.classes()).toContain("tone-neutral");
    });

    it("falls back to the neutral tone for a tone keyword it does not recognise", () => {
        // The same "a lookup, not a ternary" guarantee `YonderColumn` states
        // for its own `tone` prop: an unrecognised keyword must never be
        // read as a raw colour, and must never crash the row either.
        const report = makeReport();
        report.cameras[0]!.tone = "urgent";
        const { wrapper } = mountIndex(report);
        const badge = camRows(wrapper)[0]!.find(".y-idx__ann");
        expect(badge.classes().some((c) => c.startsWith("tone-"))).toBe(false);
    });

    it("carries a rate in Mb/s, never uppercased", () => {
        const { wrapper } = mountIndex(makeReport());
        const rateEl = camRows(wrapper)[0]!.find(".y-ro__v");
        expect(rateEl.text()).toBe("1.9 Mb/s");
        // Proves the reused part's own fix travels with it end to end,
        // rather than trusting that composing the component implies it.
        expect(getComputedStyle(rateEl.find(".y-ro__u").element).textTransform).toBe("none");
    });

    it("reads a missing rate as none, not a blank gap — the idle camera carries no measurement", () => {
        const { wrapper } = mountIndex(makeReport());
        const gimbalRate = camRows(wrapper)[1]!.find(".y-ro__v");
        expect(gimbalRate.text()).toBe("none");
        expect(gimbalRate.classes()).toContain("is-absent");
    });

    it("pressing the row's key emits { camera: id } — the id, never the row's index", () => {
        const { wrapper, emit } = mountIndex(makeReport());
        camRows(wrapper)[1]!.find(".y-idx__open").trigger("click"); // row 1, id "gimbal"
        expect(emit).toHaveBeenCalledTimes(1);
        const [event, id, msg] = emit.mock.calls[0]!;
        expect(event).toBe("widget-action");
        expect(id).toBe("i1");
        expect(msg).toEqual({ payload: { camera: "gimbal" } });
    });

    /**
     * **R-UI-10: the row is a row, and the key is the key.**
     *
     * Every row used to *be* the button, which made each one an action 934 px
     * wide inside a 966 px page — the capture gate measures that in the DOM
     * and reported it on both palettes. Pressing the row body must therefore
     * do nothing, and that has to be asserted rather than assumed: a `@click`
     * left on the container would restore the old behaviour with the new
     * markup and every other test here would still pass.
     */
    it("does not act on a press anywhere but that key", () => {
        const { wrapper, emit } = mountIndex(makeReport());
        camRows(wrapper)[1]!.trigger("click");
        camRows(wrapper)[1]!.find(".y-idx__nm").trigger("click");
        expect(emit).not.toHaveBeenCalled();
    });

    /**
     * R-UI-03: a camera detected on a socket nothing is configured for has no
     * page to open. The key stays — an absent one reads as a page that failed
     * to draw it — and is inert, guarded in both places for the reason
     * `YonderShutter` gives: a dispatched click reaches a disabled button's
     * listener in a real browser even though `.click()` does not.
     */
    /**
     * **This used to assert a dead end, and the dead end was the defect.**
     *
     * The key was inert because a camera with no id has no page to open, which
     * is true and still is. What was missing was anything else to press. The
     * operator plugged a second camera into a running board, saw the row, saw
     * the greyed key, and had nowhere to go. So the row now carries a key that
     * *configures* it rather than one that does nothing, and OPEN is not drawn
     * at all until there is a page to open.
     */
    it("offers a key that configures a camera nothing is configured for, never a dead one", async () => {
        const report = makeReport();
        report.cameras[0]!.id = null;
        report.cameras[0]!.device = "platform-usb-0:1.1:1.0-video-index0";
        const { wrapper, emit } = mountIndex(report);
        const row = camRows(wrapper)[0]!;
        expect(row.find(".y-idx__adopt").exists(), "there is something to press").toBe(true);
        expect(row.find(".y-idx__adopt").attributes("disabled"), "and it is live").toBeUndefined();
        await row.find(".y-idx__adopt").trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0]![2]).toEqual({ payload: { adopt: report.cameras[0]!.device } });
    });
});

describe("a rejected device's row", () => {
    it("carries the device and the reason", () => {
        const { wrapper } = mountIndex(makeReport());
        const row = rejRows(wrapper)[0]!;
        expect(row.find(".y-idx__dev").text()).toBe("/dev/video2");
        expect(row.find(".y-idx__why").text()).toBe(
            "Offers raw frames only — the fastest it will do at 1920×1080 is 5 fps.",
        );
    });

    it("is never drawn without its reason visible in the same row", () => {
        // R-CAM-12's own failure mode, stated as a test: a rejection that
        // does not carry why is indistinguishable from a camera silently
        // dropped, which is exactly what this requirement exists to forbid.
        const { wrapper } = mountIndex(makeReport());
        const row = rejRows(wrapper)[0]!;
        expect(row.text().length).toBeGreaterThan(row.find(".y-idx__dev").text().length);
    });

    it("draws no rejected group at all when nothing was rejected", () => {
        const { wrapper } = mountIndex(makeReport({ rejected: [] }));
        expect(wrapper.text()).not.toContain("Seen, and not usable");
        expect(rejRows(wrapper)).toHaveLength(0);
    });

    it("does not press — a rejected device has no page to open", () => {
        const { wrapper, emit } = mountIndex(makeReport());
        rejRows(wrapper)[0]!.trigger("click");
        expect(emit).not.toHaveBeenCalled();
    });
});

describe("no camera", () => {
    it("draws \"No camera.\" rather than an empty pane when the found list is empty", () => {
        const { wrapper } = mountIndex(makeReport({ cameras: [] }));
        expect(wrapper.text()).toContain("No camera");
        expect(camRows(wrapper)).toHaveLength(0);
    });

    it("draws the identical sentence when there is no report at all yet", () => {
        // Collapsed deliberately (this component's own doc comment): an
        // operator still sees a concrete, drawn sentence either way, rather
        // than blank space that could as easily mean the page failed.
        const { wrapper } = mountIndex(undefined);
        expect(wrapper.text()).toContain("No camera");
    });

    it("still draws the rejected list when the found list is empty — the falling-off-the-bus case", () => {
        const { wrapper } = mountIndex(makeReport({ cameras: [] }));
        expect(wrapper.text()).toContain("No camera");
        expect(rejRows(wrapper)).toHaveLength(1);
    });
});

describe("the live report wins over the configured fallback", () => {
    it("prefers $store's live message over props.report when both are present", () => {
        const live = makeReport();
        live.cameras[0]!.name = "Live Nose";
        const fallback = makeReport();
        fallback.cameras[0]!.name = "Configured Nose";
        const { wrapper } = mountIndexWithStore(live, fallback);
        expect(wrapper.text()).toContain("Live Nose");
        expect(wrapper.text()).not.toContain("Configured Nose");
    });

    it("falls back to the configured report when the store has no message yet", () => {
        const emit = vi.fn();
        const store = { state: { data: { messages: {} } } };
        const wrapper = mount(YonderIndex, {
            props: { id: "i1", props: { report: makeReport() } },
            global: {
                provide: { $socket: { emit }, $dataTracker: () => {} },
                mixins: [{ computed: { $store: () => store } }],
            },
        });
        expect(wrapper.text()).toContain("Nose");
    });
});

describe("the placard", () => {
    it("states the two counts the payload carries", () => {
        const { wrapper } = mountIndex(makeReport());
        expect(wrapper.find(".y-idx__summary").text()).toBe("2 found · 1 rejected");
    });

it("a camera sending nothing reads 0, not none", () => {
    // The falsy-zero bug, which this project has been burned by before and
    // which no fixture here could catch: both cameras carry a real rate, so
    // `cam.rate || null` — a genuine 0 collapsing to "none" — passed every
    // test. Zero is a camera that is up and sending nothing; none is a camera
    // that reported no rate at all. An operator must be able to tell them
    // apart, which is the whole posture of this console.
    const { wrapper: w } = mountIndex(makeReport({
        cameras: [{ id: "cam-idle", name: "Idle", bus: "usb-1.2", spec: "1280×720",
                    summary: "", state: "Streaming", tone: "good", rate: 0 }],
    }));
    expect(w.text()).toContain("0");
    expect(w.text(), "0 Mb/s is a reading; none is the absence of one").not.toContain("none");
});
});

/**
 * **The dead end the operator found.**
 *
 * He plugged a second camera into a running board. The row appeared, marked
 * *Not configured*, its OPEN key disabled with a correct reason — a page for a
 * camera the configuration has never heard of answers 404 on every widget —
 * and nothing anywhere could give it an entry. No test could have caught it:
 * a review reads a diff, and nothing in a diff is missing.
 */
describe("a camera the board found and nothing is configured for", () => {
  /** The socket, which is what R-CAM-05 says survives a replug. */
  const SOCKET = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0-video-index0";

  function unconfiguredReport() {
    const report = makeReport();
    report.cameras[0]!.id = null;
    report.cameras[0]!.device = SOCKET;
    return report;
  }

  it("posts the socket, never the enumeration name, because that is what survives a replug", async () => {
    const { wrapper, emit } = mountIndex(unconfiguredReport());
    await camRows(wrapper)[0]!.find(".y-idx__adopt").trigger("click");
    const [event, id, msg] = emit.mock.calls[0]!;
    expect(event).toBe("widget-action");
    expect(id).toBe("i1");
    expect(msg).toEqual({ payload: { adopt: SOCKET } });
    // `/dev/video2` is this boot's answer and means nothing tomorrow.
    expect(JSON.stringify(msg)).not.toContain("/dev/video");
  });

  it("still opens a configured camera, and never offers to configure it twice", () => {
    const { wrapper } = mountIndex(makeReport());
    const row = camRows(wrapper)[0]!;
    expect(row.find(".y-idx__adopt").exists()).toBe(false);
    expect(row.find(".y-idx__open").exists()).toBe(true);
  });
});

/**
 * **A camera the configuration names and the board cannot find** (R-CAM-20,
 * R-CAM-21).
 *
 * The other half of the state the operator found a board in, minutes after
 * the adoption above shipped. A camera had been moved between USB ports;
 * identity is the socket (R-CAM-05), so each move made it a *different*
 * camera as far as the configuration was concerned and nothing ever removed
 * the old one. The board carried two configured cameras against ports with
 * nothing in them, the camera in his hand matched neither, and the page drew
 * no row at all for either — while the navigation, built from the same
 * configuration, carried both.
 */
describe("a camera the configuration names and the board did not find", () => {
    const EXPECTED = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0-video-index0";

    /** One absent row, as `cameraIndex()` composes it. */
    function absentReport() {
        return makeReport({
            cameras: [{
                id: "cam1",
                name: "Global Shutter Camera",
                bus: "usb · no device",
                spec: "H264 · 1280×720p30",
                identity: `${EXPECTED} — configured on this socket; nothing there answered`,
                state: "Not attached",
                tone: "bad",
                rate: null,
                device: EXPECTED,
                capabilities: null,
                removal: null,
            }],
        });
    }

    /**
     * **The socket it expects, drawn.** It is the one string an operator can
     * act on: move a plug back to it, or remove the entry that names it.
     */
    it("states which camera it is and which socket it wanted", () => {
        const { wrapper } = mountIndex(absentReport());
        const row = camRows(wrapper)[0]!;
        expect(row.find(".y-idx__nm b").text()).toBe("Global Shutter Camera");
        expect(row.find(".y-idx__id").text()).toContain(EXPECTED);
        expect(row.find(".y-idx__ann").text()).toBe("Not attached");
        expect(row.find(".y-idx__ann").classes()).toContain("tone-bad");
    });

    /**
     * **Nothing answered, so nothing was asked** (R-CAM-14, R-UI-20). A line
     * of `aim: none · zoom: none` would be twenty-one claims about a camera
     * this board cannot see, in the place an operator reads to find out what
     * a camera can do.
     */
    it("draws no probe summary for a camera that answered nothing", () => {
        const { wrapper } = mountIndex(absentReport());
        expect(camRows(wrapper)[0]!.find(".y-idx__b").text()).toBe("");
        // And a camera that *did* answer still gets its line, so this is not
        // the summary silently disappearing everywhere.
        const { wrapper: found } = mountIndex(makeReport());
        expect(camRows(found)[0]!.find(".y-idx__b").text()).toContain("aim:");
    });

    it("offers the key that takes it out of the configuration, and posts the id", async () => {
        const { wrapper, emit } = mountIndex(absentReport());
        const key = camRows(wrapper)[0]!.find(".y-idx__forget");
        expect(key.exists(), "there is something to press").toBe(true);
        expect(key.attributes("disabled"), "and it is live").toBeUndefined();
        await key.trigger("click");
        expect(emit).toHaveBeenCalledTimes(1);
        const [event, id, msg] = emit.mock.calls[0]!;
        expect(event).toBe("widget-action");
        expect(id).toBe("i1");
        // **The id, not the socket** — the opposite of an adoption, and for
        // the reason each is what it is: a camera that is not there cannot be
        // addressed by where it is not.
        expect(msg).toEqual({ payload: { forget: "cam1" } });
    });

    /**
     * **Removing a camera is not a way to stop it** (R-CAM-21). The reason is
     * on the key itself, because this page reads the camera list again after
     * every press: a refusal travelling back on the message is overwritten by
     * the next sweep before anything could draw it.
     */
    it("draws the key inoperative, carrying the reason, while the camera is streaming", async () => {
        const report = makeReport();
        report.cameras[0]!.removal = "this camera is streaming; stop it before taking it out of the configuration";
        const { wrapper, emit } = mountIndex(report);
        const key = camRows(wrapper)[0]!.find(".y-idx__forget");
        expect(key.attributes("disabled")).toBeDefined();
        expect(key.attributes("title")).toBe(report.cameras[0]!.removal);
        // Guarded twice, for the reason `YonderShutter` gives: a dispatched
        // click reaches a disabled button's listener in a real browser even
        // though `.click()` does not.
        await key.trigger("click");
        expect(emit).not.toHaveBeenCalled();
    });

    /** A socket nothing is configured for has no entry to remove. */
    it("offers no such key on a camera nothing is configured for", () => {
        const report = makeReport();
        report.cameras[0]!.id = null;
        report.cameras[0]!.device = EXPECTED;
        report.cameras[0]!.removal = "nothing is configured on this socket, so there is nothing to remove";
        const row = camRows(mountIndex(report).wrapper)[0]!;
        expect(row.find(".y-idx__forget").exists()).toBe(false);
        expect(row.find(".y-idx__adopt").exists()).toBe(true);
    });

    /**
     * **OPEN stays at the row's end, and the removal key never takes that
     * place.** OPEN is the key an operator presses without looking — it is
     * where the blueprint's chevron pointed. A key that takes a camera out of
     * the configuration must not be the one that catches a finger aimed at
     * the familiar spot.
     */
    it("puts the removal key inside OPEN, never at the end of the row", () => {
        const { wrapper } = mountIndex(makeReport());
        const keys = camRows(wrapper)[0]!.findAll(".y-idx__k");
        expect(keys).toHaveLength(2);
        expect(keys[0]!.classes()).toContain("y-idx__forget");
        expect(keys.at(-1)!.classes()).toContain("y-idx__open");
    });
});
