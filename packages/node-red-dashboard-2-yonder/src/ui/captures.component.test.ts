// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import YonderCaptures, { agoWords, sizeWords } from "./YonderCaptures.vue";

/**
 * What this board is holding, and the three things that can be done with one
 * (R-CAM-18, blueprint L-48).
 *
 * Two of the tests here are about a *refusal to draw*: a capture the camera
 * holds gets none of the three keys, because Yonder never saw the file and a
 * View that cannot view anything is worse than no key at all. The other one
 * that matters is the confirmation — this is the only press on the camera
 * page that nothing can undo.
 */

const NOW = 1_700_000_000_000;

function capture(over: Record<string, unknown> = {}) {
  return {
    name: "2026-09-07T14-22-05-123Z-1280x720.jpg",
    at: NOW - 4_000,
    bytes: 1_140_000,
    width: 1280,
    height: 720,
    held: "board",
    ...over,
  };
}

function panel(payload: unknown) {
  const emit = vi.fn();
  const store = reactive({ state: { data: { messages: { n1: { payload } } } } });
  const wrapper = mount(YonderCaptures, {
    props: { id: "n1", props: {} },
    global: {
      provide: { $socket: { emit }, $dataTracker: () => {} },
      mixins: [{ computed: { $store: () => store } }],
    },
  });
  return { wrapper, emit, store };
}

const rows = (w: VueWrapper<any>) => w.findAll(".y-caps__row");
const keysIn = (row: ReturnType<typeof rows>[number]) =>
  row.findAll(".y-caps__key").map((k) => k.text());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("agoWords", () => {
  it("says how long ago, because that is the question the panel answers", () => {
    // An operator reading this list is asking *which of these is the one I
    // just took*, and a wall clock answers that only for somebody who already
    // knows what time it is.
    expect(agoWords(NOW - 2_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 14 * 60_000, NOW)).toBe("14 min ago");
    expect(agoWords(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(agoWords(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
  });

  it("says nothing at all for a capture with no timestamp", () => {
    expect(agoWords(undefined as unknown as number, NOW)).toBe("");
  });
});

describe("sizeWords", () => {
  it("states a size in the decimal units a card is sold in", () => {
    expect(sizeWords(1_140_000)).toBe("1.1 MB");
    expect(sizeWords(9_400)).toBe("9 kB");
    expect(sizeWords(512)).toBe("512 B");
  });
});

describe("the captures panel", () => {
  it("lists in the order it was given, which is the daemon's own newest-first", () => {
    // Re-sorting here would be a second copy of the recorder's own rule — and
    // one that could disagree with the count beside the link, which is
    // composed from the same listing.
    const { wrapper } = panel({
      camera: "cam0",
      captures: [
        capture({ name: "new.jpg", at: NOW - 1_000 }),
        capture({ name: "old.jpg", at: NOW - 41 * 60_000 }),
      ],
    });
    expect(rows(wrapper).map((r) => r.find(".y-caps__meta b").text()))
      .toEqual(["just now", "41 min ago"]);
  });

  it("draws each row's shape and size, and its thumbnail off the console's own route", () => {
    const { wrapper } = panel({ camera: "cam0", captures: [capture()] });
    const row = rows(wrapper)[0]!;
    expect(row.find(".y-caps__meta em").text()).toBe("1280×720 · 1.1 MB");
    expect(row.find("img.y-caps__thumb").attributes("src"))
      .toBe("/video/cam0/captures/2026-09-07T14-22-05-123Z-1280x720.jpg");
  });

  it("falls back to the kind when a thumbnail's bytes do not arrive", async () => {
    // A broken-image icon with the browser's own alt text spilling out of a
    // 56×32 box says *this page is broken* about a row that is telling the
    // truth.
    const { wrapper } = panel({ camera: "cam0", captures: [capture()] });
    await rows(wrapper)[0]!.find("img.y-caps__thumb").trigger("error");
    expect(rows(wrapper)[0]!.find("img.y-caps__thumb").exists()).toBe(false);
    expect(rows(wrapper)[0]!.find(".y-caps__thumb--none").text()).toBe("JPG");
  });

  it("gives a recording its kind instead of a thumbnail nothing could produce", () => {
    // There is no frame to show without decoding the file, which is the one
    // thing a browser must not be asked to do over a field uplink to draw a
    // list. A broken image would be the only other answer.
    const { wrapper } = panel({
      camera: "cam0",
      captures: [capture({ name: "2026-09-07T13-58-11-004Z-1280x720.mkv" })],
    });
    const row = rows(wrapper)[0]!;
    expect(row.find("img.y-caps__thumb").exists()).toBe(false);
    expect(row.find(".y-caps__thumb--none").text()).toBe("MKV");
  });

  it("offers a download that is the file itself, named as the device named it", () => {
    const { wrapper } = panel({ camera: "cam0", captures: [capture()] });
    const link = rows(wrapper)[0]!.find("a.y-caps__key");
    expect(link.attributes("href"))
      .toBe("/video/cam0/captures/2026-09-07T14-22-05-123Z-1280x720.jpg");
    expect(link.attributes("download")).toBe("2026-09-07T14-22-05-123Z-1280x720.jpg");
  });

  it("opens a capture in place, and closes it again", async () => {
    const { wrapper } = panel({ camera: "cam0", captures: [capture()] });
    const view = () => rows(wrapper)[0]!.findAll("button.y-caps__key")[0]!;
    expect(view().text()).toBe("VIEW");
    await view().trigger("click");
    expect(rows(wrapper)[0]!.find(".y-caps__open img").exists()).toBe(true);
    expect(view().text()).toBe("CLOSE");
    await view().trigger("click");
    expect(rows(wrapper)[0]!.find(".y-caps__open").exists()).toBe(false);
  });

  /**
   * R-CAM-18: a still the board holds can be viewed, downloaded and deleted;
   * one the camera holds is *reported as the camera's*. Yonder never saw the
   * file — the fetch refuses it and the delete refuses it — so offering
   * either would be the console claiming something it does not have.
   */
  it("lists a camera-held capture and offers none of the three keys", () => {
    const { wrapper } = panel({
      camera: "cam0",
      captures: [capture({ name: "DJI_0007.JPG", held: "camera" })],
    });
    const row = rows(wrapper)[0]!;
    expect(row.exists(), "a photograph that exists and is not here is still a fact").toBe(true);
    expect(row.findAll(".y-caps__key")).toHaveLength(0);
    expect(row.find(".y-caps__oncam").text()).toContain("the camera's card");
    // And no thumbnail either: the fetch that would fill it refuses.
    expect(row.find("img.y-caps__thumb").exists()).toBe(false);
  });

  it("asks before it deletes, and the first press sends nothing", async () => {
    const { wrapper, emit } = panel({ camera: "cam0", captures: [capture()] });
    const del = () => rows(wrapper)[0]!.findAll("button.y-caps__key")
      .find((b) => b.text() === "DELETE")!;
    await del().trigger("click");

    expect(emit, "the first press asks; it does not delete").not.toHaveBeenCalled();
    expect(rows(wrapper)[0]!.find(".y-caps__ask").text()).toBe("Delete this?");
    expect(keysIn(rows(wrapper)[0]!)).toEqual(["DELETE", "KEEP"]);
  });

  it("deletes on the second press, naming the capture and never a path", async () => {
    const { wrapper, emit } = panel({ camera: "cam0", captures: [capture()] });
    const del = () => rows(wrapper)[0]!.findAll("button.y-caps__key")
      .find((b) => b.text() === "DELETE")!;
    await del().trigger("click");
    await del().trigger("click");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![2])
      .toEqual({ camera: "cam0", payload: { remove: "2026-09-07T14-22-05-123Z-1280x720.jpg" } });
  });

  it("keeps the capture when the question is answered the other way", async () => {
    const { wrapper, emit } = panel({ camera: "cam0", captures: [capture()] });
    await rows(wrapper)[0]!.findAll("button.y-caps__key")
      .find((b) => b.text() === "DELETE")!.trigger("click");
    await rows(wrapper)[0]!.findAll("button.y-caps__key")
      .find((b) => b.text() === "KEEP")!.trigger("click");
    expect(emit).not.toHaveBeenCalled();
    expect(keysIn(rows(wrapper)[0]!)).toEqual(["VIEW", "DOWNLOAD", "DELETE"]);
  });

  /**
   * The guard inside `remove()` and the markup that hides the key are two
   * independent things, and only the first survives a dispatched click — which
   * reaches a listener in a real browser whatever the markup says. This is the
   * one press on the camera page that nothing can undo.
   */
  it("emits nothing from a delete that was never asked about", () => {
    const { wrapper, emit } = panel({ camera: "cam0", captures: [capture()] });
    (wrapper.vm as unknown as { remove(c: unknown): void }).remove(capture());
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits nothing for a camera-held capture even when asked directly", () => {
    const held = capture({ name: "DJI_0007.JPG", held: "camera" });
    const { wrapper, emit } = panel({ camera: "cam0", captures: [held] });
    const vm = wrapper.vm as unknown as { confirming: string | null; remove(c: unknown): void };
    vm.confirming = held.name;
    vm.remove(held);
    expect(emit).not.toHaveBeenCalled();
  });

  it("drops a standing question when a fresh listing arrives", async () => {
    const { wrapper, store } = panel({ camera: "cam0", captures: [capture()] });
    await rows(wrapper)[0]!.findAll("button.y-caps__key")
      .find((b) => b.text() === "DELETE")!.trigger("click");
    expect(rows(wrapper)[0]!.find(".y-caps__ask").exists()).toBe(true);

    // A question left standing across a re-read is a question about a row that
    // may no longer be the row under it.
    store.state.data.messages.n1 = {
      payload: { camera: "cam0", captures: [capture({ name: "other.jpg" })] },
    };
    await nextTick();
    expect(wrapper.find(".y-caps__ask").exists()).toBe(false);
  });

  it("counts what it is showing, in the heading", () => {
    const { wrapper } = panel({
      camera: "cam0",
      captures: [capture({ name: "a.jpg" }), capture({ name: "b.jpg" })],
    });
    expect(wrapper.find(".y-caps__h").text()).toContain("Captures · this board");
    expect(wrapper.find(".y-caps__n").text()).toBe("2 saved");
  });

  it("tells an empty listing apart from one that never arrived", () => {
    // The same guarantee the Cameras index makes: an operator must be able to
    // tell "nothing has been captured" from "this panel failed to load".
    expect(panel({ camera: "cam0", captures: [] }).wrapper.find(".y-caps__none").text())
      .toBe("Nothing saved to this board yet.");
    expect(panel(undefined).wrapper.find(".y-caps__none").text())
      .toBe("Waiting for this camera's captures.");
  });

  it("stops saying `just now` on its own", async () => {
    const { wrapper } = panel({ camera: "cam0", captures: [capture({ at: NOW })] });
    expect(wrapper.find(".y-caps__meta b").text()).toBe("just now");
    // A relative time computed once and left is a lie within the minute.
    vi.setSystemTime(NOW + 120_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(wrapper.find(".y-caps__meta b").text()).toBe("2 min ago");
  });

  it("gives a capture no address at all when nothing said which camera it is", () => {
    // An empty `src` draws nothing; a template that fell back to a bare name
    // would resolve against the console's own page and fetch the dashboard.
    const { wrapper } = panel({ captures: [capture()] });
    expect(rows(wrapper)[0]!.find("img.y-caps__thumb").attributes("src")).toBe("");
  });
});

it('shows the unlistable camera medium without a fabricated zero count or board actions', () => {
  const { wrapper } = panel({ camera: 'pocket', destination: 'camera', listing: 'unavailable', captures: [], reason: 'Files stay on the camera card; listing and download are unavailable.' });
  expect(wrapper.text()).toContain("the camera's card");
  expect(wrapper.text()).toContain('Files stay on the camera card');
  expect(wrapper.text()).not.toContain('0 saved');
  expect(wrapper.text()).not.toContain('Nothing saved to this board');
  expect(wrapper.text()).not.toContain('deleting is immediate');
  expect(wrapper.findAll('button, a, img, video')).toHaveLength(0);
  wrapper.unmount();
});
