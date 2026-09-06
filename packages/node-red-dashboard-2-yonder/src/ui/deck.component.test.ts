// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import YonderDeck, { CAPABILITY_LAYOUT, appliedForDraft } from "./YonderDeck.vue";
import { CAPABILITY_KEYS } from "yonder-core/presentation";

/**
 * This is the task the whole plan was written for (task-22-brief.md,
 * Coordinator resolution 1): the shipped console applies a typed value the
 * moment focus leaves the field, on a page an operator reaches for while an
 * aircraft is flying. Every test below either proves that is fixed, or
 * proves the deck draws honestly from a report it did not compose.
 *
 * **Ten of the eleven test bodies here are mine — the coordinator specified
 * behaviour and left the assertions to be written, exactly as Tasks 19–21
 * did**, on the same evidence: a body dictated verbatim has twice carried a
 * mistake about JavaScript an implementer had to find, and what has held
 * across this whole plan is the *behaviour* the coordinator names, not a
 * guess at the code that proves it. Every mutation this file's own tests
 * were checked against is named in `task-22-report.md`, including the ones
 * that stayed green.
 *
 * **Two kinds of edit, and telling them apart is the whole point** (resolution
 * 2). An *image* control — `setControl()` — posts through `$socket.emit`
 * immediately. A *stream or preview policy* edit — `stage()` — lands in
 * `draftStore` and never calls `$socket.emit` at all; the guarantee is
 * structural, the same way `draft.ts`'s own module comment states it for
 * `set()` — there is no import of, and no parameter for, anything
 * socket-shaped inside `stage()`. A loose test that only asked "does editing
 * emit something" would pass an implementation that posted both, so every
 * test below that touches an edit names which of the two it expects and
 * checks the other did not happen.
 */

function present(value: unknown) {
  return { state: "present", value };
}
function notOffered() {
  return { state: "not-offered" };
}
function advertised(value: unknown, reason: string) {
  return { state: "advertised", value, reason };
}
function gated(value: unknown, by: { id: string; label: string }) {
  return { state: "gated", value, by };
}
function range(over: Record<string, unknown> = {}) {
  return { min: 0, max: 100, step: 1, default: 0, current: 0, inactive: false, ...over };
}

function noCapabilities(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) out[key] = notOffered();
  return out;
}

const BASE_STREAM_POLICY = { mode: "fixed", floor_kbps: 1000, ceiling_kbps: 6000, bitrate_kbps: 3000 };
const BASE_PREVIEW_POLICY = {
  mode: "adaptive", size: "auto", ladder_bottom: "640x360", ladder_top: "1280x720",
  floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
};

/** A full, honest report — everything not-offered, stream Fixed, preview
 * Adaptive — the base every test narrows with its own overrides. */
function makeReport(overrides: Record<string, unknown> = {}) {
  const {
    camera, capabilities, descriptors, values, commanded, policy, applied, outputs, captures, interruption,
    ...rest
  } = overrides as Record<string, any>;
  return {
    camera: { id: "elp", name: "Cam 1", spec: "USB · H.264 · 1280×720p30", ...(camera || {}) },
    capabilities: { ...noCapabilities(), ...(capabilities || {}) },
    descriptors: descriptors || {},
    values: values || {},
    commanded: commanded || {},
    policy: {
      stream: { ...BASE_STREAM_POLICY, ...((policy && policy.stream) || {}) },
      preview: { ...BASE_PREVIEW_POLICY, ...((policy && policy.preview) || {}) },
    },
    applied: {
      stream: { ...BASE_STREAM_POLICY, ...((applied && applied.stream) || {}) },
      preview: { ...BASE_PREVIEW_POLICY, ...((applied && applied.preview) || {}) },
    },
    outputs: outputs || [],
    captures: captures || { count: 0 },
    interruption: interruption || [],
    ...rest,
  };
}

/** A fresh `$store`, seeded with one deck's report at id `d1`. Mutable, so a
 * test can watch `state.yonder.draft` change and reuse it across a remount
 * (Task 21's own round trip: a page switch, in miniature). */
function makeStore(payload: unknown) {
  return { state: { data: { messages: { d1: { payload } } }, yonder: {} as Record<string, unknown> } };
}

function deck(store: ReturnType<typeof makeStore>, mode: "live" | "setup", emit = vi.fn()) {
  const wrapper = mount(YonderDeck, {
    props: { id: "d1", props: { mode } },
    global: {
      provide: { $socket: { emit }, $dataTracker: () => {} },
      mixins: [{ computed: { $store: () => store } }],
    },
  });
  return { wrapper, emit };
}

/** Find a mounted control by the exact text its own `__label` element
 * carries — every ported part in this library names its label element this
 * way (`.y-sb__label`, `.y-pick__label`, `.y-seg__label`), so one helper
 * covers all three kinds `drawCapability()` can draw. */
function controlByLabel(wrapper: VueWrapper<any>, rootClass: string, label: string) {
  const blocks = wrapper.findAll("." + rootClass);
  const match = blocks.find((b) => {
    const l = b.find("." + rootClass + "__label");
    return l.exists() && l.text() === label;
  });
  if (!match) throw new Error(`no .${rootClass} labelled "${label}" among ${blocks.length} found`);
  return match;
}
const barByLabel = (w: VueWrapper<any>, label: string) => controlByLabel(w, "y-sb", label);
const pickerByLabel = (w: VueWrapper<any>, label: string) => controlByLabel(w, "y-pick", label);
const segByLabel = (w: VueWrapper<any>, label: string) => controlByLabel(w, "y-seg", label);

function factLabels(wrapper: VueWrapper<any>): string[] {
  return wrapper.findAll(".y-deck__fact-l").map((el) => el.text());
}

function legends(wrapper: VueWrapper<any>): string[] {
  return wrapper.findAll(".y-col__legend").map((el) => el.text());
}

/** A real drag-free press: dispatched directly, the way `setbar.component
 * .test.ts` already found is the one form of a pointer event this project's
 * jsdom does not choke on (`PointerEvent`'s own constructor init dict). */
function press(el: Element, clientX: number) {
  el.dispatchEvent(new PointerEvent("pointerdown", { clientX, bubbles: true, cancelable: true }));
}

describe("CAPABILITY_LAYOUT", () => {
  it("has an entry for every real capability key, and only those", () => {
    // The reason CAPABILITY_KEYS itself is written down, applied a second
    // time: a capability capability.ts adds later has nowhere to render
    // until a person decides where, and this test is what makes that loud
    // rather than a page quietly missing a control.
    expect(Object.keys(CAPABILITY_LAYOUT).sort()).toEqual([...CAPABILITY_KEYS].sort());
  });
});

describe("appliedForDraft", () => {
  it("flattens values, dropping a null (no reading, nothing for an edit to match)", () => {
    const flat = appliedForDraft(makeReport({ values: { brightness: 20, gain: null, zoom: 3 } }));
    expect(flat).toMatchObject({ brightness: 20, zoom: 3 });
    expect(Object.prototype.hasOwnProperty.call(flat, "gain")).toBe(false);
  });

  it("flattens applied.stream to the blueprint's own UI-facing names and casing", () => {
    const flat = appliedForDraft(makeReport({
      applied: { stream: { mode: "adaptive", floor_kbps: 1200, ceiling_kbps: 5000, bitrate_kbps: 3300 } },
    }));
    expect(flat).toMatchObject({
      streamMode: "Adaptive", streamFloor: 1200, streamCeiling: 5000, streamBitrate: 3300,
    });
  });

  it("flattens applied.preview the same way, mode included", () => {
    const flat = appliedForDraft(makeReport({
      applied: {
        preview: {
          mode: "fixed", size: "1280x720", ladder_bottom: "640x360", ladder_top: "854x480",
          floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 410, framerate: 30,
        },
      },
    }));
    expect(flat).toMatchObject({
      previewMode: "Fixed", previewSize: "1280x720", previewLadderBottom: "640x360",
      previewLadderTop: "854x480", previewFloor: 300, previewCeiling: 2000,
      previewBitrate: 410, previewRate: 30,
    });
  });

  it("carries the camera's own name, for the name draft path", () => {
    expect(appliedForDraft(makeReport({ camera: { name: "Nose" } }))).toMatchObject({ name: "Nose" });
  });
});

it("draws a control for present, a fact for not-offered, the marked control for advertised and gated", () => {
  const report = makeReport({
    capabilities: {
      brightness: present(range({ min: -64, max: 64, step: 1, current: 20, default: 0 })),
      zoom: notOffered(),
      exposure: advertised(range({ current: 156 }), "accepted, does not reshape the feed"),
      focus: gated(range({ current: 300 }), { id: "autoFocus", label: "auto focus" }),
    },
    descriptors: {
      brightness: { label: "Brightness", unit: "", min: -64, max: 64, step: 1, current: 20, default: 0 },
      exposure: { label: "Shutter", unit: "µs", min: 100, max: 1000000, step: 100, current: 15600, default: 1000 },
      focus: { label: "Focus", unit: "", min: 0, max: 1023, step: 1, current: 300, default: 0 },
    },
    values: { brightness: 20, exposure: 15600, focus: 300 },
  });
  const { wrapper } = deck(makeStore(report), "live");

  // present: a working control, no reason shown.
  const brightnessBar = barByLabel(wrapper, "Brightness");
  expect(brightnessBar.classes()).toContain("is-present");
  expect(brightnessBar.find(".y-sb__why").exists()).toBe(false);

  // not-offered: a fact, and no bar for it anywhere.
  expect(factLabels(wrapper)).toContain("Zoom");
  expect(wrapper.findAll(".y-sb").some((b) => b.find(".y-sb__label").text() === "Zoom")).toBe(false);

  // advertised: a fault — the control stays, disabled, carrying the reason.
  const exposureBar = barByLabel(wrapper, "Shutter");
  expect(exposureBar.classes()).toContain("is-advertised");
  expect(exposureBar.find(".y-sb__why").text()).toBe("accepted, does not reshape the feed");

  // gated: not a fault — disabled, naming the control that has it, never the
  // V4L2 name — matching capability.ts's own summarise() wording.
  const focusBar = barByLabel(wrapper, "Focus");
  expect(focusBar.classes()).toContain("is-gated");
  expect(focusBar.find(".y-sb__why").text()).toBe("auto focus has it");
});

it("omits a whole group when the camera has none of it", () => {
  const report = makeReport({
    capabilities: {
      // Colour's whole group (brightness, contrast, saturation, hue): none.
      // Optics keeps one present control, so the omission is provably
      // specific to Colour and not every group failing to draw at all.
      zoom: present(range({ current: 5, min: 0, max: 60 })),
    },
    descriptors: { zoom: { label: "Zoom", unit: "", min: 0, max: 60, step: 1, current: 5, default: 0 } },
    values: { zoom: 5 },
  });
  const { wrapper } = deck(makeStore(report), "live");

  expect(legends(wrapper)).not.toContain("Colour");
  expect(legends(wrapper)).toContain("Optics");
  // Not merely empty — R-UI-20's own distinction, and YonderColumn's: an
  // empty box and an absent one say different things.
  expect(wrapper.html()).not.toContain(">Colour<");
});

it("uses the descriptor's units: raw 156 draws as 15600 µs", () => {
  // video/descriptors.ts's own worked example: exposure is raw x100 µs.
  const report = makeReport({
    capabilities: { exposure: present(range({ min: 1, max: 10000, step: 1, current: 156, default: 100 })) },
    descriptors: {
      exposure: { label: "Shutter", unit: "µs", min: 100, max: 1000000, step: 100, current: 15600, default: 10000 },
    },
    values: { exposure: 15600 },
  });
  const { wrapper } = deck(makeStore(report), "live");
  const bar = barByLabel(wrapper, "Shutter");
  expect(bar.find(".y-sb__val").text()).toBe("15600 µs");
  expect(bar.find(".y-sb__u").text()).toBe("µs");
});

it("offers only the menu ids the probe listed", () => {
  // The bench's own auto_exposure: min=0 max=3, but only ids 1 and 3 are
  // real entries (R-CAM-14) — expanding the range would put two modes on
  // the page this camera does not have.
  const report = makeReport({
    capabilities: {
      autoExposure: present(range({
        min: 0, max: 3, step: 1, default: 3, current: 1,
        menu: [{ id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" }],
      })),
    },
    descriptors: {
      autoExposure: { label: "Auto exposure", unit: "", min: 0, max: 3, step: 1, current: 1, default: 3 },
    },
    values: { autoExposure: 1 },
  });
  const { wrapper } = deck(makeStore(report), "live");
  const picker = pickerByLabel(wrapper, "Auto exposure");
  const options = picker.findAll("option");
  expect(options).toHaveLength(2);
  expect(options.map((o) => o.attributes("value"))).toEqual(["1", "3"]);
  expect(options.map((o) => o.text())).toEqual(["Manual Mode", "Aperture Priority Mode"]);
});

it("draws every control on Live, and the four bench-only ones only on Setup", () => {
  const report = makeReport({
    capabilities: {
      brightness: present(range({ current: 10 })),
      gain: present(range({ current: 5, min: 0, max: 1023 })),
      backlightCompensation: present(range({ current: 40, min: 0, max: 160 })),
      sharpness: present(range({ current: 2, min: 0, max: 7 })),
      powerLineFrequency: present(range({
        current: 1, min: 0, max: 3,
        menu: [{ id: 0, label: "Disabled" }, { id: 1, label: "50 Hz" }, { id: 2, label: "60 Hz" }],
      })),
    },
    descriptors: {
      brightness: { label: "Brightness", unit: "", min: -64, max: 64, step: 1, current: 10, default: 0 },
      gain: { label: "Gain", unit: "", min: 0, max: 1023, step: 1, current: 5, default: 0 },
      backlightCompensation: { label: "Backlight compensation", unit: "", min: 0, max: 160, step: 1, current: 40, default: 0 },
      sharpness: { label: "Sharpness", unit: "", min: 0, max: 7, step: 1, current: 2, default: 0 },
      powerLineFrequency: { label: "Mains frequency", unit: "", min: 0, max: 3, step: 1, current: 1, default: 0 },
    },
    values: { brightness: 10, gain: 5, backlightCompensation: 40, sharpness: 2, powerLineFrequency: 1 },
  });
  const HOUSEKEEPING = ["Gain", "Backlight compensation", "Sharpness", "Mains frequency"];

  const live = deck(makeStore(report), "live").wrapper;
  expect(legends(live)).not.toContain("Housekeeping");
  for (const label of HOUSEKEEPING) {
    expect(live.html(), `${label} must not draw on Live`).not.toContain(">" + label + "<");
  }
  // Every control, not only the withheld four: Brightness is ordinary and
  // must draw on both pages.
  expect(barByLabel(live, "Brightness").exists()).toBe(true);

  const setup = deck(makeStore(report), "setup").wrapper;
  expect(legends(setup)).toContain("Housekeeping");
  expect(barByLabel(setup, "Gain").exists()).toBe(true);
  expect(barByLabel(setup, "Backlight compensation").exists()).toBe(true);
  expect(barByLabel(setup, "Sharpness").exists()).toBe(true);
  expect(pickerByLabel(setup, "Mains frequency").exists()).toBe(true);
  expect(barByLabel(setup, "Brightness").exists()).toBe(true);
});

it("an image control posts on press through the socket", () => {
  // emitsActions is load-bearing: Dashboard drops a widget-action from a
  // widget that never registered onAction, silently, with no error
  // anywhere (widget.ts's own note) — see deck.ts's own registration for
  // where that flag actually lives; this only proves the client side of it.
  const report = makeReport({
    capabilities: { brightness: present(range({ min: -64, max: 64, step: 1, current: 0, default: 0 })) },
    descriptors: { brightness: { label: "Brightness", unit: "", min: -64, max: 64, step: 1, current: 0, default: 0 } },
    values: { brightness: 0 },
  });
  const { wrapper, emit } = deck(makeStore(report), "live");
  const track = barByLabel(wrapper, "Brightness").find(".y-sb__trk");
  press(track.element, 110); // roughly the midpoint of -64..64

  expect(emit).toHaveBeenCalledTimes(1);
  const [event, id, msg] = emit.mock.calls[0]!;
  expect(event).toBe("widget-action");
  expect(id).toBe("d1");
  expect(msg.payload.control).toBe("brightness");
  expect(typeof msg.payload.value).toBe("number");
});

it("a stream edit goes to the draft and never to the socket", () => {
  const report = makeReport();
  const { wrapper, emit } = deck(makeStore(report), "live");
  const seg = segByLabel(wrapper, "Bitrate"); // Stream's own Bitrate segmented (Fixed/Adaptive)
  const adaptiveBtn = seg.findAll("button").find((b) => b.text() === "Adaptive")!;
  adaptiveBtn.trigger("click");

  expect(emit).not.toHaveBeenCalled();
  // The edit really was recorded — proven against the store, not merely
  // "nothing happened".
  expect((wrapper.vm as any).draftStore.get("elp")).toEqual({ streamMode: "Adaptive" });
});

it("tabbing out of a preview picker posts nothing", () => {
  // defect 1: on the shipped console this is exactly where a value reached
  // the aircraft the moment focus left the field. A real blur, dispatched
  // directly — not a call to a method this component happens to expose.
  const report = makeReport();
  const { wrapper, emit } = deck(makeStore(report), "live");
  const select = pickerByLabel(wrapper, "Size").find("select");
  select.setValue("1280x720");
  expect(emit, "changing the value must not post either").not.toHaveBeenCalled();

  select.element.dispatchEvent(new Event("blur", { bubbles: true, cancelable: true }));

  expect(emit, "a real blur must post nothing").not.toHaveBeenCalled();
  expect((wrapper.vm as any).draftStore.get("elp")).toMatchObject({ previewSize: "1280x720" });
});

it("Apply posts the whole draft once; Discard clears it and posts nothing", async () => {
  const report = makeReport();
  const store = makeStore(report);

  // Apply.
  {
    const { wrapper, emit } = deck(store, "setup");
    const seg = segByLabel(wrapper, "Bitrate"); // Stream's Bitrate seg is the first "Bitrate" on Setup
    await seg.findAll("button").find((b) => b.text() === "Adaptive")!.trigger("click");
    expect(emit).not.toHaveBeenCalled();

    const applyBtn = wrapper.findAll(".y-deck__key").find((b) => b.text() === "Apply")!;
    await applyBtn.trigger("click");

    expect(emit).toHaveBeenCalledTimes(1);
    const [, , msg] = emit.mock.calls[0]!;
    expect(msg.payload.apply).toEqual({ streamMode: "Adaptive" });
    // **Kept, not cleared.** The daemon has not answered yet, and it may
    // refuse: `POST /cameras/:id/apply` returns `problems` by path precisely
    // so the page can mark the field, and a browser that has already dropped
    // the draft has nothing left to mark. Nothing needs to clear it —
    // `pending()` filters at read time, so a successful apply empties the
    // block on its own when the re-read lands.
    expect((wrapper.vm as any).draftStore.get("elp")).toEqual({ streamMode: "Adaptive" });
  }

  // Discard, on a fresh store so the previous Apply's own clear cannot be
  // mistaken for this one's.
  {
    const store2 = makeStore(report);
    const { wrapper, emit } = deck(store2, "setup");
    const seg = segByLabel(wrapper, "Bitrate");
    await seg.findAll("button").find((b) => b.text() === "Adaptive")!.trigger("click");
    expect(emit).not.toHaveBeenCalled();

    const discardBtn = wrapper.findAll(".y-deck__key").find((b) => b.text() === "Discard")!;
    await discardBtn.trigger("click");

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![2]).toEqual({ payload: { discard: true } });
    expect((wrapper.vm as any).draftStore.get("elp")).toEqual({});
  }
});

/**
 * **Computed here, from this deck's own draft.**
 *
 * This test used to hand the component `interruption: ["restarts the
 * pipeline"]` on its report — a value the daemon composes as `[]` and can
 * only ever compose as `[]`, because the interruption a draft would cause is
 * a fact about a draft that has not been sent. So it passed while the warning
 * spec §8.1 asks for could never appear on a real page. It now stages a real
 * edit and expects the sentence `interruption()` itself returns for it:
 * changing the preview's held size is the preview branch and nothing else.
 */
it("works out what a staged edit would interrupt, and says so before Apply", async () => {
  const { wrapper } = deck(makeStore(makeReport()), "setup");

  const size = pickerByLabel(wrapper, "Size");
  await size.find("select").setValue("854x480");

  expect(wrapper.find(".y-deck__pending-h").text()).toContain("1");
  expect(wrapper.text()).toContain("preview branch only");
  // Visible ahead of the Apply key, not merely present somewhere on the page.
  const html = wrapper.html();
  expect(html.indexOf("y-deck__pending")).toBeLessThan(html.indexOf("y-deck__rail"));
});

/** And silent when nothing staged would interrupt anything — a warning that
 * is always on is a warning nobody reads. */
it("says nothing about an interruption for an edit that causes none", async () => {
  const { wrapper } = deck(makeStore(makeReport()), "setup");
  await segByLabel(wrapper, "Bitrate").findAll("button")
    .find((b) => b.text() === "Adaptive")!.trigger("click");
  expect(wrapper.find(".y-deck__pending-h").text()).toContain("1");
  expect(wrapper.find(".y-deck__interrupt").exists()).toBe(false);
});

/**
 * **A refused apply keeps every edit and marks the field.**
 *
 * The route answers `problems` keyed by *schema* path; the deck knows its own
 * flat names. `draftPathFor()` is the reverse of that seam, and this asserts
 * the message lands on the row it belongs to rather than merely appearing
 * somewhere on the page.
 */
it("puts a refusal's problem beside the staged edit it is about", async () => {
  const { wrapper } = deck(makeStore(makeReport({
    problems: [{ path: "preview.floor_kbps", message: "the floor is above the ceiling" }],
  })), "setup");

  // The *preview* Floor, not the stream's: both decks draw one and the
  // problem names `preview.floor_kbps`.
  const floor = wrapper.findAll(".y-sb").filter((b) => b.find(".y-sb__label").text() === "Floor").at(-1)!;
  press(floor.find(".y-sb__trk").element, 40);
  await wrapper.vm.$nextTick();

  const row = wrapper.findAll(".y-deck__pending-row")
    .find((r) => r.find(".y-deck__pending-path").text() === "previewFloor");
  expect(row, "the staged edit must still be there to mark").toBeDefined();
  expect(row!.find(".y-deck__pending-why").text()).toBe("the floor is above the ceiling");
});

/** A problem the deck cannot place is still drawn, with its own path — a
 * refusal must never be silently dropped. */
it("draws a problem it cannot match to a staged edit rather than losing it", () => {
  const { wrapper } = deck(makeStore(makeReport({
    problems: [{ path: "somewhere.else", message: "not a setting this device has" }],
  })), "setup");
  expect(wrapper.text()).toContain("not a setting this device has");
  expect(wrapper.text()).toContain("somewhere.else");
});

it("groups flow into columns and no group is stranded on a row of its own", () => {
  // jsdom performs no layout (Task 14's own lesson): the assertion is on the
  // CSS rule that prevents a stray column, not a measured pixel position.
  const report = makeReport({
    capabilities: {
      brightness: present(range({ current: 0 })),
      zoom: present(range({ current: 0, min: 0, max: 60 })),
      gamma: present(range({ current: 110, min: 64, max: 300 })),
      rotation: present(range({ current: 0, min: 0, max: 270 })),
    },
    descriptors: {
      brightness: { label: "Brightness", unit: "", min: -64, max: 64, step: 1, current: 0, default: 0 },
      zoom: { label: "Zoom", unit: "", min: 0, max: 60, step: 1, current: 0, default: 0 },
      gamma: { label: "Gamma", unit: "", min: 64, max: 300, step: 1, current: 110, default: 110 },
      rotation: { label: "Rotation", unit: "", min: 0, max: 270, step: 90, current: 0, default: 0 },
    },
  });
  const { wrapper } = deck(makeStore(report), "live");

  const cols = wrapper.find(".y-deck__cols");
  expect(cols.exists()).toBe(true);
  expect(getComputedStyle(cols.element).flexWrap).toBe("wrap");

  const slots = wrapper.findAll(".y-deck__slot");
  expect(slots.length).toBeGreaterThan(1);
  for (const slot of slots) {
    const style = getComputedStyle(slot.element);
    // A fixed column width, never 0/auto — the rule that keeps a slot from
    // collapsing to a single stranded row when it holds only one group.
    expect(style.minWidth).toBe("252px");
  }
});

/**
 * **The shutter follows spec §4 like every other kind on this deck.**
 *
 * It did not: the branch returned a fact for anything but `present`, so a
 * camera that lists a recorder and cannot use one — the bench's own board,
 * whose recorder is unbuilt — drew no Record key at all, and the capture
 * gate's viewport contract found nothing to check. Only `not-offered` draws
 * a fact; `advertised` and `gated` keep the key, inoperative, carrying the
 * reason (R-UI-21, R-UI-26: under the picture it records, never on a rail).
 */
describe("the shutter key, in all four capability states", () => {
  const REASON = "board recording is not built";

  it("draws the key with its reason when the capability is advertised", () => {
    const { wrapper } = deck(makeStore(makeReport({
      capabilities: { ...noCapabilities(), recording: advertised({ medium: "board" }, REASON) },
    })), "live");
    const shutter = wrapper.find(".y-shutter");
    expect(shutter.exists(), "an advertised recorder must still draw its key").toBe(true);
    expect(shutter.find(".y-shutter__why").text()).toBe(REASON);
    expect(shutter.find(".y-shutter__btn").attributes("disabled")).toBeDefined();
  });

  it("draws the key inert, naming what has charge of it, when it is gated", () => {
    const { wrapper } = deck(makeStore(makeReport({
      capabilities: {
        ...noCapabilities(),
        stills: gated({ source: "pipeline" }, { id: "recording", label: "recording" }),
      },
    })), "live");
    expect(wrapper.find(".y-shutter__why").text()).toBe("recording has it");
  });

  it("draws a live key for a capability the camera has", () => {
    const { wrapper } = deck(makeStore(makeReport({
      capabilities: { ...noCapabilities(), recording: present({ medium: "board" }) },
    })), "live");
    expect(wrapper.find(".y-shutter__why").exists()).toBe(false);
    expect(wrapper.find(".y-shutter__btn").attributes("disabled")).toBeUndefined();
  });

  it("draws no key at all for a camera that has no recorder", () => {
    const { wrapper } = deck(makeStore(makeReport({ capabilities: noCapabilities() })), "live");
    expect(wrapper.find(".y-shutter").exists()).toBe(false);
  });
});
