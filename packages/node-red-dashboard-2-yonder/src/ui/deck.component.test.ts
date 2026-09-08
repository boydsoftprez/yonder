// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
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

/** The capture the fixture camera is running, and what `FORMATS` offers at
 * it — so a test that stages a size or a rate is staging a real one. */
const BASE_CAPTURE_POLICY = { width: 1280, height: 720, framerate: 30, codec: "h264" };
/**
 * A format list with the property the two pickers exist for: the same rate is
 * not offered at every size. 1920×1080 makes 30 and 15 only; 1280×720 makes
 * 60 as well. A single combined picker cannot express that without listing
 * every pair, which is the eighty-row menu the operator refused.
 */
const FORMATS = [
  { fourcc: "MJPG", width: 1920, height: 1080, rates: [30, 15] },
  { fourcc: "MJPG", width: 1280, height: 720, rates: [60, 30, 15] },
  { fourcc: "MJPG", width: 640, height: 480, rates: [30] },
];

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
      capture: { ...BASE_CAPTURE_POLICY, ...((policy && policy.capture) || {}) },
      stream: { ...BASE_STREAM_POLICY, ...((policy && policy.stream) || {}) },
      preview: { ...BASE_PREVIEW_POLICY, ...((policy && policy.preview) || {}) },
    },
    applied: {
      capture: { ...BASE_CAPTURE_POLICY, ...((applied && applied.capture) || {}) },
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

/**
 * **R-UI-27, through the one hop the browser owns.**
 *
 * `deckDraft()` translates a staged `name` and `POST /cameras/:id/apply`
 * writes it, and both have tests in `yonder-core` — over a draft they build
 * themselves. None of that reaches a camera unless the Name field actually
 * stages into the shared draft and the Apply press actually carries it, which
 * is this component's half and was untested: a field wired to nothing, or one
 * that posted on every keystroke, would leave every test in that package
 * green.
 *
 * Typing must also post nothing on its own. That is defect 1 — a value
 * reaching the aircraft the moment focus left a field — and a name is a field
 * an operator types slowly.
 */
it("stages the camera's name and sends it only when Apply is pressed", async () => {
  const { wrapper, emit } = deck(makeStore(makeReport()), "setup");
  const field = wrapper.findAll(".y-tf").find((f) => f.find(".y-tf__label").text() === "Name")!;
  const input = field.find("input");
  expect(input.element.value, "the field draws the applied name").toBe("Cam 1");

  await input.setValue("Nose mast");
  expect(emit, "typing a name must not post").not.toHaveBeenCalled();
  input.element.dispatchEvent(new Event("blur", { bubbles: true, cancelable: true }));
  expect(emit, "leaving the field must not post either").not.toHaveBeenCalled();
  expect((wrapper.vm as any).draftStore.get("elp")).toMatchObject({ name: "Nose mast" });

  await wrapper.findAll(".y-deck__key").find((b) => b.text() === "Apply")!.trigger("click");
  expect(emit).toHaveBeenCalledTimes(1);
  const [, , msg] = emit.mock.calls[0]!;
  expect(msg.payload.apply).toEqual({ name: "Nose mast" });
});

/**
 * The Name field is a bench setting (spec §3): it belongs on Setup, with the
 * other three, and not on the deck an operator flies from.
 */
it("offers the name on Setup and nowhere on Live", () => {
  const { wrapper } = deck(makeStore(makeReport()), "live");
  expect(wrapper.findAll(".y-tf").map((f) => f.find(".y-tf__label").text()))
    .not.toContain("Name");
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
    problemsFor: "elp",
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
 * refusal must never be silently dropped, and `deckDraft`'s unknown-path
 * branch names a path that *was* staged. */
it("draws a problem it cannot match to a staged edit rather than losing it", async () => {
  const { wrapper } = deck(makeStore(makeReport({
    problems: [{ path: "somewhere.else", message: "not a setting this device has" }],
    problemsFor: "elp",
  })), "setup");
  await segByLabel(wrapper, "Bitrate").findAll("button")
    .find((b) => b.text() === "Adaptive")!.trigger("click");
  expect(wrapper.text()).toContain("not a setting this device has");
  expect(wrapper.text()).toContain("somewhere.else");
});

/**
 * **A refusal belongs to one camera's draft, and to nothing else.**
 *
 * The flow keeps one stash per *device*, so both of these were reproduced on
 * a real page: a problem from camera A drawn beside camera B's matching
 * staged path, and a red sentence left under a `Pending changes · 0` header
 * after Discard. Neither is a flag some navigation path has to remember to
 * clear — they are two readings of the same rule, that a refusal about a
 * draft stops applying when that draft does.
 */
describe("a refusal that is not about the draft on screen", () => {
  const PROBLEM = { path: "preview.floor_kbps", message: "the floor is above the ceiling" };

  const stagePreviewFloor = async (wrapper: VueWrapper<any>) => {
    const floor = wrapper.findAll(".y-sb")
      .filter((b) => b.find(".y-sb__label").text() === "Floor").at(-1)!;
    press(floor.find(".y-sb__trk").element, 40);
    await wrapper.vm.$nextTick();
  };

  it("is not drawn against a different camera's identical staged path", async () => {
    const { wrapper } = deck(makeStore(makeReport({
      problems: [PROBLEM],
      problemsFor: "another-camera",
    })), "setup");
    await stagePreviewFloor(wrapper);

    const row = wrapper.findAll(".y-deck__pending-row")
      .find((r) => r.find(".y-deck__pending-path").text() === "previewFloor");
    expect(row, "the edit itself is still pending").toBeDefined();
    expect(row!.find(".y-deck__pending-why").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("the floor is above the ceiling");
  });

  it("is not drawn once the draft it was about has been discarded", async () => {
    const { wrapper } = deck(makeStore(makeReport({
      problems: [PROBLEM],
      problemsFor: "elp",
    })), "setup");
    await stagePreviewFloor(wrapper);
    expect(wrapper.text()).toContain("the floor is above the ceiling");

    await wrapper.findAll(".y-deck__key").find((b) => b.text() === "Discard")!.trigger("click");
    expect(wrapper.find(".y-deck__pending").exists(), "nothing left for it to be about").toBe(false);
    expect(wrapper.text()).not.toContain("the floor is above the ceiling");
  });
});

/**
 * **A staged control says so, on the page you staged it from.**
 *
 * The deck draws the staged value the moment it is staged, and for one commit
 * nothing said it was staged: an operator on Live saw a changed number and had
 * to leave for Setup to learn which controls were holding an edit. The
 * blueprint carries the sentence on every staged control
 * (`gallery/deck.js`: `reason: pending ? "Pending · apply on Setup"`).
 *
 * The pair matters. Staging must add the sentence and the applied report must
 * take it away again, or the first half alone would pass while the console
 * told an operator an edit was waiting for ever.
 */
it("says which controls are holding an edit, and stops saying it once applied", async () => {
  // A *reactive* store: `makeStore` returns a plain object, and the deck reads
  // its report through a computed, so a later mutation of a plain object would
  // never re-render and the second half of this test could not fail honestly.
  const store = reactive(makeStore(makeReport({})));
  const { wrapper } = deck(store as ReturnType<typeof makeStore>, "live");
  expect(wrapper.text()).not.toContain("Pending · apply on Setup");

  // Staged through the deck's own `stage()` rather than by finding a widget
  // and guessing which path its label maps to: this is a test about the
  // marker, and a mis-picked bar would stage one path and apply another.
  (wrapper.vm as unknown as { stage: (p: string, v: unknown) => void })
    .stage("streamBitrate", 4200);
  await wrapper.vm.$nextTick();

  expect(wrapper.text(), "a staged control must say so").toContain("Pending · apply on Setup");

  // The device comes back reporting the value the draft asked for. The edit is
  // no longer pending, so the sentence must go — `pending` filters at read
  // time and this is the half of that which reaches the operator.
  store.state.data.messages.d1.payload = makeReport({
    applied: { stream: { mode: "fixed", bitrate_kbps: 4200 }, preview: {} },
  });
  // Two ticks: `report` -> `appliedFlat` -> `pendingEdits` -> render is a
  // chain of computeds, and one tick flushes the values but not yet the tree.
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();
  expect(wrapper.text(), "an applied edit is not pending").not.toContain("Pending · apply on Setup");
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
    // 220px is the blueprint's own figure (`gallery.css` `.d-cols__slot`); at
    // 252 a fourth slot did not fit a 1280-wide page and wrapped under the
    // first, so the four-column shape `SLOTS` declares only appeared at 1440.
    expect(style.minWidth).toBe("220px");
  }
  // **The rule between columns.** Four unruled columns of label/value pairs
  // read as one field of text, with nothing to say which qualifier governs
  // which reading. The blueprint draws a divider and this did not. The first
  // slot has nothing to its left to be divided from.
  expect(getComputedStyle(slots[0].element).borderLeftWidth,
    "the first column has nothing to its left").toBe("0px");
  for (const slot of slots.slice(1)) {
    expect(getComputedStyle(slot.element).borderLeftWidth,
      "every column after the first needs a rule beside it").toBe("1px");
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
/**
 * **One key that follows the mode, and the line under it** (blueprint L-43 to
 * L-47; R-CAM-17, R-CAM-18, R-STO-06).
 *
 * The deck drew two shutter keys, always both — a Record circle and a Photo
 * circle stacked — because it called `drawShutter()` once per capability.
 * The camera cannot do both at once, so two keys were a lie about that, and
 * `YonderShutter` had taken a `mode` prop since the day it was built.
 *
 * Everything below is about what an operator reads without opening anything:
 * which key is there, what it says about where a capture lands and how much
 * room is left, and — the one an operator was not present for — why a
 * recording ended when nobody stopped it.
 */
describe("the capture column: one key, following the mode", () => {
  const recorder = (over: Record<string, unknown> = {}) => ({
    recording: false, since: null, destination: "board",
    remainingSeconds: 7_080, remainingPhotos: 3_900, bytes: null, ended: null, ...over,
  });
  const both = {
    ...noCapabilities(),
    recording: present({ medium: "board" }),
    stills: present({ source: "pipeline" }),
  };
  const mode = (w: VueWrapper<any>) => segByLabel(w, "Mode");

  it("draws one key, not two, and it reads RECORD in Video", () => {
    const { wrapper } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    expect(wrapper.findAll(".y-shutter"), "one camera, one shutter").toHaveLength(1);
    // Blueprint L-44 draws the state in the key's own label — `\u25cb RECORD`,
    // `PHOTO`, `\u25cf RECORDING 00:13:47`. The ring is a glyph in that string,
    // not a circle drawn around the control: the shutter is the width and
    // height of the `Video | Photo` pair above it, like every other key here.
    expect(wrapper.find(".y-shutter__label").text()).toBe("\u25cb RECORD");
  });

  it("reads PHOTO once the MODE control is put in Photo, and still draws one key", async () => {
    const { wrapper } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    await mode(wrapper).findAll("button")[1]!.trigger("click");
    expect(wrapper.findAll(".y-shutter")).toHaveLength(1);
    expect(wrapper.find(".y-shutter__label").text()).toBe("PHOTO");
  });

  /**
   * The operator settled this: Video-or-Photo is a state of the browser, like
   * which deck is showing. It is not configuration, so it must not reach the
   * socket at all — the same structural guarantee every staged edit on this
   * deck has, asserted the same way.
   */
  it("changes the mode without posting anything, because the mode is the browser's", async () => {
    const { wrapper, emit } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    await mode(wrapper).findAll("button")[1]!.trigger("click");
    expect(emit).not.toHaveBeenCalled();
  });

  it("offers no mode to a camera with only one of the two, and draws that one's key", () => {
    const onlyStills = { ...noCapabilities(), stills: present({ source: "pipeline" }) };
    const { wrapper } = deck(makeStore(makeReport({ capabilities: onlyStills, recorder: recorder() })), "live");
    // A control whose options are one is a control that cannot be used.
    expect(wrapper.findAll(".y-seg").some((s) => s.find(".y-seg__label").text() === "Mode")).toBe(false);
    expect(wrapper.find(".y-shutter__label").text()).toBe("PHOTO");
  });

  it("says where a capture lands and how much is left, in the unit the mode works in", async () => {
    const { wrapper } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    expect(wrapper.find(".y-shutter__dest").text()).toBe("to this board · 118 min free");
    await mode(wrapper).findAll("button")[1]!.trigger("click");
    expect(wrapper.find(".y-shutter__dest").text()).toBe("to this board · 3900 photos free");
  });

  it("says the camera's own card is a medium it cannot measure, never that it is full", () => {
    const { wrapper } = deck(makeStore(makeReport({
      capabilities: both,
      recorder: recorder({ destination: "camera", remainingSeconds: null, remainingPhotos: null }),
    })), "live");
    expect(wrapper.find(".y-shutter__dest").text())
      .toBe("to the camera's card · this device cannot see what is left on it");
  });

  it("counts the elapsed time from the recorder's own `since`, never from the press", async () => {
    const since = Date.now() - 64_000;
    const { wrapper } = deck(makeStore(makeReport({
      capabilities: both, recorder: recorder({ recording: true, since }),
    })), "live");
    // A page opened after the recording began shows it running, at the
    // board's own elapsed time. An optimistic local timestamp — which is what
    // this deck used to keep — reads 00:00:00 here.
    // In the key, not beside it: one control saying one thing.
    expect(wrapper.find(".y-shutter__label").text()).toBe("\u25cf RECORDING 00:01:04");
    expect(wrapper.find(".y-shutter__btn").classes()).toContain("lit");
  });

  /**
   * R-STO-06 is only honest if the interface can say *that is what happened*.
   * An operator whose recording ended without them has to be told why, and a
   * sentence after every stop would train them to stop reading it.
   */
  it("says why a recording ended by itself, and says nothing after a stop somebody pressed", () => {
    const byItself = deck(makeStore(makeReport({
      capabilities: both,
      recorder: recorder({ ended: { at: 5, reason: "the card reached the 1024 MB reserve" } }),
    })), "live").wrapper;
    expect(byItself.find(".y-deck__ended").text())
      .toContain("the card reached the 1024 MB reserve");

    const pressed = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live").wrapper;
    expect(pressed.find(".y-deck__ended").exists()).toBe(false);
  });

  it("posts record, then stop, from the one key — reading the device, not itself", async () => {
    // Reactive, because this is the one test here that watches the deck
    // answer a *second* report — the device saying the recording started.
    const store = reactive(makeStore(makeReport({ capabilities: both, recorder: recorder() })));
    const { wrapper, emit } = deck(store, "live");
    await wrapper.find(".y-shutter__btn").trigger("click");
    expect(emit.mock.calls[0]![2]).toEqual({ payload: { shutter: "record" } });

    // The device answers, and only then is the key a stop. A deck that kept
    // its own guess would send `stop` here whether or not anything started.
    store.state.data.messages.d1 = {
      payload: makeReport({
        capabilities: both, recorder: recorder({ recording: true, since: Date.now() }),
      }),
    };
    await nextTick();
    await wrapper.find(".y-shutter__btn").trigger("click");
    expect(emit.mock.calls[1]![2]).toEqual({ payload: { shutter: "stop" } });
  });

  it("takes a photograph in Photo mode", async () => {
    const { wrapper, emit } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    await mode(wrapper).findAll("button")[1]!.trigger("click");
    await wrapper.find(".y-shutter__btn").trigger("click");
    expect(emit.mock.calls[0]![2]).toEqual({ payload: { shutter: "photo" } });
  });

  /**
   * §8.3: repeated presses must not launch competing captures. The device
   * refuses the second with `busy`, and a refusal the operator should never
   * have had to see is a refusal this page should not have caused.
   */
  it("sends nothing on a second press while the first is still in flight", async () => {
    const { wrapper, emit } = deck(makeStore(makeReport({ capabilities: both, recorder: recorder() })), "live");
    await wrapper.find(".y-shutter__btn").trigger("click");
    await wrapper.find(".y-shutter__btn").trigger("click");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("draws the captures link with the count, and asks for the listing when it is pressed", async () => {
    const { wrapper, emit } = deck(makeStore(makeReport({
      capabilities: both, recorder: recorder(), captures: { count: 3 },
    })), "live");
    const link = wrapper.find(".y-deck__captures");
    expect(link.text()).toBe("Captures (3) \u203a");
    await link.trigger("click");
    expect(emit.mock.calls[0]![2]).toEqual({ payload: { captures: "read" } });
  });

  /**
   * A camera page has to say where a capture would go before any daemon with
   * a recorder has answered — otherwise the line under the key is blank on
   * every device that has not been upgraded, which reads as *nowhere*.
   */
  it("falls back to the capability's own medium where there is no recorder to ask", () => {
    const { wrapper } = deck(makeStore(makeReport({ capabilities: both })), "live");
    expect(wrapper.find(".y-shutter__dest").text()).toBe("to this board");
  });
});

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

/**
 * R-CTL-05 and R-CTL-15, and the defect the operator caught before it
 * shipped.
 *
 * Every camera on the bench answers `not-offered` to `horizontal_flip`,
 * `vertical_flip` and `rotate`. That is honest — it is what the device said —
 * and read through `drawCapability()` it would print three sentences saying
 * the camera cannot, on a console that can do all three on the board. So the
 * Orientation group is drawn from `report.orientation`, which `cameraDeck()`
 * composed from `video/orientation.ts`, and the four-state vocabulary is not
 * consulted for it at all.
 *
 * **Three hops carry `by`/`says`/`note` from `orientation()` to a pixel**, and
 * each is tested where it lives: `orientation.test.ts` for the answer,
 * `present.test.ts` for the payload, and here for the drawing. A guarantee
 * enforced in one place and untested at the join has left this branch's suite
 * green while the feature did nothing, twice.
 */
function turns(over: Record<string, unknown> = {}) {
  const by = (over.by || {}) as Record<string, string>;
  const value = (over.value || {}) as Record<string, number | null>;
  const carriers = ["horizontalFlip", "verticalFlip", "rotation"].map((key) => by[key] || "board");
  // `says` beside a control only where the three disagree — the daemon's own
  // rule (`deckOrientation()`), reproduced here so a report this file builds
  // is a report the daemon could have sent.
  const agreed = carriers.every((b) => b === carriers[0]);
  const beside = (b: string) => (b === "sensor" ? "the camera turns this itself" : "the board turns this after decoding");
  return {
    says: (over.says as string) || "this camera cannot turn the picture itself, so the board turns it after decoding",
    turns: ["horizontalFlip", "verticalFlip", "rotation"].map((key, i) => ({
      key,
      by: carriers[i],
      says: agreed ? null : beside(carriers[i] as string),
      value: key in value ? value[key] : null,
    })),
  };
}

describe("the three that turn the picture", () => {
  it("draws all three as controls on a camera whose sensor offers none of them", () => {
    // The whole point: `capabilities` says not-offered for all three — the
    // bench camera's own answer — and the group is three working controls,
    // not three facts.
    const report = makeReport({ orientation: turns() });
    const { wrapper } = deck(makeStore(report), "live");

    expect(legends(wrapper)).toContain("Orientation");
    expect(segByLabel(wrapper, "Mirror").exists()).toBe(true);
    expect(segByLabel(wrapper, "Flip").exists()).toBe(true);
    expect(pickerByLabel(wrapper, "Rotation").exists()).toBe(true);
    // And not one of them as a fact — the row the operator caught.
    expect(factLabels(wrapper)).not.toContain("Mirror");
    expect(factLabels(wrapper)).not.toContain("Flip");
    expect(factLabels(wrapper)).not.toContain("Rotation");
    // Working, not drawn-and-inert: a control the page disabled would say
    // "cannot" as loudly as a sentence would.
    expect(segByLabel(wrapper, "Mirror").classes()).toContain("is-present");
    expect(segByLabel(wrapper, "Mirror").findAll("button").every((b) => !b.attributes("disabled"))).toBe(true);
  });

  it("says which of the two is turning the picture, once, beneath all three", () => {
    // Once and not four times over. It shipped as a sentence beside every
    // control *and* a line under the group, which put the same words on the
    // page four times; the committed capture is what said so.
    const report = makeReport({
      orientation: turns({
        says: "this camera cannot turn the picture itself, so the board turns it after decoding"
          + " — a quarter turn transposes every frame, and swaps its width and height",
      }),
    });
    const { wrapper } = deck(makeStore(report), "live");
    const notes = wrapper.findAll(".y-deck__turnnote");
    expect(notes).toHaveLength(1);
    expect(notes[0].text()).toContain("the board turns it after decoding");
    // The quarter-turn warning reaches the page rather than being trimmed:
    // a quarter turn swaps the picture's width and height and the preview's
    // capsfilter is fixed, so an operator who can reach it must be told.
    expect(notes[0].text()).toContain("swaps its width and height");
    // And nothing repeats it beside a control.
    expect(segByLabel(wrapper, "Mirror").find(".y-seg__why").exists()).toBe(false);
    expect(segByLabel(wrapper, "Flip").find(".y-seg__why").exists()).toBe(false);
    expect(pickerByLabel(wrapper, "Rotation").find(".y-pick__why").exists()).toBe(false);
  });

  it("names each control's own carrier where the three of them disagree", () => {
    // The one case a single line cannot carry: a camera that mirrors in its
    // sensor and still needs the board to rotate.
    const report = makeReport({
      orientation: turns({
        by: { horizontalFlip: "sensor" },
        says: "this camera turns part of the picture itself, and each control says which",
      }),
    });
    const { wrapper } = deck(makeStore(report), "live");
    expect(segByLabel(wrapper, "Mirror").find(".y-seg__why").text()).toMatch(/the camera turns this/i);
    expect(segByLabel(wrapper, "Flip").find(".y-seg__why").text()).toMatch(/the board turns this/i);
    expect(pickerByLabel(wrapper, "Rotation").find(".y-pick__why").text()).toMatch(/the board turns this/i);
    expect(wrapper.find(".y-deck__turnnote").text()).toContain("each control says which");
    // Neutral, not the caution tone: a real pipeline element with a real
    // cost is a fact about the camera, not a fault in it.
    expect(segByLabel(wrapper, "Flip").find(".y-seg__why").classes()).not.toContain("why-advertised");
  });

  it("draws the value from the report, whichever of the two is holding it", () => {
    const report = makeReport({
      orientation: turns({ value: { horizontalFlip: 1, verticalFlip: 0, rotation: 180 } }),
    });
    const { wrapper } = deck(makeStore(report), "live");
    const pressed = (el: ReturnType<typeof segByLabel>) =>
      el.findAll("button").filter((b) => b.attributes("aria-pressed") === "true").map((b) => b.text());
    expect(pressed(segByLabel(wrapper, "Mirror"))).toEqual(["On"]);
    expect(pressed(segByLabel(wrapper, "Flip"))).toEqual(["Off"]);
    expect(pickerByLabel(wrapper, "Rotation").find(".y-pick__value").text()).toBe("180°");
  });

  it("offers exactly the four quarter turns, and no other angle", () => {
    // The eight orientations a mount can need are these four and the two
    // flips that reach the other four. A fifth angle here would be an
    // orientation `videoflip` has no direction for.
    const { wrapper } = deck(makeStore(makeReport({ orientation: turns() })), "live");
    const options = pickerByLabel(wrapper, "Rotation").findAll("option");
    expect(options.map((o) => o.attributes("value"))).toEqual(["0", "90", "180", "270"]);
    expect(options.map((o) => o.text())).toEqual(["0°", "90°", "180°", "270°"]);
  });

  /**
   * **A turn goes where the turning happens, and this test asserted otherwise.**
   *
   * It used to say every turn posts through the socket "the way every other
   * image control does". That is true only of a turn the *sensor* performs.
   * A board turn is a `videoflip` in the launch line — a pipeline change that
   * restarts the picture — and posting it as a live control sent it to a
   * device that does not have the control at all. The bench ELP answers none
   * of the three, so on the board every press came back *"this camera does
   * not offer horizontalFlip"*: a refusal for something Yonder can do. The
   * operator found it minutes after the deploy.
   */
  it("posts a sensor turn live, because the device really is doing it", async () => {
    const report = makeReport({ orientation: turns({ by: { horizontalFlip: "sensor", verticalFlip: "sensor", rotation: "sensor" } }) });
    const { wrapper, emit } = deck(makeStore(report), "live");

    await segByLabel(wrapper, "Mirror").findAll("button")[1].trigger("click");
    expect(emit).toHaveBeenCalledWith("widget-action", "d1", { payload: { control: "horizontalFlip", value: true } });

    emit.mockClear();
    await pickerByLabel(wrapper, "Rotation").find("select").setValue("270");
    // The degrees themselves, as a number — `config.yaml` stores degrees and
    // `applyControls` writes them; a string would reach `v4l2-ctl` as one.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("widget-action", "d1", { payload: { control: "rotation", value: 270 } });
    expect(wrapper.vm.pendingEdits, "a device write is not a policy edit").toHaveLength(0);
  });

  it("stages a board turn, because it restarts the picture like any other pipeline change", async () => {
    // `turns()` defaults every carrier to the board, which is this bench.
    const report = makeReport({ orientation: turns() });
    const { wrapper, emit } = deck(makeStore(report), "live");

    await segByLabel(wrapper, "Mirror").findAll("button")[1].trigger("click");
    // **Nothing is posted.** Posting sent it to a sensor that refuses it.
    expect(emit).not.toHaveBeenCalled();
    expect(wrapper.vm.pendingEdits.map((e: { path: string }) => e.path)).toContain("horizontalFlip");

    await pickerByLabel(wrapper, "Rotation").find("select").setValue("270");
    expect(emit).not.toHaveBeenCalled();
    expect(wrapper.vm.pendingEdits.map((e: { path: string }) => e.path)).toContain("rotation");
  });

  it("draws no orientation group at all for a report that carries none", () => {
    // Loudly absent rather than quietly wrong. Falling back to the
    // capability states is exactly what would put the three "this camera has
    // none" rows back on the page, silently, the day this field went missing.
    //
    // **The camera here answers `horizontal_flip` as present**, and that is
    // what makes this test about the payload rather than about the states: a
    // deck that fell back to `capabilities` would draw a Mirror switch from
    // it, and one that draws only from `orientation` draws nothing. Without
    // that the assertion would hold for a deck that had never been changed
    // at all, because every capability would be not-offered anyway.
    const report = makeReport({
      capabilities: { horizontalFlip: present(range({ min: 0, max: 1, current: 1 })) },
      descriptors: { horizontalFlip: { label: "Mirror", unit: "", min: 0, max: 1, step: 1, current: 1, default: 0 } },
      values: { horizontalFlip: 1 },
    });
    const { wrapper } = deck(makeStore(report), "live");
    expect(legends(wrapper)).not.toContain("Orientation");
    expect(factLabels(wrapper)).not.toContain("Mirror");
    expect(wrapper.html()).not.toContain(">Mirror<");
    expect(wrapper.find(".y-deck__turnnote").exists()).toBe(false);
  });
});

/**
 * **The Resolution and Frame rate pickers** (R-CAM-14, R-VID-07, R-CTL-05;
 * blueprint L-56, and the divergence recorded against it in
 * `docs/console/design/blueprint-manifest.md`).
 *
 * The blueprint draws one combined picker reading `1280×720 · 30 fps`. The
 * operator decided two, under CLAUDE.md rule 8, because a combined menu on
 * the bench camera is eighty rows in which eight of every ten differ only in
 * a trailing number. Every test here is about the pair being two controls
 * that agree — a single picker would satisfy several of them.
 */
describe("the size and rate the camera captures", () => {
  const withFormats = (over: Record<string, unknown> = {}) =>
    makeReport({ capabilities: { formats: present(FORMATS) }, ...over });

  it("offers each size the camera reported, once, and no size it did not", () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    const options = pickerByLabel(wrapper, "Resolution").findAll("option");
    expect(options.map((o) => o.attributes("value")))
      .toEqual(["1920x1080", "1280x720", "640x480"]);
    // R-CAM-14: exactly the device's list, never a range filled in between.
    expect(options.map((o) => o.text())).not.toContain("1600×1200");
  });

  /**
   * **The whole reason there are two pickers.** The rate menu is the rates
   * *this size* reported — not every rate the camera makes anywhere. A single
   * combined picker cannot say this, and a rate menu built from the union
   * would offer 60 fps at 1920×1080, which this camera does not make.
   */
  it("offers only the rates the held size reported", async () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    const rates = () => pickerByLabel(wrapper, "Frame rate").findAll("option")
      .map((o) => o.attributes("value"));
    expect(rates(), "1280×720 makes 60, 30 and 15").toEqual(["60", "30", "15"]);

    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1920x1080");
    expect(rates(), "1920×1080 makes 30 and 15 only").toEqual(["30", "15"]);
    expect(rates()).not.toContain("60");
  });

  it("draws the size and rate the configuration holds", () => {
    const { wrapper } = deck(makeStore(withFormats({
      policy: { capture: { width: 640, height: 480, framerate: 30 } },
      applied: { capture: { width: 640, height: 480, framerate: 30 } },
    })), "setup");
    expect(pickerByLabel(wrapper, "Resolution").find(".y-pick__value").text()).toBe("640×480");
    expect(pickerByLabel(wrapper, "Frame rate").find(".y-pick__value").text()).toBe("30 fps");
  });

  /**
   * **In the Stream column, beneath the bitrate** — spec §7 lists Resolution
   * under *Stream · to the ground station* and the blueprint draws it there.
   * An earlier reading put it in Capture; this asserts the column, not merely
   * that the control exists somewhere on the page.
   */
  it("draws both in the Stream column, after the bitrate bar", () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    const stream = wrapper.findAll(".y-col")
      .find((c) => c.find(".y-col__legend").text().toLowerCase().startsWith("stream"))
    expect(stream, "there is a Stream column").toBeTruthy();
    const html = stream!.html();
    expect(html).toContain("Resolution");
    expect(html).toContain("Frame rate");
    expect(html.indexOf("Bitrate")).toBeLessThan(html.indexOf("Resolution"));
    expect(html.indexOf("Resolution")).toBeLessThan(html.indexOf("Frame rate"));
  });

  /**
   * **A size is two schema leaves, and one press stages both.** `DRAFT_PATHS`
   * keeps `width` and `height` apart because `config.yaml` does; a picker
   * that staged only one would apply half a size, which is the shape of four
   * separate defects on this branch.
   */
  it("stages width and height together, and posts nothing", async () => {
    const { wrapper, emit } = deck(makeStore(withFormats()), "setup");
    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1920x1080");
    expect((wrapper.vm as any).draftStore.get("elp"))
      .toMatchObject({ width: 1920, height: 1080 });
    expect(emit, "a capture edit is a draft, never a device write").not.toHaveBeenCalled();
  });

  it("stages the rate on its own, and posts nothing", async () => {
    const { wrapper, emit } = deck(makeStore(withFormats()), "setup");
    await pickerByLabel(wrapper, "Frame rate").find("select").setValue("15");
    expect((wrapper.vm as any).draftStore.get("elp")).toMatchObject({ framerate: 15 });
    expect((wrapper.vm as any).draftStore.get("elp").width).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  /**
   * **Both pickers read the draft first, then what is applied.** A picker
   * that drew the applied value would snap back to 30 fps the instant the
   * operator chose 15 — the value would still be staged and the control
   * would deny it, which is the "drew, posted, and changed nothing" shape
   * this branch has met four times. Asserted on the drawn text, not on the
   * store, because the store is where the mutant still succeeds.
   */
  it("draws the staged size and rate, not the ones still applied", async () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    await pickerByLabel(wrapper, "Frame rate").find("select").setValue("15");
    expect(pickerByLabel(wrapper, "Frame rate").find(".y-pick__value").text()).toBe("15 fps");
    expect(pickerByLabel(wrapper, "Frame rate").find(".y-pick__why").text())
      .toContain("Pending");

    // 1920×1080 and not 640×480: the latter makes 30 alone, so it would put a
    // refusal on the rate picker and this test would stop being about the two
    // pickers drawing what was staged.
    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1920x1080");
    expect(pickerByLabel(wrapper, "Resolution").find(".y-pick__value").text()).toBe("1920×1080");
    expect(pickerByLabel(wrapper, "Resolution").find(".y-pick__why").text())
      .toContain("Pending");
    expect(pickerByLabel(wrapper, "Frame rate").find(".y-pick__value").text()).toBe("15 fps");
  });

  /**
   * **The warning before the press** (spec §8.1). It was missing for a board
   * turn and the operator met the cut with nothing having said it would
   * happen; a size change is the same mechanism — the launch line differs, so
   * `PipelineRenderer` respawns.
   */
  it("says a staged size restarts the picture, before Apply", async () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1920x1080");
    expect(wrapper.find(".y-deck__pending-h").text()).toContain("2");
    expect(wrapper.text()).toContain("restarts the picture");
  });

  /**
   * **And says nothing for the size already applied** — the join
   * `appliedForDraft()` had to carry. With no `applied.capture` on the
   * payload there was nothing for a staged `width` to equal, so every staged
   * size read pending for ever and the restart warning was permanent.
   */
  it("is silent, and shows nothing pending, for the size already running", async () => {
    const { wrapper } = deck(makeStore(withFormats()), "setup");
    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1280x720");
    expect((wrapper.vm as any).draftStore.get("elp"))
      .toMatchObject({ width: 1280, height: 720 });
    expect(wrapper.find(".y-deck__pending").exists(), "nothing is pending").toBe(false);
    expect(wrapper.text()).not.toContain("restarts the picture");
  });

  /**
   * **A pair this camera cannot make is said on the picker, before Apply**,
   * in `captureRefusal()`'s own words — the same sentence the apply route
   * refuses with and `refuse()` returns at compose time. Reachable by staging
   * a size that does not make the rate now held.
   */
  it("names the rate the staged size will not make, on the rate picker", async () => {
    const { wrapper } = deck(makeStore(withFormats({
      policy: { capture: { framerate: 60 } },
      applied: { capture: { framerate: 60 } },
    })), "setup");
    // 60 is fine at 1280×720, which is what this camera is running.
    expect(pickerByLabel(wrapper, "Frame rate").find(".y-pick__why").exists()).toBe(false);

    await pickerByLabel(wrapper, "Resolution").find("select").setValue("1920x1080");
    const why = pickerByLabel(wrapper, "Frame rate").find(".y-pick__why");
    expect(why.exists()).toBe(true);
    expect(why.text()).toContain("60 fps at 1920x1080");
    // Under the control the operator has to change, not under the size.
    expect(pickerByLabel(wrapper, "Resolution").find(".y-pick__why").text())
      .not.toContain("fps at");
  });

  /**
   * **A report whose `policy` carries no `capture` block draws a fact too.**
   * `cameraDeck()` always composes one, so this is the older-daemon case —
   * and without the guard the pickers compose `NaNxNaN`, draw a menu with
   * nothing selected in it, and say "this camera does not offer NaNxNaN".
   */
  it("draws a fact when the report says nothing about what is being captured", () => {
    const report = withFormats() as Record<string, any>;
    delete report.policy.capture;
    delete report.applied.capture;
    const { wrapper } = deck(makeStore(report), "setup");
    expect(wrapper.text()).not.toContain("NaN");
    expect(factLabels(wrapper)).toContain("Resolution");
    expect(wrapper.findAll(".y-pick").some((x) => x.find(".y-pick__label").text() === "Frame rate"))
      .toBe(false);
  });

  /**
   * A camera that answered no format has no menu to draw, and a picker over
   * an empty list is a control that cannot be used — so it is a fact, the way
   * R-UI-20 has every other absence stated.
   */
  it("draws a fact, not an empty picker, for a camera that answered no format", () => {
    const { wrapper } = deck(makeStore(makeReport()), "setup");
    expect(wrapper.findAll(".y-pick").some((p) => p.find(".y-pick__label").text() === "Resolution"))
      .toBe(false);
    expect(factLabels(wrapper)).toContain("Resolution");
  });

  /**
   * **Live too, as the blueprint draws it**: `live.elp.night.png` carries the
   * picker as well as `setup.elp.night.png`, so it is not a Setup-only
   * control. Staging still changes nothing until Apply.
   */
  it("draws on Live as well as Setup", () => {
    const { wrapper } = deck(makeStore(withFormats()), "live");
    expect(pickerByLabel(wrapper, "Resolution").exists()).toBe(true);
    expect(pickerByLabel(wrapper, "Frame rate").exists()).toBe(true);
  });

  /**
   * **And the Capture column no longer counts them** (blueprint L-51).
   * `CAPTURE FORMATS 10` stated a number where R-CAM-14 asks for the formats
   * offered; the formats are now these two menus, and the count beside them
   * would say the same fact twice, once uselessly.
   */
  it("states no bare formats count in the Capture column", () => {
    const { wrapper } = deck(makeStore(withFormats({
      capabilities: { formats: present(FORMATS), recording: present({ medium: "board" }) },
    })), "setup");
    expect(wrapper.text()).not.toContain("Capture formats");
    expect(factLabels(wrapper)).not.toContain("Capture formats");
  });
});

describe('native Pocket controls', () => {
  it('draws measured ISO/WB choices, sends native commands, and labels output shape separately', async () => {
    const native = { state: { status: { mode: 'video' } }, input: { native: { width: 1280, height: 720, fps: 29.97 } }, controls: [
      { key: 'iso', group: 'exposure', label: 'ISO', value: '0', currentLabel: 'Auto · ISO 320', state: 'present', options: [{ value: '5', label: '400', command: { kind: 'iso', value: 5 } }, { value: '9', label: '6400', command: { kind: 'iso', value: 9 } }] },
      { key: 'white-balance', group: 'exposure', label: 'White balance', value: '0', state: 'present', options: [{ value: '0', label: 'Auto', command: { kind: 'white-balance', value: 0 } }, { value: '65', label: '6500 K', command: { kind: 'white-balance', value: 65 } }] },
    ] };
    const { wrapper, emit } = deck(makeStore(makeReport({ accessory: native })), 'live');
    expect(wrapper.text()).toContain('29.97 fps'); expect(wrapper.text()).toContain('Output resolution');
    const iso = pickerByLabel(wrapper, 'ISO');
    expect(iso.find('.y-pick__value').text()).toBe('Auto · ISO 320');
    const isoSelect = iso.find('select').element as HTMLSelectElement;
    expect(isoSelect.disabled).toBe(false); expect(isoSelect.selectedOptions[0].disabled).toBe(true);
    expect(isoSelect.selectedOptions[0].textContent).toBe('Auto · ISO 320');
    await iso.find('select').setValue('9');
    expect(emit).toHaveBeenLastCalledWith('widget-action', 'd1', { payload: { nativeControl: { kind: 'iso', value: 9 } } });
    const wb = pickerByLabel(wrapper, 'White balance');
    expect((wb.find('select').element as HTMLSelectElement).disabled).toBe(false);
    expect(wb.findAll('option').every(option => !(option.element as HTMLOptionElement).disabled)).toBe(true);
    expect(wb.text()).toContain('Auto'); await wb.find('select').setValue('65');
    expect(emit).toHaveBeenLastCalledWith('widget-action', 'd1', { payload: { nativeControl: { kind: 'white-balance', value: 65 } } });
    expect(wrapper.text()).not.toContain('Captures (0)'); wrapper.unmount();
  });
});
