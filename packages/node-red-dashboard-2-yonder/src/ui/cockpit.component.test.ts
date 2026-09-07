// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import YonderAim from "./YonderAim.vue";
import YonderDeck from "./YonderDeck.vue";
import YonderPicture from "./YonderPicture.vue";
import YonderStateOverlay from "./YonderStateOverlay.vue";
import YonderThumbStrip from "./YonderThumbStrip.vue";

/**
 * **R-UI-28, as a page rather than as a component** — *the picture and the
 * aim panel work without the deck. They are shown on the Cockpit, and depend
 * on nothing the camera page draws around them.*
 *
 * `picture.component.test.ts` and `aim.component.test.ts` each prove their
 * own instrument mounts alone. Neither proves the *pair* does, and the thing
 * R-UI-28 is actually about is a page: two widgets, one store, the messages
 * the shipped flow puts on that store and nothing else on it. The Cockpit
 * (`flows/flows.json`, `page-cockpit`) is that page; this is the same claim
 * without a browser.
 *
 * **The store is the page.** Dashboard delivers every message into
 * `$store.state.data.messages[<node id>]`, so a store carrying exactly two
 * entries — `pic-cockpit` and `aim-cockpit` — is the whole of what these two
 * instruments can see of each other and of anything else. No deck message is
 * put on it, and no `YonderDeck` is mounted: anything either instrument needs
 * from one has nowhere to come from here, which is exactly the failure this
 * file exists to produce.
 *
 * **The payloads are the flow's own.** `pick-cam-picture` composes
 * `{ path, cost, running }` and moves `recording`, `cameras`, `downlink` and
 * `aim` on to it; `pick-cam-aim` passes the daemon's `aim` object through
 * unchanged to the panel — the *same object*, so the picture's drag layer
 * and the panel beside it can never disagree about one gimbal; `cam-caps-saved` is a
 * second message on the picture's id carrying `{ saved }`. Those, and the
 * daemon's own answer to the picture's viewer report, are every channel this
 * page has. A field invented here that no node sends would prove nothing
 * about the page, so where one is used it is named as such below.
 *
 * **Two pictures are never mounted at once.** Dashboard renders one page at a
 * time, so the Cockpit's picture and the Camera page's are never both alive —
 * the Cockpit adds no second stills subscription and no second WHEP session.
 * That is asserted here (`one page at a time`) rather than assumed, because
 * the wiring makes both widgets a target of the same read and the cost of
 * being wrong about it is a doubled uplink nobody would see on either page.
 */

const OFFER = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n(offer)\r\n";
const ANSWER = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n(answer)\r\n";

/** The two node ids the Cockpit's widgets carry in `flows/flows.json`. */
const PICTURE_ID = "pic-cockpit";
const AIM_ID = "aim-cockpit";

/** `x-yonder-viewer`, this suite's own copy — see `picture.component.test.ts`
 * on why that constant is not imported from anywhere. */
const VIEWER_HEADER = "x-yonder-viewer";

/** Every `POST /video/<path>/report` — the picture's own channel to the
 * daemon, and the only one that does not go through a flow. */
const reportCalls: { path: string; body: unknown }[] = [];

/** What the daemon answers a report with: this browser's own preview state
 * (§8.2). It is how the state overlay reaches a picture at all — a message
 * through the flow is broadcast to every browser, and the state is one
 * viewer's. Nothing the camera page draws is in that path. */
let reportAnswer = "{}";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const fetchMock = vi.fn(async (url: string, init: unknown) => {
  const report = /^\/video\/([^/]+)\/report$/.exec(url);
  if (report) {
    reportCalls.push({ path: report[1]!, body: JSON.parse(String((init as { body?: string })?.body ?? "{}")) });
    return { ok: true, status: 200, text: async () => reportAnswer, headers: { get: () => null } };
  }
  if (/\/still\?/.test(url)) {
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([JPEG], { type: "image/jpeg" }),
      text: async () => "",
      headers: { get: () => "0" },
    };
  }
  return {
    ok: true,
    status: 201,
    text: async () => ANSWER,
    headers: { get: (name: string) => (name.toLowerCase() === VIEWER_HEADER ? "viewer-1" : null) },
  };
});

/** The browser's half of a WHEP session, reduced to what the picture uses —
 * `picture.component.test.ts`'s own fake, trimmed to what this file drives. */
class FakePeerConnection {
  static made: FakePeerConnection[] = [];
  connectionState = "new";
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  transceivers: unknown[] = [];
  statsReport: Map<string, unknown> = new Map();

  constructor() {
    FakePeerConnection.made.push(this);
  }

  addTransceiver(kind: string, init: unknown): void {
    this.transceivers.push({ kind, init });
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: OFFER };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {
    if (this.closed) {
      const error = new Error("closed");
      error.name = "InvalidStateError";
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  async getStats(): Promise<Map<string, unknown>> {
    return this.statsReport;
  }
}

/** The daemon's `aim` object, as `pick-cam-aim` passes it through. */
function aimReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "present",
    reason: "",
    pan: 12.4,
    tilt: -6,
    bounds: { pan: [-180, 180], tilt: [-90, 90] },
    atLimit: { pitch: false, yaw: false },
    mode: "Follow",
    modes: ["Follow", "Tilt lock", "FPV"],
    inhibited: null,
    ...overrides,
  };
}

/** What `pick-cam-picture` composes, field for field. */
function pictureMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "cam0",
    cost: "2.07 Mb/s while watched",
    running: true,
    recording: { recording: true, since: Date.now() - 64_000, destination: "board" },
    cameras: [
      { id: "cam0", name: "Nose", active: true, ageSeconds: 0, thumbSrc: null, stopped: false },
      { id: "cam1", name: "Tail", active: false, ageSeconds: 4, thumbSrc: "/video/cam1/still?at=1", stopped: false },
    ],
    downlink: "12 kb/s of stills · counted in Path total",
    // L-17: `pick-cam-picture` moves the daemon's `aim` on to the picture
    // unchanged, so the drag layer and its hint arm from this page's own
    // message. `flows.test.ts` holds the move; this is what it carries.
    aim: { state: "present", pan: 12.4, tilt: -6 },
    ...overrides,
  };
}

/**
 * The Cockpit: two widgets, one store, and nothing between them.
 *
 * One `emit` spy for both, deliberately — `$socket.emit('widget-action', id,
 * msg)` carries the node id, so a shared spy is what proves each instrument's
 * press leaves under its *own* id rather than the other's.
 */
function mountCockpit(picture: unknown = pictureMessage(), aim: unknown = aimReport()) {
  const emit = vi.fn();
  const messages = reactive<Record<string, { payload?: unknown }>>({
    [PICTURE_ID]: { payload: picture },
    [AIM_ID]: { payload: aim },
  });
  const store = { state: { data: { messages } } };
  const global = {
    provide: { $socket: { emit }, $dataTracker: () => {} },
    mocks: { $store: store },
  };
  const pic = mount(YonderPicture, {
    props: { id: PICTURE_ID, props: { path: "", label: "", stillsAfterMs: 12_000, cost: "" } },
    global,
  });
  const aimPanel = mount(YonderAim, { props: { id: AIM_ID, props: {} }, global });
  /** A further message on one widget's id, the way a second flow node
   *  (`cam-caps-saved`, `cam-rate-full`) delivers one. */
  const send = async (id: string, payload: unknown): Promise<void> => {
    messages[id] = { payload };
    await nextTick();
    await settle();
  };
  return { pic, aim: aimPanel, emit, send };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await nextTick();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** Emissions from one widget, in order — the id is the discriminator. */
function sentBy(emit: ReturnType<typeof vi.fn>, id: string): unknown[] {
  return emit.mock.calls.filter(([event, from]) => event === "widget-action" && from === id).map(([, , msg]) => msg);
}

function dial(w: VueWrapper<any>): Element {
  return w.find(".y-aim__dial").element;
}

const CENTER = 59;
const VIEWBOX = 118;
const DIAL_SIZE = 132;

/** `aim.component.test.ts`'s own pointer helpers, for the same three jsdom
 * traps that file's header documents at length. */
function point(type: string, xSvg: number, ySvg: number): PointerEvent {
  return new PointerEvent(type, {
    clientX: ((xSvg + CENTER) / VIEWBOX) * DIAL_SIZE,
    clientY: ((ySvg + CENTER) / VIEWBOX) * DIAL_SIZE,
    pointerId: 1,
    bubbles: true,
    cancelable: true,
  });
}

let objectUrls = 0;

beforeEach(() => {
  vi.useFakeTimers();
  FakePeerConnection.made.length = 0;
  fetchMock.mockClear();
  reportCalls.length = 0;
  reportAnswer = "{}";
  objectUrls = 0;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => `blob:still-${++objectUrls}`;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe("the Cockpit is the picture and the aim panel, and there is no deck", () => {
  it("mounts both from their own two messages, with no deck in either tree", async () => {
    const { pic, aim } = mountCockpit();
    await settle();

    // Drawn, not merely mounted without throwing: the frame the video sits
    // in, and the dial an operator slews with.
    expect(pic.find(".y-pic__frame").exists()).toBe(true);
    expect(pic.find(".y-pic__badge").text()).toBe("live · preview");
    expect(aim.find(".y-aim__dial").exists()).toBe(true);
    expect(aim.find(".y-col__legend").text()).toBe("Aim");

    // And no deck, by component and by the class its root wears — a page
    // that quietly needed one would have to draw it somewhere.
    for (const w of [pic, aim]) {
      expect(w.findComponent(YonderDeck).exists()).toBe(false);
      expect(w.find(".y-deck").exists()).toBe(false);
      expect(w.find('[class*="yonder-deck"]').exists()).toBe(false);
    }
  });

  /**
   * The store holds two entries and neither instrument reads the other's.
   *
   * This is the mechanical form of "depends on nothing the camera page draws
   * around them": were either reaching for a sibling's message it would have
   * to name a node id, and there are only two on this page.
   */
  it("reads only its own entry in the store", async () => {
    const { pic, aim } = mountCockpit();
    await settle();

    // The aim panel's own report, moved on to the *picture's* id: if the
    // picture were reading the page's store rather than its own message,
    // this is where a second panel would appear.
    expect(pic.findComponent(YonderAim).exists()).toBe(false);
    // And the reverse: the picture's strip is nowhere in the aim panel.
    expect(aim.findComponent(YonderThumbStrip).exists()).toBe(false);
  });
});

describe("the picture draws every part of itself from its own message", () => {
  it("draws the thumb strip, the REC pill, the foot strip and the cost from pick-cam-picture's own payload", async () => {
    const { pic } = mountCockpit();
    await settle();

    const strip = pic.findComponent(YonderThumbStrip);
    expect(strip.exists()).toBe(true);
    expect(strip.props("cameras")).toHaveLength(2);
    expect(strip.text()).toContain("OTHER CAMERAS");
    expect(strip.text()).toContain("12 kb/s of stills · counted in Path total");
    // The elapsed time is counted here from the board's own `since`.
    expect(pic.find(".y-pic__rec").text()).toContain("00:01:04");
    expect(pic.find(".y-pic__cost").text()).toBe("2.07 Mb/s while watched");
  });

  /**
   * **The state overlay reaches this page without a flow message at all.**
   *
   * The preview state is per viewer (§8.2) and a flow message is broadcast to
   * every browser, so the only channel that can carry *this* browser's state
   * is the daemon's answer to its own report. That channel is the picture's
   * alone — no deck, no rail, no node on the camera page is in it — which is
   * why the overlay is the strongest single piece of evidence for R-UI-28.
   */
  it("wears the daemon's answer to its own report, with nothing on the page in the path", async () => {
    reportAnswer = JSON.stringify({
      mine: { delivery: "video", interval: 5_000, frameAge: 0 },
      overlay: {
        head: "adaptive", size: "1280×720", rate: "15 fps", bitrate: "1.8 Mb/s",
        detail: "1.8 of 0.3–2.0 Mb/s", step: "", cost: {},
      },
    });
    const { pic } = mountCockpit();
    await settle();
    expect(pic.findComponent(YonderStateOverlay).exists()).toBe(false);

    // Two ticks: the first is a baseline, the second is the first report
    // with a rate to state — and its answer is this browser's own state.
    pc().statsReport = stats(125_000);
    await advance(1_000);
    pc().statsReport = stats(250_000);
    await advance(1_000);

    const overlay = pic.findComponent(YonderStateOverlay);
    expect(overlay.exists()).toBe(true);
    expect(overlay.props("head")).toBe("adaptive");
    expect(overlay.text()).toContain("1280×720");
    expect(reportCalls.map((c) => c.path)).toContain("cam0-preview");
  });

  /**
   * The SAVED banner, from `cam-caps-saved` — a second flow node onto the
   * same widget id, and the only kind of second message this page has.
   */
  it("flashes and names where a still went, from cam-caps-saved's own message", async () => {
    const { pic, send } = mountCockpit();
    await settle();
    expect(pic.find(".y-pic__saved").exists()).toBe(false);

    await send(PICTURE_ID, { saved: { at: Date.now(), held: "board", to: "this board" } });
    expect(pic.find(".y-pic__flash").exists()).toBe(true);
    expect(pic.find(".y-pic__saved").text()).toContain("this board");
  });

  /**
   * The Start key, which is the one action this instrument draws itself
   * (R-UI-10's own exception, argued in `YonderPicture.vue`) — and the whole
   * of what the Cockpit can do to a stopped camera, since there is no rail
   * here carrying START.
   */
  it("offers Start on a stopped camera, and the press leaves under the Cockpit picture's own id", async () => {
    const { pic, emit, send } = mountCockpit(pictureMessage({ running: false }));
    await settle();

    expect(pic.find(".y-pic__stopped").text()).toContain("This camera is not running");
    await pic.find(".y-pic__start").trigger("click");
    expect(sentBy(emit, PICTURE_ID)).toEqual([{ payload: "start" }]);
    expect(sentBy(emit, AIM_ID)).toEqual([]);

    // And it goes away when the camera runs, rather than persisting from the
    // message that first said it was stopped.
    await send(PICTURE_ID, pictureMessage({ running: true }));
    expect(pic.find(".y-pic__stopped").exists()).toBe(false);
  });

  /** A press on a thumbnail — the Cockpit's only other action on the picture,
   *  and the message `cam-pic-act`'s `hask path` rule answers. */
  it("switches camera from the strip, under its own id", async () => {
    const { pic, emit } = mountCockpit();
    await settle();
    await pic.findComponent(YonderThumbStrip).vm.$emit("go", "cam1");
    await settle();
    expect(sentBy(emit, PICTURE_ID)).toEqual([{ payload: { path: "cam1" } }]);
  });

  /**
   * **The drag layer, and the wiring that arms it** (L-17, R-UI-28).
   *
   * `aimable` is `payload.aim.state === 'present'` on the picture's *own*
   * message — the picture reads nothing of the deck's for it, which is what
   * R-UI-28 asks.
   *
   * It used to read nothing at all: `pick-cam-picture` composed
   * `{ path, cost, running }` and moved `recording`, `cameras` and
   * `downlink`, and `payload.aim` went only to `pick-cam-aim`. So the layer
   * was dark on the Camera page and on this one alike — a gesture built,
   * tested, and reachable from nowhere. The test that recorded that is this
   * one, inverted: the flow now carries `aim` on the same scratch move
   * `strip` uses, so the message this page actually receives arms the layer.
   *
   * `pictureMessage()` is that message, field for field, and it carries
   * `aim` because `flows/flows.json` does — `flows.test.ts` is what holds
   * the two together.
   */
  it("draws the orb on a drag, on the message the flow actually sends", async () => {
    const { pic } = mountCockpit();
    await settle();

    const frame = pic.find(".y-pic__frame").element;
    expect(pic.find(".y-pic__frame").classes()).toContain("is-aiming");
    frame.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10, pointerId: 9, bubbles: true }));
    frame.dispatchEvent(new PointerEvent("pointermove", { clientX: 60, clientY: 10, pointerId: 9, bubbles: true }));
    await nextTick();
    expect(pic.find(".y-pic__orb").exists()).toBe(true);
  });

  /**
   * L-17 — and the hint the layer's affordance is, on this page too. The
   * Cockpit's picture is fed by the same `pick-cam-picture` the Camera
   * page's is, which is the whole reason the move was made there and not on
   * either page's own node.
   */
  it("draws the slew hint here, from the same message", async () => {
    const { pic } = mountCockpit();
    await settle();
    expect(pic.find(".y-pic__hint").text()).toBe("Drag to slew · release to stop");
  });

  it("draws no drag layer where the camera has no gimbal", async () => {
    // The bench fixture's own answer, and the board's: no aim, no layer, no
    // hint. Correct, and not the same thing as a message that never carried
    // the field.
    const { pic } = mountCockpit(pictureMessage({ aim: { state: "not-offered" } }));
    await settle();
    expect(pic.find(".y-pic__frame").classes()).not.toContain("is-aiming");
    expect(pic.find(".y-pic__hint").exists()).toBe(false);
  });
});

describe("every aim control draws and emits, with no deck beside it", () => {
  it("draws the dial, both gauges and the badge from pick-cam-aim's own payload", async () => {
    const { aim } = mountCockpit(pictureMessage(), aimReport({ pan: 90, tilt: -45 }));
    await settle();
    expect(aim.find(".y-aim__dial").exists()).toBe(true);
    expect(gauge(aim, "Pan").text()).toContain("90.0");
    expect(gauge(aim, "Tilt").text()).toContain("-45.0");
    expect(aim.find(".y-col__q").text()).toBe("RATE CONTROL");
    expect(aim.find(".y-aimpanel__rate").exists()).toBe(true);
  });

  it("relays a slew and its stop through the Cockpit aim panel's own id", async () => {
    const { aim, emit } = mountCockpit();
    await settle();
    const el = dial(aim);
    el.dispatchEvent(point("pointerdown", 20, 0));
    el.dispatchEvent(point("pointermove", 40, 0));
    el.dispatchEvent(new Event("pointerup", { bubbles: true, cancelable: true }));

    const sent = sentBy(emit, AIM_ID) as { payload: Record<string, unknown> }[];
    expect(sent.some((m) => m.payload.slew), "no slew left the panel").toBe(true);
    expect(sent.some((m) => m.payload.stop), "the release sent no stop").toBe(true);
    expect(sentBy(emit, PICTURE_ID)).toEqual([]);
  });

  it("changes the gimbal mode and recentres, each under its own id", async () => {
    const { aim, emit } = mountCockpit();
    await settle();
    await aim.findAll(".y-seg__opt").find((b) => b.text() === "FPV")!.trigger("click");
    expect(sentBy(emit, AIM_ID)).toEqual([{ payload: { mode: "FPV" } }]);

    await aim.find(".y-aimpanel__recentre").trigger("click");
    expect(sentBy(emit, AIM_ID)).toEqual([{ payload: { mode: "FPV" } }, { payload: { recentre: true } }]);
    expect(sentBy(emit, PICTURE_ID)).toEqual([]);
  });

  it("collapses to one fact line on a camera with no gimbal, and still draws the picture beside it", async () => {
    // The gate's own fixture: a camera that answers `aim: none`. The page
    // must be a picture with a one-line panel beside it, not a broken half.
    const { pic, aim } = mountCockpit(pictureMessage(), aimReport({ state: "not-offered", reason: "" }));
    await settle();
    expect(aim.find(".y-aimpanel__fact-v").text()).toBe("this camera has none");
    expect(aim.find(".y-aim__dial").exists()).toBe(false);
    expect(pic.find(".y-pic__frame").exists()).toBe(true);
  });
});

describe("one page at a time", () => {
  /**
   * The Cockpit's picture and the Camera page's are wired from the same
   * change nodes, so both are a target of one read — but Dashboard renders
   * one page at a time and only the mounted picture negotiates or subscribes.
   * Asserted rather than assumed: the cost of being wrong is two WHEP
   * sessions and two stills subscriptions for one operator, on an uplink
   * where that is the whole budget, and neither page would look wrong.
   */
  it("negotiates once and subscribes to the other cameras' stills once, however many pictures the flow feeds", async () => {
    const { pic } = mountCockpit();
    await settle();

    expect(FakePeerConnection.made).toHaveLength(1);
    // One `stills` subscription: the other running camera, and only it.
    expect(wants("cam1")).toEqual(["stills"]);
    expect(wants("cam0")).toEqual([]);

    // Navigating away lets go of both — the uplink stops costing now rather
    // than at the daemon's next idle sweep.
    pic.unmount();
    expect(wants("cam1")).toEqual(["stills", "off"]);
    expect(wants("cam0")).toEqual(["off"]);
    expect(pcAt(0).closed).toBe(true);
  });
});

/** The strip's subscriptions for one camera, in order. */
function wants(camera: string): unknown[] {
  return reportCalls.filter((c) => c.path === camera).map((c) => (c.body as { want?: unknown }).want);
}

function pc(): FakePeerConnection {
  return pcAt(0);
}

function pcAt(index: number): FakePeerConnection {
  const made = FakePeerConnection.made[index];
  if (!made) throw new Error(`no peer connection ${index} was made`);
  return made;
}

/** One `getStats()` reading, at a given cumulative byte count. */
function stats(bytesReceived: number): Map<string, unknown> {
  return new Map<string, unknown>([
    ["inbound1", {
      type: "inbound-rtp", kind: "video",
      packetsLost: 0, packetsReceived: 1000, bytesReceived,
      frameWidth: 1280, frameHeight: 720, framesPerSecond: 30,
    }],
    ["pair1", {
      type: "candidate-pair", state: "succeeded",
      currentRoundTripTime: 0.05, availableIncomingBitrate: 4_000_000,
    }],
  ]);
}

/** A `YonderPositionGauge` by its own label — `aim.component.test.ts`'s idiom. */
function gauge(w: VueWrapper<any>, label: string) {
  const blocks = w.findAll(".y-pg");
  const match = blocks.find((b) => b.find(".y-pg__label").text() === label);
  if (!match) throw new Error(`no .y-pg labelled "${label}" among ${blocks.length} found`);
  return match;
}
