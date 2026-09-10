// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import YonderPicture from "./YonderPicture.vue";
import YonderStateOverlay from "./YonderStateOverlay.vue";
import YonderThumbStrip from "./YonderThumbStrip.vue";

/**
 * `YonderPicture` is the most behavioural thing on the console, and none of
 * its behaviour can be seen by looking at what it draws once.
 *
 * It owns a mode machine, a twelve-second deadline, a reconnect loop with
 * backoff, a degrade that is a function of elapsed time, and a teardown that
 * has to close a peer connection. Every one of those is a decision, and
 * `nodes.test.ts` explains why the seven read-only instruments beside it are
 * exempt from a test like this one and it is not.
 *
 * **What is stubbed, and why that is honest.** `RTCPeerConnection` does not
 * exist in this environment and is not what is under test: what is under test
 * is what this component does with an offer, an answer, a track and a failed
 * connection, so the fake below records the calls and hands back the events a
 * media server would. `fetch` is stubbed for the same reason, and the URL it
 * was called with is asserted — that is what proves the preview path is the
 * default rather than an intention stated in a comment.
 *
 * Timers are faked throughout. A twelve-second fall-back and a fifteen-second
 * backoff cannot be waited on by a test suite, and a suite that waited on
 * them would be a suite nobody runs.
 */

const OFFER = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n(offer)\r\n";
const ANSWER = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n(answer)\r\n";
const PATH = "cam0-preview";
const LABEL = "Nose";

/** This suite's own copy of `VIEWER_HEADER` — see the component's own doc
 * comment on why that constant is not imported from anywhere. */
const VIEWER_HEADER = "x-yonder-viewer";

/**
 * What the media server is answering with on the next negotiation.
 *
 * `"gated"` answers nothing until a test says so, which is the only way to
 * hold a handshake open across the thing that abandons it. `viewerHeader` is
 * this session's own answer to `VIEWER_HEADER` — present by default, as a
 * real console's would be, so a test that does not care about reporting
 * still gets a realistic handshake; `undefined` is what an older console's
 * handshake looked like, before this task.
 */
let reply: { status: number; sdp?: string; viewerHeader?: string } | "throws" | "gated" =
  { status: 201, sdp: ANSWER, viewerHeader: "viewer-1" };

/** Handshakes the media server has not answered yet, in the order they were made. */
const gates: ((answer: { status: number; sdp?: string; viewerHeader?: string }) => void)[] = [];

/** Every `POST /video/<path>/report` this suite's fake `fetch` received, in
 * the order it received them — the path reported on and the parsed body. */
const reportCalls: { path: string; body: unknown }[] = [];

/** Whether the next `/report` post this fake `fetch` sees succeeds, or fails
 * the way a dropped connection would — silently, from `sendReport`'s own
 * point of view, and never as a `reason` on screen. */
let reportOutcome: "ok" | "fails" = "ok";
let reportState: unknown = {};

const fetchMock = vi.fn(async (url: string, init: unknown) => {
  // A viewer's own report, and the handshake, are two different exchanges
  // over the identical global `fetch` this suite stubs once — branched on
  // the URL the real `sendReport`/`connect` each build, exactly as a real
  // browser's network layer would tell the two apart.
  const report = /^\/video\/([^/]+)\/report$/.exec(url);
  if (report) {
    const body: unknown = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}"));
    reportCalls.push({ path: report[1]!, body });
    if (reportOutcome === "fails") throw new TypeError("Failed to fetch");
    return { ok: true, status: 200, text: async () => "{}", json: async () => reportState, headers: { get: () => null } };
  }
  if (reply === "throws") throw new TypeError("Failed to fetch");
  // A gated request answers when a test says so — or rejects with
  // `AbortError`, which is what a real `fetch` does the moment its signal is
  // aborted, and which lands in `connect()`'s catch.
  const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
  const answered = reply === "gated"
    ? await new Promise<{ status: number; sdp?: string; viewerHeader?: string }>((resolve, reject) => {
      gates.push(resolve);
      signal?.addEventListener("abort", () => {
        const aborted = new Error("The user aborted a request.");
        aborted.name = "AbortError";
        reject(aborted);
      });
    })
    : reply;
  const { status, sdp, viewerHeader } = answered;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => sdp ?? "",
    headers: { get: (name: string) => (name.toLowerCase() === VIEWER_HEADER ? viewerHeader ?? null : null) },
  };
});

/**
 * The browser's half of a WHEP session, reduced to what this component uses.
 *
 * `close()` sets the state and fires nothing, as the real one does — a test
 * that leant on `close()` raising a connection-state change would be leaning
 * on something browsers do not do.
 */
class FakePeerConnection {
  static made: FakePeerConnection[] = [];
  connectionState = "new";
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  local: unknown = null;
  remote: unknown = null;
  transceivers: Array<{ kind: string; init: unknown }> = [];
  /** What `getStats()` answers with next — set by `report()`, below, before
   * a test advances the clock a tick. Never consumed automatically: a real
   * `RTCStatsReport` does not change under its own reader, so this fake
   * holds whatever a test last set until the test sets it again. */
  statsReport: Map<string, unknown> = new Map();
  /** Made to reject the way a real `getStats()` on a connection torn down
   * mid-call might. */
  statsFail = false;

  constructor() {
    FakePeerConnection.made.push(this);
  }

  addTransceiver(kind: string, init: unknown): void {
    this.transceivers.push({ kind, init });
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: OFFER };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    this.local = description;
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    // A real one rejects with `InvalidStateError` once it has been closed, and
    // that rejection is what an abandoned handshake used to turn into a fault
    // on screen and a reconnect over the session that replaced it.
    if (this.closed) {
      const error = new Error("cannot set remote description on a closed connection");
      error.name = "InvalidStateError";
      throw error;
    }
    this.remote = description;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  /**
   * The *negotiation* adding the track, which is all `ontrack` is.
   *
   * It fires before any media flows, and a browser that never receives a
   * frame fires it exactly the same way — which is why this alone must not
   * make the picture look alive. `frames()` below is the other half.
   */
  deliverTrack(stream: unknown = { id: "stream-1" }): void {
    this.ontrack?.({ streams: [stream] });
  }

  /** The link going away under it. */
  goes(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** The `Map`-like object `RTCStatsReport` really is (it supports `forEach`
   * and `values()`) — a plain `Map` satisfies that without a hand-rolled
   * stand-in. */
  async getStats(): Promise<Map<string, unknown>> {
    if (this.statsFail) throw new Error("could not read statistics");
    return this.statsReport;
  }
}

/**
 * One `getStats()` reading: the succeeded candidate pair actually carrying
 * the inbound video, and the inbound-rtp entry for it — realistic values a
 * report can be built from, with each individually overridable so a test can
 * move exactly the counter it means to. Named apart from `pc().statsReport`
 * (what this becomes) and from `fetchMock`'s own local `report` (the regex
 * match on a `/report` URL) so the three cannot be misread for one another.
 */
function fakeStats (over: { inbound?: Record<string, unknown>; pair?: Record<string, unknown> } = {}): Map<string, unknown> {
  return new Map<string, unknown>([
    ["inbound1", {
      type: "inbound-rtp", kind: "video",
      packetsLost: 0, packetsReceived: 1000, bytesReceived: 125_000,
      frameWidth: 1280, frameHeight: 720, framesPerSecond: 30,
      ...over.inbound,
    }],
    ["pair1", {
      type: "candidate-pair", state: "succeeded",
      currentRoundTripTime: 0.05, availableIncomingBitrate: 4_000_000,
      ...over.pair,
    }],
  ]);
}

function mountPicture(props: Record<string, unknown> = {}) {
  const emit = vi.fn();
  const wrapper = mount(YonderPicture, {
    props: {
      id: "n1",
      props: { path: PATH, label: LABEL, stillsAfterMs: 12_000, ...props },
    },
    global: {
      provide: { $socket: { emit }, $dataTracker: () => {} },
      // Dashboard always installs a store; declaring it absent is the state
      // before any message has arrived, and stops Vue warning about a property
      // that was never defined.
      mocks: { $store: undefined },
    },
  });
  return { wrapper, emit };
}

/**
 * The same picture with the rail's message on it.
 *
 * A soft key's press travels to Node-RED and comes back as a message — the
 * only path a *separate* widget has to this one. `store.state.data.messages`
 * is where Dashboard puts it, so a test that set a prop instead would be
 * testing a path the console does not have.
 */
function mountWithRail(payload?: unknown) {
  const emit = vi.fn();
  // Reactive, because Dashboard's own store is: a plain object here would
  // never re-run the watcher and the test would pass or fail for a reason that
  // has nothing to do with the component.
  const messages = reactive<Record<string, { payload?: unknown }>>({ n1: { payload } });
  const wrapper = mount(YonderPicture, {
    props: { id: "n1", props: { path: PATH, label: LABEL, stillsAfterMs: 12_000 } },
    global: {
      provide: { $socket: { emit }, $dataTracker: () => {} },
      mocks: { $store: { state: { data: { messages } } } },
    },
  });
  const press = async (value: unknown): Promise<void> => {
    messages.n1 = { payload: value };
    await nextTick();
    await settle();
  };
  return { wrapper, emit, press };
}

/**
 * Drain the microtask queue and let Vue render.
 *
 * `connect()` is a chain of awaits — offer, local description, fetch, remote
 * description — none of which touches a timer, so advancing the clock alone
 * would not run them.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await nextTick();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function badge(wrapper: VueWrapper): string {
  return wrapper.find(".y-pic__badge").text();
}

/**
 * The picture actually painting.
 *
 * `timeupdate` is the media clock advancing, which every browser fires as a
 * playing `<video>` renders and stops firing the moment it stops. It is the
 * component's only source for *when the last frame arrived*, and the reason
 * this helper exists at all: the suite used to mistake `deliverTrack()` — a
 * negotiation event — for a picture, and the passage of time for the loss of
 * one.
 */
function frames(wrapper: VueWrapper, count = 1): void {
  for (let i = 0; i < count; i += 1) {
    wrapper.find("video").element.dispatchEvent(new Event("timeupdate"));
  }
}

/** What the `<video>` is holding, if anything. */
function painted(wrapper: VueWrapper): unknown {
  return (wrapper.find("video").element as HTMLVideoElement & { srcObject: unknown }).srcObject;
}

function pc(index = 0): FakePeerConnection {
  const made = FakePeerConnection.made[index];
  if (!made) throw new Error(`no peer connection ${index} was made`);
  return made;
}

/** The reason line, or "" when the component is not showing one. */
function reasonText(wrapper: VueWrapper): string {
  const el = wrapper.find(".y-pic__reason");
  return el.exists() ? el.text() : "";
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-yonder-camera-auth");
  document.documentElement.removeAttribute("data-yonder-auth-check");
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  FakePeerConnection.made.length = 0;
  gates.length = 0;
  fetchMock.mockClear();
  reply = { status: 201, sdp: ANSWER, viewerHeader: "viewer-1" };
  reportCalls.length = 0;
  reportOutcome = "ok";
  reportState = {};
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("fetch", (url: string, init: unknown) => url === "/session" ? Promise.resolve({ ok: true, status: 200 }) : fetchMock(url, init));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("asking for the picture", () => {
  it('starts muted playback when the negotiated track arrives', async () => {
    const { wrapper } = mountPicture(); await settle();
    pc().deliverTrack(); await settle();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(wrapper.find('video').element.muted).toBe(true);
  });
  it('does not call a wall-clock correction a loss of media', async () => {
    const { wrapper } = mountPicture(); await settle(); pc().deliverTrack(); frames(wrapper);
    vi.setSystemTime(Date.now() + 3600000);
    await advance(1000);
    expect(badge(wrapper)).toBe('live · preview');
  });
  it('offers a working resume action if the browser refuses autoplay', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('autoplay refused'));
    const { wrapper } = mountPicture(); await settle(); pc().deliverTrack(); await settle();
    expect(wrapper.get('.y-pic__resume').text()).toBe('Resume live video');
    await wrapper.get('.y-pic__resume').trigger('click'); await settle();
    expect(wrapper.find('.y-pic__resume').exists()).toBe(false);
  });
  it('uses presented-frame callbacks and ignores callbacks from a retired session', async () => {
    const { wrapper } = mountPicture(); await settle();
    const callbacks: Array<() => void> = [];
    const video = wrapper.find('video').element;
    video.requestVideoFrameCallback = vi.fn((cb: any) => { callbacks.push(cb); return callbacks.length; });
    video.cancelVideoFrameCallback = vi.fn();
    pc().deliverTrack(); await settle();
    callbacks[0](); await advance(4000);
    expect(badge(wrapper)).toBe('no contact');
    callbacks[1](); await settle();
    expect(badge(wrapper)).toBe('live · preview');
    setMode(wrapper,'off'); await settle();
    callbacks[2](); await settle();
    expect(badge(wrapper)).toBe('off');
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });
  it("asks the console's own route for the preview path", async () => {
    // Through the console's route, not straight at the media server: that is
    // what puts the picture behind the interface's credential (R-SEC-13).
    // And the path is the preview one — a component that asked for the
    // full-rate stream on mount would spend most of a field uplink the
    // moment somebody opened a page.
    const { wrapper } = mountPicture();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("/video/cam0-preview/whep");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/sdp");
    expect(init.body).toBe(OFFER);
    expect(badge(wrapper)).toBe("live · preview");
  });

  it("asks to receive video and nothing else", async () => {
    mountPicture();
    await settle();
    expect(pc().transceivers).toEqual([{ kind: "video", init: { direction: "recvonly" } }]);
  });

  it("takes the answer as the remote description", async () => {
    mountPicture();
    await settle();
    expect(pc().remote).toEqual({ type: "answer", sdp: ANSWER });
  });
});

describe("why there is no picture", () => {
  /**
   * A browser blocked by a network, a carrier discarding UDP and a camera
   * that has stopped producing frames all present as no picture, and only one
   * of them is worth walking outside for. The statuses are the ones
   * `whep.ts` actually returns.
   */
  it("401 says the session is not logged in", async () => {
    reply = { status: 401 };
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/sign in/i);
  });

  it("404 says the camera is not streaming, and where to start it", async () => {
    reply = { status: 404 };
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/not available/i);
  });

  it("503 says The video service is unavailable. Reconnecting automatically., and says nothing about the camera", async () => {
    // The camera is the 404 above — the media server answered, and said that
    // path has no publisher. This is the case where it did not answer at all,
    // and an operator sent to look at a camera that is fine has been sent the
    // wrong way.
    reply = { status: 503 };
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/video service/i);
    expect(reasonText(wrapper)).not.toMatch(/camera/i);
  });

  it("a browser that cannot negotiate at all says so, and is a fourth answer", async () => {
    reply = "throws";
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/browser/i);
  });

  it("the four reasons are four different sentences", async () => {
    const seen = new Set<string>();
    for (const next of [{ status: 401 }, { status: 404 }, { status: 503 }, "throws"] as const) {
      reply = next as typeof reply;
      document.documentElement.removeAttribute('data-yonder-camera-auth');
      const { wrapper } = mountPicture();
      await settle();
      seen.add(reasonText(wrapper));
      wrapper.unmount();
    }
    expect(seen.size).toBe(4);
  });
});

describe("the twelve-second fall-back to stills", () => {
  it("falls back when the negotiation succeeded and no frame ever arrived", async () => {
    // **The carrier discarding UDP**: the handshake completes over TCP, the
    // track is negotiated, and the media never comes. `ontrack` fires exactly
    // as it does on a working session, so a component that took it for a
    // picture would sit here for ever — which is what it did.
    const { wrapper } = mountPicture();
    await settle();
    pc().deliverTrack();
    await settle();

    await advance(11_999);
    expect(badge(wrapper)).toBe("live · preview");

    await advance(1);
    expect(badge(wrapper)).toBe("stills");
  });

  it("falls back when the negotiation never succeeds either", async () => {
    // The deadline is on the operator's request, not on one attempt. A
    // component that armed it only after a successful handshake would leave
    // the case that matters most — a camera that is not streaming — staring
    // at nothing for as long as the operator was willing to wait.
    reply = { status: 404 };
    const { wrapper } = mountPicture();
    await settle();

    await advance(12_000);
    expect(badge(wrapper)).toBe("stills");
    expect(reasonText(wrapper)).toMatch(/not available/i);

    // The old attempt is canceled. A fresh live attempt starts after a short
    // stills interval, so recovery does not require reloading the page.
    const attempts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/whep")).length;
    await advance(4999);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/whep"))).toHaveLength(attempts);
    reply = { status: 201, sdp: ANSWER };
    await advance(1);
    expect(badge(wrapper)).toBe('live · preview');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep'))).toHaveLength(attempts + 1);
    pc(FakePeerConnection.made.length - 1).deliverTrack(); frames(wrapper); await settle();
    expect(painted(wrapper)).not.toBeNull();
  });

  it.each(['off', 'stills'])('honors an explicit %s choice after automatic fallback', async mode => {
    const { wrapper } = mountPicture(); await settle();
    await advance(12000);
    setMode(wrapper, mode);
    const attempts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep')).length;
    await advance(60000);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep'))).toHaveLength(attempts);
    expect(badge(wrapper)).toBe(mode);
  });

  it('cancels automatic fallback recovery when the widget is removed', async () => {
    const { wrapper } = mountPicture(); await settle(); await advance(12000);
    const attempts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep')).length;
    wrapper.unmount(); await advance(60000);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep'))).toHaveLength(attempts);
  });

  it("does not fall back when a frame has arrived", async () => {
    const { wrapper } = mountPicture();
    await settle();
    await advance(1_000);
    pc().deliverTrack();
    frames(wrapper);
    await settle();

    // Frames keep arriving, as they do on a working link.
    for (let i = 0; i < 30; i += 1) { await advance(1_000); frames(wrapper); }
    expect(badge(wrapper)).not.toBe("stills");
  });

  it("points the stills at the configured source, and draws none when there is none", async () => {
    reply = { status: 404 };
    const withSource = mountPicture({ stillsUrl: "/stills/cam0.jpg" });
    await settle();
    await advance(12_000);
    expect(withSource.wrapper.find("img").attributes("src")).toBe("/stills/cam0.jpg");

    const without = mountPicture();
    await settle();
    await advance(12_000);
    expect(without.wrapper.find("img").exists()).toBe(false);
    expect(badge(without.wrapper)).toBe("stills");
  });
});

describe("reconnecting", () => {
  /** The deadline is pushed out of the way so the backoff can be seen alone. */
  const noFallback = { stillsAfterMs: 600_000 };

  it("waits longer between each attempt, and shows the count", async () => {
    reply = { status: 503 };
    const { wrapper } = mountPicture(noFallback);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(badge(wrapper)).toBe("reconnecting · attempt 1");

    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(badge(wrapper)).toBe("reconnecting · attempt 2");

    await advance(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await advance(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reconnects when the connection fails after it was established", async () => {
    const { wrapper } = mountPicture(noFallback);
    await settle();
    pc().deliverTrack();
    await settle();

    pc().goes("failed");
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(badge(wrapper)).toBe("reconnecting · attempt 1");
  });

  it("a picture that comes back clears the count and the reason", async () => {
    reply = { status: 503 };
    const { wrapper } = mountPicture(noFallback);
    await settle();
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    reply = { status: 201, sdp: ANSWER };
    await advance(2_000);
    pc(2).deliverTrack();
    frames(wrapper);
    await settle();

    expect(badge(wrapper)).toBe("live · preview");
    expect(reasonText(wrapper)).toBe("");
  });

  it("does not blank the picture it is reconnecting to replace", async () => {
    // A reconnect tears the session down and builds another. Letting go of
    // the `<video>` on the way through would delete the last frame between
    // attempts — the one thing still held, and the reason going black was
    // rejected in the first place. The age keeps running across it, because
    // the frame on screen is still as old as it was.
    const { wrapper } = mountPicture(noFallback);
    await settle();
    pc().deliverTrack();
    frames(wrapper);
    await settle();

    pc().goes("failed");
    await advance(5_000);

    expect(painted(wrapper)).toEqual({ id: "stream-1" });
    expect(wrapper.find(".y-pic__age").text()).toBe("3 s ago");
  });

  it("does not reconnect a picture that is off", async () => {
    // The guard that separates 'nobody asked for this' from 'the link went'.
    // Without it, turning the picture off leaves it negotiating for a stream
    // nobody is watching — which on a cellular uplink is most of the link.
    const { wrapper } = mountPicture(noFallback);
    await settle();
    const connection = pc();

    setMode(wrapper, "off");
    await settle();
    connection.goes("failed");
    await advance(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a failed abandoned connection while waiting to retry from stills", async () => {
    const { wrapper } = mountPicture();
    await settle();
    await advance(12_000);
    expect(badge(wrapper)).toBe("stills");
    const attempts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/whep")).length;

    pc(0).goes("failed");
    await advance(4999);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/whep"))).toHaveLength(attempts);
    await advance(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/whep'))).toHaveLength(attempts + 1);
  });

  /**
   * **A stale backoff must not survive into the request that supersedes
   * it.** This is M2's own headline failure — "the key dropped the picture
   * it was pressed for" — reached by a different route: not an operator
   * holding FULL RATE, but the ordinary case of a daemon slow to answer. A
   * failed first negotiation arms a retry; before it fires, the first
   * `camera-read` names the camera and the `streamPath` watcher calls
   * `requestLive()`, which connects and paints — and then the retry armed by
   * the *first* attempt fires anyway and tears the new session down.
   */
  it("does not let a stale backoff close the session the streamPath watcher just brought up", async () => {
    reply = { status: 503 };
    const { wrapper, press } = mountWithRail();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(badge(wrapper)).toBe("reconnecting · attempt 1");

    // Before the backoff above fires, the daemon's first read names the
    // camera. Nothing has advanced the clock yet, so that backoff — a full
    // 1000ms of it — is still pending underneath what happens next.
    reply = { status: 201, sdp: ANSWER };
    await press({ path: "nose" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pc(1).deliverTrack();
    frames(wrapper);
    await settle();
    expect(badge(wrapper)).toBe("live · preview");

    await advance(1_000);

    // Fixed: the stale timer was cleared, so it never fires, nothing tears
    // the session down, and no third negotiation happens.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pc(1).closed).toBe(false);
    expect(badge(wrapper)).toBe("live · preview");
  });
});

describe("the degrade, when contact goes", () => {
  /**
   * A picture that is negotiated **and painting**.
   *
   * The distinction is the whole of M1: every test in this block used to
   * deliver a track and then let the clock run, believing it was simulating
   * contact loss. It was simulating a working picture — and the component
   * agreed, because it counted from the handshake rather than from a frame. So
   * a healthy session read "no contact" at three seconds and was an
   * unreadable dark rectangle at a minute, and this suite asserted that as
   * correct.
   */
  async function live() {
    const mounted = mountPicture();
    await settle();
    pc().deliverTrack();
    frames(mounted.wrapper);
    await settle();
    return mounted;
  }

  /** Frames arriving once a second, which is what a working link looks like. */
  async function watching(wrapper: VueWrapper, seconds: number): Promise<void> {
    for (let i = 0; i < seconds; i += 1) {
      await advance(1_000);
      frames(wrapper);
    }
    await settle();
  }

  it("does not degrade a picture that is still arriving", async () => {
    // The one this component exists to get right, and the one it had wrong:
    // all four signals fired on every healthy session, which teaches an
    // operator to ignore all four inside a single flight.
    const { wrapper } = await live();
    await watching(wrapper, 90);

    expect(badge(wrapper)).toBe("live · preview");
    expect(wrapper.find(".y-pic__hatch").exists()).toBe(false);
    expect(wrapper.find(".y-pic__age").exists()).toBe(false);
    expect(wrapper.find("video").attributes("style")).toContain("filter: none");
  });

  it("starts counting from the last frame, not from the handshake", async () => {
    // Two minutes of good video, then the picture stops. The age is measured
    // from where it stopped, so an operator reads how long ago they lost it
    // rather than how long ago they opened the page.
    const { wrapper } = await live();
    await watching(wrapper, 120);
    await advance(5_000);

    expect(badge(wrapper)).toBe("no contact");
    expect(wrapper.find(".y-pic__age").text()).toBe("3 s ago");
  });

  it("holds the picture rather than blanking it", async () => {
    // Going black cannot be misread, and that is the whole of its appeal. It
    // also deletes the one thing still held: where the camera was pointing,
    // what was in shot, where the horizon was.
    const { wrapper } = await live();
    await advance(90_000);
    expect(wrapper.find("video").exists()).toBe(true);
    expect(painted(wrapper)).toEqual({ id: "stream-1" });
  });

  it("does not flinch at a two-second hiccup", async () => {
    const { wrapper } = await live();
    await advance(2_000);
    expect(wrapper.find(".y-pic__hatch").exists()).toBe(false);
    expect(wrapper.find("video").attributes("style")).toContain("filter: none");
  });

  it("desaturates, darkens, hatches and counts, all four at once", async () => {
    const { wrapper } = await live();
    await advance(5_000);

    expect(badge(wrapper)).toBe("no contact");
    expect(wrapper.find(".y-pic__hatch").exists()).toBe(true);
    expect(wrapper.find(".y-pic__age").text()).toBe("3 s ago");
    const style = wrapper.find("video").attributes("style") ?? "";
    expect(style).toContain("saturate(0.95)");
    expect(style).toContain("brightness(0.97)");
  });

  it("is barely readable, and counting in minutes, a minute later", async () => {
    const { wrapper } = await live();
    await advance(62_000);

    expect(wrapper.find(".y-pic__age").text()).toBe("1 min 0 s ago");
    const style = wrapper.find("video").attributes("style") ?? "";
    expect(style).toContain("saturate(0.00)");
    expect(style).toContain("brightness(0.35)");
  });

  it("says nothing about the aircraft's other outputs", async () => {
    // A console losing its own link says nothing whatever about the ground
    // station's feed. Claiming either way would be inventing a fact.
    const { wrapper } = await live();
    await advance(62_000);
    expect(wrapper.text()).not.toMatch(/ground station/i);
  });
});

describe("off is not the link being down", () => {
  it("reads 'not requested' in the neutral tone, and never 'no contact'", async () => {
    const { wrapper } = mountPicture();
    await settle();
    setMode(wrapper, "off");
    await settle();

    expect(badge(wrapper)).toBe("off");
    expect(wrapper.find(".y-pic__badge").classes()).toContain("tone-neutral");
    expect(wrapper.find(".y-pic__off").text()).toMatch(/preview is off/i);
    expect(wrapper.text()).not.toMatch(/no contact/i);
    expect(wrapper.find(".y-pic__hatch").exists()).toBe(false);
  });

  it("sends the mode change, so the flow knows what the operator asked for", async () => {
    const { wrapper, emit } = mountPicture();
    await settle();
    setMode(wrapper, "off");
    expect(emit).toHaveBeenCalledWith("widget-action", "n1", { payload: "mode:off", topic: LABEL });
  });

  it("closes the connection rather than watching a picture nobody asked for", async () => {
    const { wrapper } = mountPicture();
    await settle();
    setMode(wrapper, "off");
    expect(pc().closed).toBe(true);
  });

  it("lets go of the last live frame, rather than freezing it under 'off'", async () => {
    // **Closing a peer connection does not clear the screen.** It ends the
    // tracks, and a media element holding an ended stream goes on painting its
    // last decoded frame — so this left a frozen live picture up, in the
    // neutral tone, captioned "off", with no hatch, no age and no degrade,
    // because `staleFor` is zero outside live mode. A frozen frame with
    // nothing saying it is frozen is this component's whole hazard.
    const { wrapper } = mountPicture();
    await settle();
    pc().deliverTrack();
    frames(wrapper);
    await settle();
    expect(painted(wrapper)).toEqual({ id: "stream-1" });

    setMode(wrapper, "off");
    await settle();
    expect(painted(wrapper)).toBeNull();
  });

  it("lets go of it for stills too, which is where there is nothing to draw", async () => {
    // `picture.ts` records that nothing in this repository serves stills yet,
    // so the `<img>` is `v-if`'d away and the stale live frame showed through
    // it — badged "stills", in the *waiting* tone.
    const { wrapper } = mountPicture();
    await settle();
    pc().deliverTrack();
    frames(wrapper);
    await settle();

    await advance(30_000);
    expect(badge(wrapper)).not.toBe("stills");

    setMode(wrapper, "stills");
    await settle();
    expect(wrapper.find("img").exists()).toBe(false);
    expect(painted(wrapper)).toBeNull();
  });

  it("asking for live again starts the whole thing over", async () => {
    const { wrapper } = mountPicture();
    await settle();
    setMode(wrapper, "off");
    await settle();

    setMode(wrapper, "live");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(badge(wrapper)).toBe("live · preview");
  });
});

/**
 * **A handshake nobody is waiting for still finishes.**
 *
 * `connect()` captured its peer connection in a local and never looked at it
 * again, and the fetch carried no `AbortController` — so an exchange that had
 * been abandoned came back, called `setRemoteDescription()` on a closed
 * connection, and turned the `InvalidStateError` into a reason on screen and a
 * reconnect. The reconnect then tore down whatever session had replaced it.
 */
describe("a handshake that was abandoned while it was in flight", () => {
  it("does not tear down the session that replaced it", async () => {
    // Hold FULL RATE: the preview session is closed and the full-rate one
    // opens. The abandoned preview exchange answers afterwards, which is the
    // ordinary case — the key dropped the very picture it was pressed for.
    reply = "gated";
    const { wrapper, press } = mountWithRail();
    await settle();
    expect(gates).toHaveLength(1);

    await press("rate:full");
    expect(gates).toHaveLength(2);
    gates[1]({ status: 201, sdp: ANSWER });
    await settle();
    pc(1).deliverTrack();
    frames(wrapper);
    await settle();
    expect(badge(wrapper)).toBe("live · full rate");

    // Now the handshake nobody is waiting for finally answers.
    gates[0]({ status: 201, sdp: ANSWER });
    await advance(30_000);

    expect(reasonText(wrapper)).toBe("");
    expect(pc(1).closed).toBe(false);
    // No third negotiation: the backoff never armed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is not drawn as a fault under the off panel", async () => {
    // "Off is not the link being down, and must not look like it" — and this
    // path put *this browser could not negotiate a stream* underneath the
    // panel that says nothing is wrong.
    reply = "gated";
    const { wrapper } = mountPicture();
    await settle();

    setMode(wrapper, "off");
    gates[0]({ status: 201, sdp: ANSWER });
    await advance(30_000);

    expect(badge(wrapper)).toBe("off");
    expect(reasonText(wrapper)).toBe("");
    expect(wrapper.text()).not.toMatch(/no contact|could not negotiate/i);
  });

  it("ignores an answer that was already in hand when the operator let go", async () => {
    // **The abort cannot recall an answer already delivered.** The response
    // arrives, its continuation is queued, and the operator presses OFF before
    // it runs — so the check after the `await` is the only thing standing
    // between a 404 for a stream nobody wants any more and the words "this
    // camera is not streaming" printed under the panel that says nothing is
    // wrong.
    reply = "gated";
    const { wrapper } = mountPicture();
    await settle();

    gates[0]({ status: 404 });
    setMode(wrapper, "off");
    await advance(30_000);

    expect(badge(wrapper)).toBe("off");
    expect(reasonText(wrapper)).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request rather than leaving it in flight", async () => {
    // The identity check above is what makes a late answer harmless; this is
    // what stops the request being made at all once nobody wants it.
    reply = "gated";
    const { wrapper } = mountPicture();
    await settle();
    const [, init] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(init.signal.aborted).toBe(false);

    setMode(wrapper, "off");
    expect(init.signal.aborted).toBe(true);
  });
});

describe("teardown", () => {
  it("closes the peer connection", async () => {
    // A page navigated away from must not leave the aircraft sending to
    // nobody.
    const { wrapper } = mountPicture();
    await settle();
    const connection = pc();
    wrapper.unmount();
    expect(connection.closed).toBe(true);
  });

  it("stops reconnecting", async () => {
    reply = { status: 503 };
    const { wrapper } = mountPicture();
    await settle();
    wrapper.unmount();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** The mode is a method rather than a control: the page owns the keys. */
function setMode(wrapper: VueWrapper, mode: string): void {
  (wrapper.vm as unknown as { setMode(mode: string): void }).setMode(mode);
}

/** This browser's own attempt counter and report timer — internal state with
 * no element to read it from, exactly the reason `setMode` above reaches
 * into `wrapper.vm` directly rather than through the template. */
function internals(wrapper: VueWrapper): { attempt: number; reportTimer: unknown } {
  return wrapper.vm as unknown as { attempt: number; reportTimer: unknown };
}

/**
 * **Wiring up the rate controller's own inbox (R-VID-07, R-VID-11, R-VID-19).**
 *
 * Task 32 built the whole adaptation machine and proved it by tests and by
 * mutation; nothing fed it, because this component neither read
 * `VIEWER_HEADER` off the handshake nor called `RTCPeerConnection.getStats()`.
 * These are the tests for the half that was missing — this component's own
 * side of "wire it up so it runs on its own".
 *
 * `RTCPeerConnection.getStats()` does not exist in `jsdom`, and is not what
 * is under test: `FakePeerConnection.getStats()` returns whatever
 * `fakeStats()` a test last set on it, exactly the reason the suite's own
 * top-of-file comment gives for stubbing `RTCPeerConnection` at all. The
 * fake is deliberately the `Map` `RTCStatsReport` really is, not a
 * hand-rolled shape only this suite would recognise.
 */
describe("reporting what this browser is measuring", () => {
  it("captures no viewer id and reports nothing at all when the console never answers with one", async () => {
    // An older console's handshake: no `VIEWER_HEADER` at all.
    reply = { status: 201, sdp: ANSWER };
    const { wrapper } = mountPicture();
    await settle();
    // No timer at all — not merely one whose every tick declines to post.
    expect(internals(wrapper).reportTimer).toBeNull();

    pc().statsReport = fakeStats();
    await advance(1000);
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 999_999 } });
    await advance(5000);
    expect(reportCalls).toHaveLength(0);
  });

  /**
   * **The report says what this browser is watching, or the controller never
   * sees it.** `Viewers.report()` hands a measurement on to the rate
   * controller only while that viewer's `want` is `video`, and a subscription
   * the device opens on a report's behalf starts at `off`. So a report
   * carrying only a statistic is recorded against the viewer and goes no
   * further — the page's own state updates, which is what makes it look like
   * it arrived, while the controller goes on saying it has had no fresh
   * report.
   *
   * That is not hypothetical: adaptive was inert on a real board for exactly
   * this reason, with the route, the controller and this component each
   * working and each tested on its own. The chain is what was untested.
   */
  it("says what it is watching on every report, not once at connect", async () => {
    mountPicture();
    await settle();

    pc().statsReport = fakeStats();
    await advance(1000); // baseline: every rate here is a delta
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 200_000 } });
    await advance(1000);

    expect(reportCalls).toHaveLength(1);
    expect((reportCalls[0]!.body as { want?: unknown }).want).toBe("video");
    // Every tick, not just the first: a daemon that restarted, or a
    // subscription swept for idleness, must not leave a live picture
    // reporting into nothing until somebody reloads the page.
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 400_000 } });
    await advance(1000);
    expect(reportCalls).toHaveLength(2);
    expect((reportCalls[1]!.body as { want?: unknown }).want).toBe("video");
  });

  it("reports nothing on the first tick, then the interval rate — not the session average — on the second", async () => {
    mountPicture();
    await settle();

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 1_000_000, packetsReceived: 1000, packetsLost: 0 } });
    await advance(1000);
    // The very first sample: nothing to diff against yet.
    expect(reportCalls).toHaveLength(0);

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 1_125_000, packetsReceived: 1000, packetsLost: 0 } });
    await advance(1000);
    expect(reportCalls).toHaveLength(1);
    // The URL path is the stream path this session actually negotiated —
    // `-preview` and all; `cameraFor` strips it only for `stats.camera`,
    // asserted below, not for the route this posts to.
    expect(reportCalls[0]!.path).toBe("cam0-preview");
    const first = reportCalls[0]!.body as { stats: Record<string, unknown> };
    // 125,000 bytes over the one-second interval since the previous tick —
    // never against the 1,000,000-byte baseline or any total since the
    // session began.
    expect(first.stats).toMatchObject({ camera: "cam0", rtt: 50, egress: 1034, loss: 0, size: "1280x720", fps: 30 });
    expect(first.stats).not.toHaveProperty("frameAge");

    // A second, smaller interval must read its own rate, not fold the first
    // one in — which is what a session-average implementation would do.
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 1_255_000, packetsReceived: 2000, packetsLost: 0 } });
    await advance(1000);
    expect(reportCalls).toHaveLength(2);
    const second = reportCalls[1]!.body as { stats: Record<string, unknown> };
    expect(second.stats.egress).toBe(1075); // atIp(130,000 bytes over 1 s), not atIp(255,000 bytes over 2 s)
  });

  it("reports loss as the fraction over the interval, and a burst does not persist into a later tick", async () => {
    mountPicture();
    await settle();

    pc().statsReport = fakeStats({ inbound: { packetsReceived: 1000, packetsLost: 0 } });
    await advance(1000); // tick 1 — baseline, no report

    pc().statsReport = fakeStats({ inbound: { packetsReceived: 1980, packetsLost: 20 } });
    await advance(1000); // tick 2 — a burst: 20 lost of 1000 sent this interval
    const burst = (reportCalls[0]!.body as { stats: Record<string, unknown> }).stats;
    expect(burst.loss).toBeCloseTo(0.02, 10);

    for (const [packetsReceived, packetsLost] of [[2980, 20], [3980, 20], [4980, 20]] as const) {
      pc().statsReport = fakeStats({ inbound: { packetsReceived, packetsLost } });
      await advance(1000);
    }
    // Tick 5: the same 20 lost total, but zero more lost *this interval* —
    // a cumulative reading would still show the tick-2 burst; the interval
    // reading does not.
    expect(reportCalls).toHaveLength(4);
    const fifth = (reportCalls[3]!.body as { stats: Record<string, unknown> }).stats;
    expect(fifth.loss).toBe(0);
  });

  it("retains delivery feedback when the browser has no capacity estimate", async () => {
    mountPicture();
    await settle();

    pc().statsReport = fakeStats({ pair: { availableIncomingBitrate: undefined } });
    await advance(1000); // baseline

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 200_000 }, pair: { availableIncomingBitrate: undefined } });
    await advance(1000);

    expect(reportCalls).toHaveLength(1);
    // `want` and nothing else. The statistic is omitted whole rather than
    // sent half-filled, which is this test's point — but the report still has
    // to say what this browser is watching, or the subscription it is keeping
    // alive is swept for idleness and the controller loses the viewer
    // altogether. A browser with no bandwidth estimate is still a browser
    // watching the picture.
    expect(reportCalls[0]!.body).toMatchObject({ want: "video", stats: { capacity: null, rtt: 50, egress: 620, loss: 0 } });
  });

  it("includes frameAge once a frame has painted, and carries none before one ever has", async () => {
    const { wrapper } = mountPicture();
    await settle();
    pc().deliverTrack();
    await settle();

    pc().statsReport = fakeStats();
    await advance(1000); // baseline — no frame yet

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 200_000 } });
    await advance(1000);
    expect((reportCalls[0]!.body as { stats: Record<string, unknown> }).stats).not.toHaveProperty("frameAge");

    frames(wrapper); // a frame paints — `lastFrameAt` is now set
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 300_000 } });
    await advance(1000);
    const withFrame = (reportCalls[1]!.body as { stats: Record<string, unknown> }).stats;
    expect(withFrame.frameAge).toBeTypeOf("number");
    expect(withFrame.frameAge as number).toBeGreaterThanOrEqual(0);
  });

  it("stops the timer, and stops producing reports, once the component is destroyed", async () => {
    const { wrapper } = mountPicture();
    await settle();
    pc().statsReport = fakeStats();
    await advance(1000); // baseline — the timer now exists
    expect(internals(wrapper).reportTimer).not.toBeNull();

    wrapper.unmount();
    expect(internals(wrapper).reportTimer).toBeNull();

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 999_999 } });
    await advance(10_000);
    expect(reportCalls).toHaveLength(0);
  });

  it("stops the timer, and stops producing reports, once mode leaves 'live'", async () => {
    const { wrapper } = mountPicture();
    await settle();
    pc().statsReport = fakeStats();
    await advance(1000);
    expect(internals(wrapper).reportTimer).not.toBeNull();

    setMode(wrapper, "off");
    expect(internals(wrapper).reportTimer).toBeNull();

    pc().statsReport = fakeStats({ inbound: { bytesReceived: 999_999 } });
    await advance(10_000);
    expect(reportCalls).toHaveLength(0);
  });

  /**
   * The peer connection replaced — the `streamPath` watcher's own
   * renegotiation, using the `session` counter so a stale timer from the
   * connection it superseded cannot post against the one that replaced it.
   */
  it("replaces the timer, rather than letting a stale one post, when the connection is renegotiated onto another camera", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    pc(0).statsReport = fakeStats();
    await advance(1000); // baseline on the cam0 session
    const before = internals(wrapper).reportTimer;
    expect(before).not.toBeNull();

    await press({ path: "nose" });
    expect(FakePeerConnection.made).toHaveLength(2);
    // A new timer belongs to the new session — not merely a live one, a
    // *different* one from the cam0 session's own.
    expect(internals(wrapper).reportTimer).not.toBeNull();
    expect(internals(wrapper).reportTimer).not.toBe(before);

    // If the old session's timer were still the one running, this jump on
    // the *old* connection is what the next tick would report.
    pc(0).statsReport = fakeStats({ inbound: { bytesReceived: 9_999_999 } });
    pc(1).statsReport = fakeStats({ inbound: { bytesReceived: 140_000 } });
    await advance(1000); // the new session's own first tick — baseline, no report
    await advance(1000); // the new session's own second tick — its own report

    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0]!.path).toBe("nose-preview");
    expect((reportCalls[0]!.body as { stats: Record<string, unknown> }).stats.camera).toBe("nose");
  });

  it("is silent about a report that fails, and does not retry-storm", async () => {
    const { wrapper } = mountPicture();
    await settle();
    pc().statsReport = fakeStats();
    await advance(1000); // baseline

    reportOutcome = "fails";
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 300_000 } });
    await advance(1000); // one failing attempt
    expect(reportCalls).toHaveLength(1);
    expect(reasonText(wrapper)).toBe("");
    expect(internals(wrapper).attempt).toBe(0);

    reportOutcome = "ok";
    pc().statsReport = fakeStats({ inbound: { bytesReceived: 430_000 } });
    await advance(1000); // exactly one more attempt, one second later — no storm
    expect(reportCalls).toHaveLength(2);
    expect(reasonText(wrapper)).toBe("");
    expect(internals(wrapper).attempt).toBe(0);
  });
});

/**
 * **The rail, reaching the picture.**
 *
 * Every mode this component owns, and the whole of the held full-rate key,
 * were reachable from a unit test and from nowhere else on the page: `setMode`
 * had no caller in the template and no caller in any flow. A control that
 * cannot be reached is a control that shipped dead, which is the failure
 * ADR-0009 was written after.
 */
describe("what the soft-key rail sends it", () => {
  it("takes the full rate off the preview path while the key is held", async () => {
    const { press } = mountWithRail();
    await settle();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/video/cam0-preview/whep");

    await press("rate:full");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/video/cam0/whep");
  });

  it("goes straight back to the cheap copy when the key is let go", async () => {
    const { press } = mountWithRail();
    await settle();
    await press("rate:full");
    await press("rate:preview");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/video/cam0-preview/whep");
  });

  it("says which copy is on screen, because a cost nobody can see is not stated", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    expect(wrapper.find(".y-pic__badge").text()).toBe("live · preview");
    await press("rate:full");
    expect(wrapper.find(".y-pic__badge").text()).toBe("live · full rate");
  });

  it("does not renegotiate when the rate it is sent is the one it is already on", async () => {
    const { press } = mountWithRail();
    await settle();
    await press("rate:preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("changes mode from the rail, which is what Off and Stills are reached by", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    await press("mode:off");
    expect(wrapper.find(".y-pic__badge").text()).toBe("off");
    await press("mode:live");
    expect(wrapper.find(".y-pic__badge").text()).toBe("live · preview");
  });

  /**
   * **What watching this costs** (R-VID-11), which used to be a literal in the
   * wiring: `cameraStrip()`'s numbers for one configuration, frozen at deploy
   * time and reachable by no message. Raise the bitrate and the picture went
   * on saying 2.07 Mb/s while the strip beside it said 8.27.
   */
  it("states the cost the flow sent it, in preference to the configured one", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    await press({ cost: "preview 2.07 Mb/s · full rate 8.27 Mb/s at IP" });
    expect(wrapper.find(".y-pic__cost").text())
      .toBe("preview 2.07 Mb/s · full rate 8.27 Mb/s at IP");

    // And a later command does not put the stale one back: the store holds
    // one message per widget, and this widget's commands share that channel.
    await press("rate:full");
    expect(wrapper.find(".y-pic__cost").text())
      .toBe("preview 2.07 Mb/s · full rate 8.27 Mb/s at IP");
  });

  /**
   * **Which camera this is, from the message.** Written into the wiring it was
   * one device's camera id frozen at deploy time — `front`, the capture
   * fixture's name — so every board whose camera is called anything else got a
   * 404 and a picture reporting "this camera is not streaming" about a camera
   * that was running.
   */
  it("negotiates against the camera the flow named, not the one in its editor", async () => {
    const { press } = mountWithRail();
    await settle();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/video/cam0-preview/whep");

    await press({ path: "nose" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/video/nose-preview/whep");

    // And the full rate follows it, rather than the editor's name.
    await press("rate:full");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/video/nose/whep");
  });

  it("does not renegotiate when it is told the camera it is already showing", async () => {
    const { press } = mountWithRail();
    await settle();
    await press({ path: "cam0", cost: "preview 0.41 Mb/s at IP" });
    await press({ path: "cam0", cost: "preview 0.41 Mb/s at IP" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing at all until something names a camera", async () => {
    // The editor field is empty in the shipped wiring, because the id belongs
    // to the device rather than to this file. A picture that negotiated
    // against `-preview` would get a 404 and report it as a camera that is not
    // streaming — a true sentence about the wrong thing.
    const emit = vi.fn();
    const messages = reactive<Record<string, { payload?: unknown }>>({ n1: {} });
    const wrapper = mount(YonderPicture, {
      props: { id: "n1", props: { path: "", label: LABEL, stillsAfterMs: 600_000 } },
      global: {
        provide: { $socket: { emit }, $dataTracker: () => {} },
        mocks: { $store: { state: { data: { messages } } } },
      },
    });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reasonText(wrapper)).toMatch(/which camera/i);

    messages.n1 = { payload: { path: "nose" } };
    await nextTick();
    await settle();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/video/nose-preview/whep");
  });

  it("is not commanded by a cost", async () => {
    // An object payload is a state message, not one of the two vocabularies.
    const { wrapper, press } = mountWithRail();
    await settle();
    await press({ cost: "preview 0.41 Mb/s at IP" });
    expect(badge(wrapper)).toBe("live · preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Ignored rather than guessed at: a picture that acted on a message it did
   * not understand would be originating behaviour nobody asked for
   * (R-CMD-04).
   */
  it("ignores anything that is not one of the two vocabularies", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    for (const junk of ["mode:sideways", "rate:cheap", "start", 42, null, { mode: "off" }]) {
      await press(junk);
      expect(wrapper.find(".y-pic__badge").text(), JSON.stringify(junk)).toBe("live · preview");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Task 25: three defects the task is named for, fixed together (R-VID-18,
 * R-UI-28) — see `YonderPicture.vue`'s own top-of-file doc comment for the
 * full reasoning behind each. Six of the seven behaviours below had no
 * dictated test body in `task-25-brief.md`; the coordinator's resolutions
 * specify behaviour and leave the assertions here, on the same evidence
 * Tasks 19-23 already recorded: a body dictated verbatim has twice carried a
 * mistake about JavaScript an implementer had to find.
 */

/**
 * The frame's own declared `aspect-ratio`, read from its raw `style`
 * attribute rather than `getComputedStyle` — confirmed empirically before
 * writing a test against it, the same discipline `YonderAimPad`'s own
 * `DIAL_SIZE` comment describes for its own environment check: `jsdom` (this
 * project's installed v30) caches `getComputedStyle`'s result per element
 * the *first* time it is queried while the element is detached from
 * `document` — which every `@vue/test-utils` `mount()` without `attachTo`
 * is — so a second query after the value has actually changed keeps
 * reporting the first answer, exactly the "jsdom measures nothing" trap
 * this whole plan has hit before, in a different shape. The raw attribute
 * has no
 * such trap: Vue writes it fresh on every patch, and this file's own
 * existing tests already read inline styles this way (`.y-pic__video`'s own
 * `filter`, throughout this file) rather than through `getComputedStyle`.
 */
function frameAspect(wrapper: VueWrapper): number {
  const style = wrapper.find(".y-pic__frame").attributes("style") ?? "";
  const match = style.match(/aspect-ratio:\s*([\d.]+)/);
  return match ? parseFloat(match[1]!) : NaN;
}

describe("the picture is the shape of the picture (defect 1)", () => {
  it("takes the video's aspect ratio from loadedmetadata and has no fixed height", async () => {
    const { wrapper } = mountPicture();
    await settle();

    // A sensible default before any stream has ever answered, not "no shape
    // at all" — a `0` or `NaN` aspect-ratio would collapse the box.
    expect(frameAspect(wrapper)).toBeCloseTo(16 / 9, 5);

    // The ratio comes from `loadedmetadata` with real dimensions, never from
    // a prop: `jsdom`'s own `<video>` reports `videoWidth`/`videoHeight` as
    // 0 until told otherwise, exactly the way it reports every measured
    // rect as zero, so the event is dispatched with the decoder's own
    // reported shape overridden by hand.
    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    Object.defineProperty(videoEl, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(videoEl, "videoHeight", { value: 480, configurable: true });
    videoEl.dispatchEvent(new Event("loadedmetadata"));
    await nextTick();

    expect(frameAspect(wrapper)).toBeCloseTo(640 / 480, 5);

    // No fixed height anywhere this component states about itself: the box
    // is shaped by `aspect-ratio` and whatever width its own page gives it.
    expect(wrapper.find(".y-pic__frame").attributes("style") ?? "").not.toContain("height:");
  });

  it("a camera that is not 16:9 reshapes the box instead of being letterboxed inside one built for 16:9", async () => {
    const { wrapper } = mountPicture();
    await settle();
    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    // A portrait sensor, deliberately far from 16:9 — the exact shape a
    // fixed-aspect box would have hidden the badly-shaped-ness of.
    Object.defineProperty(videoEl, "videoWidth", { value: 480, configurable: true });
    Object.defineProperty(videoEl, "videoHeight", { value: 640, configurable: true });
    videoEl.dispatchEvent(new Event("loadedmetadata"));
    await nextTick();

    expect(frameAspect(wrapper)).toBeCloseTo(480 / 640, 5);
    expect(frameAspect(wrapper)).toBeLessThan(1);
  });

  it("holds its last known shape across a reconnect, rather than resetting to the 16:9 default", async () => {
    const { wrapper } = mountPicture({ stillsAfterMs: 600_000 });
    await settle();
    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    Object.defineProperty(videoEl, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(videoEl, "videoHeight", { value: 1080, configurable: true });
    videoEl.dispatchEvent(new Event("loadedmetadata"));
    await nextTick();
    expect(frameAspect(wrapper)).toBeCloseTo(1920 / 1080, 5);

    pc().goes("failed");
    await advance(1_000);

    // Reconnecting tears down and rebuilds the session — exactly the case
    // `blank()`'s own doc comment says must not delete the last frame — and
    // a fresh negotiation has not yet delivered a new `loadedmetadata`.
    expect(frameAspect(wrapper)).toBeCloseTo(1920 / 1080, 5);
  });

  /**
   * **And the shape is bounded by the slot, not only derived from the
   * width** — the half of defect 1 the three tests above cannot see, because
   * every one of them asks what shape the box is and none asks how big.
   *
   * Dashboard sizes a widget's grid area at `60h - 12` px, so a frame whose
   * height is derived from `width: 100%` alone stands 543 px tall in the
   * 408 px seven rows buy and 633 px at 1440 — the exact numbers the capture
   * gate reported, on a page whose shape was already right. So this asserts
   * the four declarations that make the box take *the lesser* of the room
   * across and the room down, read through `getComputedStyle` (confirmed
   * against this project's jsdom: it keeps `min()`, `calc()`, a `cqh` length
   * and `container-type` verbatim, unlike the per-element caching that made
   * `frameAspect` above read the raw attribute instead).
   *
   * Nothing here is measured. `jsdom` performs no layout, and the arithmetic
   * these four declarations perform is the browser's; what a unit test can
   * hold is that they are still declared, and the capture gate holds the
   * result — `nrdb-ui-yonder-picture` spilling over what follows it is the
   * finding that returns the moment any one of them is dropped.
   */
  it("is never taller than the slot the page gave it", () => {
    const { wrapper } = mountPicture();
    const fit = wrapper.find(".y-pic__fit");
    expect(fit.exists(), "the frame needs a box to be fitted inside").toBe(true);

    // `cqh` on the frame has to resolve against *this* box — the widget's own
    // grid area — and it only does while this box is a size container. Drop
    // this and the same `min()` silently measures the nearest container that
    // is one, or the small viewport, which is not the slot.
    expect(getComputedStyle(fit.element).containerType).toBe("size");

    const frame = getComputedStyle(wrapper.find(".y-pic__frame").element);
    // The lesser of the two, with `aspect-ratio` turning whichever won into
    // the height. `100%` alone is the shipped defect.
    expect(frame.width).toContain("min(100%");
    expect(frame.width).toContain("100cqh");
    // The belt-and-braces clamp, and the whole fallback for a browser with no
    // container queries: without it, dropping the `min()` line at parse time
    // leaves `width: 100%` and the overflow exactly as it was.
    expect(frame.maxHeight).toBe("100%");
    expect(frame.maxWidth).toBe("100%");

    // And the slot really is what is being divided: the root fills the grid
    // area and hands the picture a track that cannot grow past it. A `1fr`
    // track without the `minmax(0, ...)` floor takes its minimum from its
    // content, which is the overflow again with more steps.
    const root = getComputedStyle(wrapper.find(".y-pic").element);
    expect(root.height).toBe("100%");
    expect(root.gridTemplateRows).toContain("minmax(0, 1fr)");
  });
});

/** Every overlay's declared `z-index`, read straight off the stylesheet —
 * `jsdom` performs no layout, so this compares the declared values against
 * each other rather than measuring anything (coordinator resolution 2). */
function z(wrapper: VueWrapper, sel: string): number {
  const el = wrapper.find(sel);
  expect(el.exists(), `${sel} must exist to have a z-index at all`).toBe(true);
  const value = parseInt(getComputedStyle(el.element).zIndex, 10);
  expect(Number.isNaN(value), `${sel} must declare a numeric z-index`).toBe(false);
  return value;
}

describe("every overlay is drawn in front of the video (defect 2)", () => {
  /** Every overlay this component can draw at once, under one deliberately
   * fully-populated state: a live, stale (hatched) picture carrying a
   * preview-state message, a recording, a foot-strip reading and stats. */
  const OVERLAYS = [
    ".y-pic__hud",
    ".y-pic__hatch",
    ".y-pic__state",
    ".y-pic__rec",
    ".y-pic__foot",
    ".y-pic__osd",
  ];

  it("draws every overlay in front of the video", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    pc().deliverTrack();
    frames(wrapper);
    await settle();
    await advance(5_000); // stale enough for the hatch to join the rest

    await press({
      state: { head: "adaptive", size: "1280×720", rate: "15 fps", bitrate: "1.8 Mb/s" },
      recording: { elapsed: "00:13:47" },
      zoom: 156,
      stats: { linkMbps: 3.1, dropPct: 0.4 },
    });

    const videoZ = z(wrapper, ".y-pic__video");
    for (const sel of OVERLAYS) {
      expect(z(wrapper, sel), sel).toBeGreaterThan(videoZ);
    }
  });

  it("draws the off panel, and the no-picture reason panel, in front of the video too", async () => {
    const { wrapper } = mountPicture();
    await settle();
    setMode(wrapper, "off");
    await settle();
    expect(z(wrapper, ".y-pic__off")).toBeGreaterThan(z(wrapper, ".y-pic__video"));

    reply = { status: 404 };
    const second = mountPicture();
    await settle();
    expect(z(second.wrapper, ".y-pic__reason")).toBeGreaterThan(z(second.wrapper, ".y-pic__video"));
  });
});

describe("the picture wears its own state (defect 3)", () => {
  it("mounts the state overlay from payload.state, and the step line only on a change", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    expect(wrapper.findComponent(YonderStateOverlay).exists()).toBe(false);

    await press({
      state: {
        head: "floor",
        size: "854×480",
        rate: "10 fps",
        bitrate: "0.3 Mb/s",
        step: "Stepped down to 854×480: pinned at the floor for 4 s",
      },
    });
    const overlay = wrapper.findComponent(YonderStateOverlay);
    expect(overlay.exists()).toBe(true);
    expect(overlay.props("head")).toBe("floor");
    expect(overlay.props("size")).toBe("854×480");
    expect(wrapper.find(".y-ov__step").exists()).toBe(true);
    expect(wrapper.find(".y-ov__step").text()).toContain("Stepped down");

    // The very next message carries no step of its own (§8.2: "the last
    // step with its reason" is a fact about a change, not a permanent
    // fixture). A component that merged fields across messages instead of
    // caching the whole object as a unit would leave a stale step line
    // showing forever, on every message after the one that actually stepped.
    await press({ state: { head: "floor", size: "854×480", rate: "10 fps", bitrate: "0.3 Mb/s" } });
    expect(wrapper.find(".y-ov__step").exists()).toBe(false);
    // And the rest of the overlay is unaffected by that same message.
    expect(wrapper.findComponent(YonderStateOverlay).props("head")).toBe("floor");
  });

  /**
   * The scenario above proves the *live* read is right, but on its own that
   * is not enough: `fromPayload` reads the current message first whenever it
   * carries `state` at all, so a message that always repeats `state` can
   * mask a caching bug entirely — confirmed by hand, not assumed: merging
   * the cache field-by-field instead of replacing it as a whole left the
   * test above green, because neither of its two `press()` calls ever
   * leaves the live-read path. This test forces the *cached* copy to be
   * read — a later message that omits `state` altogether — at two different
   * points either side of a step, which only a whole-object replace gets
   * right.
   */
  it("the cached state (read when a later message omits `state` entirely) never resurrects a stale step from an earlier message", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    await press({ state: { head: "floor", step: "Stepped down to 854×480" } });
    expect(wrapper.find(".y-ov__step").exists()).toBe(true);

    // Says nothing about `state` at all — correctly falls back to the
    // cache, which still legitimately carries the step (nothing has said
    // the state changed since).
    await press({ path: "cam0" });
    expect(wrapper.find(".y-ov__step").exists()).toBe(true);

    // A fresh state message, with no step this time. The cache must be
    // replaced as a whole here, or the first message's step would survive
    // merged inside the cached object indefinitely.
    await press({ state: { head: "floor" } });
    expect(wrapper.find(".y-ov__step").exists()).toBe(false);

    // And a message that omits `state` again must now read the *replaced*
    // cache, not one still quietly carrying the first message's step.
    await press({ path: "cam1" });
    expect(wrapper.find(".y-ov__step").exists()).toBe(false);
  });

  it("draws the REC pill from recording, the foot strip from the descriptor's own label, LINK · DROP from stats", async () => {
    const { wrapper, press } = mountWithRail();
    await settle();
    expect(wrapper.find(".y-pic__rec").exists()).toBe(false);
    expect(wrapper.find(".y-pic__foot").exists()).toBe(false);
    expect(wrapper.find(".y-pic__osd").exists()).toBe(false);

    await press({
      recording: { elapsed: "00:13:47" },
      zoom: 156,
      exposure: 156,
      stats: { linkMbps: 3.1, dropPct: 0.4 },
    });

    expect(wrapper.find(".y-pic__rec").text()).toBe("REC 00:13:47");

    const foot = wrapper.find(".y-pic__foot").text();
    // Zoom: device-native passthrough, no unit at all (R-CTL-14 — no ×
    // ratio until the device's own scale is established), read from
    // `DESCRIPTORS.zoom` rather than a literal "ZOOM" written by hand here.
    expect(foot).toContain("ZOOM");
    expect(foot).toContain("156");
    // Exposure: `DESCRIPTORS.exposure`'s own real label and its own real
    // conversion — 100 µs per raw unit, so a raw reading of 156 shows 15600
    // µs. A hand-rolled "×100" living in this component too would be the
    // second source of truth this file's own doc comment warns drifts the
    // moment one of the two copies of the factor changes and the other does
    // not.
    expect(foot).toContain("SHUTTER");
    expect(foot).toContain("15600");
    expect(foot).toContain("µs");

    const osd = wrapper.find(".y-pic__osd").text();
    expect(osd).toContain("LINK");
    expect(osd).toContain("3.10 Mb/s");
    expect(osd).toContain("DROP");
    expect(osd).toContain("0.4 %");
    // A unit is never uppercased (CLAUDE.md, project-wide) — proven against
    // what `.text()` actually sees, not merely against a stylesheet rule
    // that could be the only thing making it look right.
    expect(osd).not.toContain("MB/S");
  });

  it("draws the thumb strip from payload.cameras, and a press switches this picture's own camera", async () => {
    const { wrapper, press, emit } = mountWithRail();
    await settle();
    expect(wrapper.findComponent(YonderThumbStrip).exists()).toBe(false);

    await press({
      cameras: [
        { id: "cam0", name: "Nose", active: true, ageSeconds: 0 },
        { id: "cam1", name: "Tail", active: false, ageSeconds: 4, thumbSrc: "/stills/cam1.jpg" },
      ],
      downlink: "0.41 Mb/s",
    });

    const strip = wrapper.findComponent(YonderThumbStrip);
    expect(strip.exists()).toBe(true);
    expect(strip.props("cameras")).toHaveLength(2);
    expect(strip.props("downlink")).toBe("0.41 Mb/s");

    emit.mockClear();
    await strip.vm.$emit("go", "cam1");
    await settle();

    // A press names the camera it was a press on, never its position in the
    // array (`YonderThumbStrip`'s own contract) — and this picture treats
    // that exactly like being *told* a camera by an incoming message: it
    // renegotiates against it, and tells the flow, so a control that can be
    // pressed is a control that is actually reachable rather than one that
    // shipped dead.
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/video/cam1-preview/whep");
    const pathCalls = emit.mock.calls.filter(([, , msg]) => msg?.payload?.path);
    expect(pathCalls).toHaveLength(1);
    expect(pathCalls[0]![2].payload.path).toBe("cam1");
  });
});

describe("the drag-to-slew layer — orb only (spec §6)", () => {
  function frameEl(wrapper: VueWrapper): Element {
    return wrapper.find(".y-pic__frame").element;
  }
  function dragPoint(type: string, x: number, y: number, pointerId = 1): PointerEvent {
    return new PointerEvent(type, { clientX: x, clientY: y, pointerId, bubbles: true, cancelable: true });
  }
  function slewCalls(emit: ReturnType<typeof vi.fn>) {
    return emit.mock.calls.filter(([, , msg]) => msg?.payload?.slew);
  }
  function stopCalls(emit: ReturnType<typeof vi.fn>) {
    return emit.mock.calls.filter(([, , msg]) => msg?.payload?.stop);
  }

  it("emits slew/stop with the pad's gesture contract, measured from where the pointer went down", async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present", pan: 0, tilt: 0 } });

    const el = frameEl(wrapper);
    // The press itself is always distance-zero from where it landed (this is
    // what "measured from where the pointer went down" means), so it alone
    // never emits — three moves past the dead zone are what put three slews
    // on the wire.
    el.dispatchEvent(dragPoint("pointerdown", 200, 150));
    el.dispatchEvent(dragPoint("pointermove", 240, 150)); // 40px right of the press point
    el.dispatchEvent(dragPoint("pointermove", 280, 150)); // further right
    el.dispatchEvent(dragPoint("pointermove", 320, 150)); // further still — the counter must advance

    const slews = slewCalls(emit);
    expect(slews.length).toBeGreaterThan(2);
    const last = slews.at(-1)![2];
    // **The trap Task 23's own review found**: comparing only the *first*
    // relayed event against the pad's first emitted event let a hardcoded
    // `seq: 1` through, because the first slew's own seq genuinely is 1 —
    // the assertion agreed with the mutant by coincidence. Drag on so the
    // counter has visibly moved past any constant somebody might have
    // frozen it at, assert that it moved, and only then compare.
    expect(last.payload.slew.seq, "the sequence counter must have advanced for this to discriminate").toBeGreaterThan(1);
    expect(last.payload.slew.pan).toBeGreaterThan(0); // moved right -> positive pan rate
    expect(last.payload.slew.tilt).toBeCloseTo(0, 5); // no vertical movement at all
    expect(typeof last.payload.slew.gesture).toBe("string");

    el.dispatchEvent(dragPoint("pointerup", 280, 150));
    const stops = stopCalls(emit);
    expect(stops).toHaveLength(1);
    // `stop` carries `gesture` alone — the pad's own design, not this
    // component's own invention of a `pan: 0, tilt: 0` enrichment.
    expect(stops[0]![2]).toEqual({ payload: { stop: { gesture: last.payload.slew.gesture } } });
  });

  it("draws the orb in front of the video too — it only exists mid-gesture", async () => {
    // **The one overlay the list above cannot reach**, and review caught its
    // absence: setting the orb's z-index to 0 left all sixty-seven tests
    // green. It is drawn only while a drag is in flight, so a test that does
    // not hold a pointer down never sees it — which makes it the easiest of
    // the nine to break unnoticed, on the task named for stacking.
    const { wrapper, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present", pan: 0, tilt: 0 } });

    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 200, 150));
    el.dispatchEvent(dragPoint("pointermove", 240, 150));
    await settle();

    expect(wrapper.find(".y-pic__orb").exists(), "the orb must be drawn for this to mean anything").toBe(true);
    expect(z(wrapper, ".y-pic__orb"), ".y-pic__orb").toBeGreaterThan(z(wrapper, ".y-pic__video"));
  });

it('retires the displayed path and active pointer when camera selection clears its report', async () => {
  const { wrapper, press } = mountWithRail();
  await settle();
  await press({ path: 'cam0', aim: { state: 'present', pan: 0, tilt: 0 } });
  const el = frameEl(wrapper);
  el.dispatchEvent(dragPoint('pointerdown', 200, 150));
  el.dispatchEvent(dragPoint('pointermove', 240, 150));
  await settle();
  expect(wrapper.find('.y-pic__orb').exists()).toBe(true);
  await press({ path: '', aim: null, cameras: [], running: null });
  expect((wrapper.vm as any).streamPath).toBe('');
  expect(wrapper.find('.y-pic__orb').exists()).toBe(false);
  await press('rate:preview');
  expect((wrapper.vm as any).streamPath).toBe('');
});

  it("measures from where the pointer went down, not the centre of the frame (coordinator resolution 5)", async () => {
    // Two presses starting in very different places, moved by the *same*
    // 40px to the right, must command the identical rate: an operator whose
    // thumb lands near an edge is asking for a rate proportional to how far
    // they dragged, not to where their thumb happened to land.
    const { wrapper: w1, emit: e1, press: p1 } = mountWithRail();
    await settle();
    await p1({ aim: { state: "present" } });
    const el1 = frameEl(w1);
    el1.dispatchEvent(dragPoint("pointerdown", 50, 50));
    el1.dispatchEvent(dragPoint("pointermove", 90, 50));
    const rate1 = slewCalls(e1).at(-1)![2];

    const { wrapper: w2, emit: e2, press: p2 } = mountWithRail();
    await settle();
    await p2({ aim: { state: "present" } });
    const el2 = frameEl(w2);
    el2.dispatchEvent(dragPoint("pointerdown", 600, 400));
    el2.dispatchEvent(dragPoint("pointermove", 640, 400));
    const rate2 = slewCalls(e2).at(-1)![2];

    expect(rate1.payload.slew.pan).toBeCloseTo(rate2.payload.slew.pan, 5);
    expect(rate1.payload.slew.tilt).toBeCloseTo(rate2.payload.slew.tilt, 5);
  });

  /**
   * Every other drag test in this file moves the pointer purely
   * horizontally, so `tilt` is always the negation of zero — 0 either way —
   * and the sign convention on the vertical axis is exercised by none of
   * them. Confirmed by hand: flipping the sign in `dragAt` left the whole
   * suite green until this test existed. Screen `y` grows downward; tilt
   * does not (`YonderAimPad.at()`'s own identical convention) — dragging
   * *up* (a smaller `clientY`) must read a *positive* tilt rate.
   */
  it("moving up commands a positive tilt rate — screen y grows downward, tilt does not", async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present" } });
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 100, 60)); // 40px up, no horizontal movement
    const last = slewCalls(emit).at(-1)![2];
    expect(last.payload.slew.tilt).toBeGreaterThan(0);
    expect(last.payload.slew.pan).toBeCloseTo(0, 5);
  });

  it("emits nothing while aim is not present, and starts nothing by drawing an orb nobody can push", async () => {
    const { wrapper, emit } = mountWithRail(); // no `aim` in the payload at all
    await settle();
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 200, 100));
    expect(slewCalls(emit)).toHaveLength(0);
    expect(wrapper.find(".y-pic__orb").exists()).toBe(false);
  });

  /**
   * The mirror image of Task 20's own finding, run against `dragDown`
   * instead of `updateDrag`. Confirmed by hand: removing `dragDown`'s own
   * `if (!this.aimable) return` guard leaves every other test in this file
   * green, because `updateDrag`'s own identical check still blocks the
   * emission at the time of the press — but it does nothing about
   * `dragPointerId` and `downX`/`downY` being recorded anyway, so a press
   * that started before aim was available, held through aim *becoming*
   * available, would resume slewing on the very next move with no fresh
   * press at all. Two guards, and this proves the first one is load-bearing
   * on its own, not merely a duplicate of the second.
   */
  it("a press that started before aim was available must not resume slewing once aim arrives, without a fresh press", async () => {
    const { wrapper, emit, press } = mountWithRail(); // starts with no `aim` at all
    await settle();
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 140, 100));
    expect(slewCalls(emit)).toHaveLength(0);

    await press({ aim: { state: "present" } }); // aim arrives mid-hold
    el.dispatchEvent(dragPoint("pointermove", 180, 100)); // still physically held, no fresh press
    expect(slewCalls(emit)).toHaveLength(0);

    // A genuinely fresh press, now that it is allowed, does slew.
    el.dispatchEvent(dragPoint("pointerup", 180, 100));
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 140, 100));
    expect(slewCalls(emit).length).toBeGreaterThan(0);
  });

  /**
   * A press is always distance-zero from itself by construction, so the
   * dead zone is what stands between an ordinary press-and-hold and a
   * malformed command: confirmed by hand, not assumed — breaking the dead
   * zone check (so `d <= DEAD` never short-circuits) leaves `dx / d`
   * computing `0 / 0`, `NaN`, on the down event alone, and every other test
   * in this file only ever inspects the *last* relayed slew, so a `NaN`
   * hiding in the first one goes unnoticed everywhere else.
   */
  it('uses the same chosen speed as the pad and ends image dragging when the response changes', async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: 'present', maxRate: 120 } });
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint('pointerdown', 100, 100));
    el.dispatchEvent(dragPoint('pointermove', 1000, 100));
    expect(slewCalls(emit).at(-1)?.[2].payload.slew.pan).toBe(60);
    window.dispatchEvent(new CustomEvent('yonder-aim-response-changed', { detail: { key: 'yonder:aim:speed', value: 12 } }));
    expect(stopCalls(emit)).toHaveLength(1);
    el.dispatchEvent(dragPoint('pointermove', 1000, 100));
    expect(slewCalls(emit)).toHaveLength(1);
    el.dispatchEvent(dragPoint('pointerdown', 100, 100));
    el.dispatchEvent(dragPoint('pointermove', 1000, 100));
    expect(slewCalls(emit).at(-1)?.[2].payload.slew.pan).toBe(12);
  });

  it("a press with no movement at all commands nothing — the dead zone, not merely 'no test checked'", async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present" } });
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    expect(slewCalls(emit)).toHaveLength(0);
    expect(stopCalls(emit)).toHaveLength(0);
  });

  it("stops the instant aim stops being available mid-drag, without a second stop when the pointer is then released", async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present" } });
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 140, 100));
    expect(slewCalls(emit).length).toBeGreaterThan(0);

    await press({ aim: { state: "gated", reason: "recording has it" } });
    expect(stopCalls(emit)).toHaveLength(1);

    // Still physically held — releasing now must not emit a second stop for
    // a gesture that already ended.
    el.dispatchEvent(dragPoint("pointerup", 140, 100));
    expect(stopCalls(emit)).toHaveLength(1);
  });

  /**
   * The subtler half of the identical trap Task 20's own review found in
   * `YonderAimPad`: `dragDown`'s own guard cannot reach a pointer that is
   * already down when the inhibition arrives. The `watch: { aimable }`
   * below ends the gesture the instant aim goes away, but the *physical*
   * pointer can still be held and still moving — without `updateDrag`'s own
   * second `aimable` check, a further move past the dead zone would mint a
   * **fresh** gesture and resume slewing under a control that was just
   * disabled.
   */
  it("does not reintroduce Task 20's own defect: aim going unavailable mid-hold must not let a held pointer resume slewing without a fresh press", async () => {
    const { wrapper, emit, press } = mountWithRail();
    await settle();
    await press({ aim: { state: "present" } });
    const el = frameEl(wrapper);
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 140, 100));
    expect(slewCalls(emit).length).toBeGreaterThan(0);

    await press({ aim: { state: "gated", reason: "recording has it" } });
    expect(stopCalls(emit)).toHaveLength(1);
    const slewsBeforeFurtherMove = slewCalls(emit).length;

    // Still physically held, still moving — no fresh press.
    el.dispatchEvent(dragPoint("pointermove", 180, 100));
    expect(slewCalls(emit).length).toBe(slewsBeforeFurtherMove);
    expect(stopCalls(emit)).toHaveLength(1); // no second stop either

    // A genuinely fresh press, now that aim is present again, is allowed.
    await press({ aim: { state: "present" } });
    el.dispatchEvent(dragPoint("pointerup", 180, 100)); // let go of the stale gesture first
    el.dispatchEvent(dragPoint("pointerdown", 100, 100));
    el.dispatchEvent(dragPoint("pointermove", 140, 100));
    expect(slewCalls(emit).length).toBeGreaterThan(slewsBeforeFurtherMove);
  });
});

describe("stands alone, with no deck at all (R-UI-28)", () => {
  it("draws the state overlay, REC pill, foot strip, thumb strip and LINK · DROP from props.report with no store at all", async () => {
    const { wrapper } = mountPicture({
      report: {
        state: { head: "adaptive", size: "1280×720", rate: "15 fps", bitrate: "1.8 Mb/s" },
        recording: { elapsed: "00:01:04" },
        cameras: [{ id: "cam1", name: "Tail", active: false, ageSeconds: 4 }],
        aim: { state: "present", pan: 12, tilt: -4 },
        zoom: 2,
        stats: { linkMbps: 3.1, dropPct: 0 },
      },
    });
    await settle();

    expect(wrapper.findComponent(YonderStateOverlay).exists()).toBe(true);
    expect(wrapper.findComponent(YonderStateOverlay).props("head")).toBe("adaptive");
    expect(wrapper.find(".y-pic__rec").text()).toContain("00:01:04");
    const foot = wrapper.find(".y-pic__foot").text();
    expect(foot).not.toContain("PAN");
    expect(foot).not.toContain("TILT");
    expect(foot).toContain("ZOOM");
    expect(wrapper.findComponent(YonderThumbStrip).exists()).toBe(true);
    expect(wrapper.findComponent(YonderThumbStrip).props("cameras")).toHaveLength(1);
    expect(wrapper.find(".y-pic__osd").text()).toContain("LINK");

    // Drawn, not merely present without throwing — the actual bar this
    // whole task sets (`YonderAim.vue`'s own R-UI-28 test states it first).
    // And the drag layer itself is reachable the same way: `aimable` comes
    // from the identical three-tier read as everything else here.
    const el = wrapper.find(".y-pic__frame").element;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10, pointerId: 9, bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointermove", { clientX: 60, clientY: 10, pointerId: 9, bubbles: true }));
    await nextTick(); // the emission is synchronous; the DOM's own `v-if` is not
    expect(wrapper.find(".y-pic__orb").exists()).toBe(true);
  });
});

/**
 * **The REC pill's data source, and the still's confirmation** (blueprint
 * L-16 and L-18, R-CAM-17, R-CAM-18, R-UI-05).
 *
 * L-16's pill has been built since Task 19 and nothing has ever fed it. Both
 * of these are about *what arrives*, so both are driven the way a real page
 * drives this component — a message into the store, never a prop.
 */
describe("the recording pill and the still's confirmation", () => {
  it("counts the elapsed time from the board's own `since`, not from this browser", async () => {
    const { wrapper, press } = mountWithRail();
    // The recording began a minute before this page opened. A component that
    // counted from its own mount would read 00:00:00 here, which is the
    // whole reason the pill takes an epoch rather than a duration.
    await press({ recording: { recording: true, since: Date.now() - 64_000, destination: "board" } });

    expect(wrapper.find(".y-pic__rec").text()).toContain("00:01:04");

    // And it counts on its own, because the page reads every five seconds
    // and a stopwatch that stepped in fives would read as a broken clock.
    await advance(3_000);
    expect(wrapper.find(".y-pic__rec").text()).toContain("00:01:07");
  });

  it("draws no pill for a recorder that is not recording", async () => {
    const { wrapper, press } = mountWithRail();
    await press({ recording: { recording: false, since: null, destination: "board" } });
    expect(wrapper.find(".y-pic__rec").exists()).toBe(false);
  });

  it("flashes the picture and names where the still went, then clears", async () => {
    const { wrapper, press } = mountWithRail();
    await press({ saved: { at: Date.now(), to: "this board" } });

    expect(wrapper.find(".y-pic__flash").exists(), "the flash is the confirmation").toBe(true);
    expect(wrapper.find(".y-pic__saved").text()).toContain("Saved · to this board");

    // It goes again on its own. A confirmation left on the picture is an
    // overlay between the operator and the thing they are watching.
    await advance(1_300);
    expect(wrapper.find(".y-pic__flash").exists()).toBe(false);
    expect(wrapper.find(".y-pic__saved").exists()).toBe(false);
  });

  it("names the medium the still actually landed on", async () => {
    // The listing's own `held`, through the same words the shutter key's line
    // uses. A still that landed on the camera's card announced as this
    // board's would send an operator to the wrong place to find it.
    const { wrapper, press } = mountWithRail();
    await press({ saved: { at: Date.now(), held: "camera" } });
    expect(wrapper.find(".y-pic__saved").text()).toContain("Saved · to the camera's card");
  });

  it("does not flash again for the same still arriving on the next poll", async () => {
    const { wrapper, press } = mountWithRail();
    const at = Date.now();
    await press({ saved: { at, to: "this board" } });
    await advance(1_300);
    expect(wrapper.find(".y-pic__flash").exists()).toBe(false);

    // The payload is cached across messages, so the same capture arrives with
    // every read. Watching the object rather than its `at` would flash the
    // picture once every five seconds for ever.
    await press({ path: "cam0-preview" });
    expect(wrapper.find(".y-pic__flash").exists()).toBe(false);
  });

  it("restarts the confirmation for a second still taken during the first", async () => {
    const { wrapper, press } = mountWithRail();
    await press({ saved: { at: 1_000, to: "this board" } });
    await advance(900);
    await press({ saved: { at: 2_000, to: "this board" } });
    // Still up 900 ms into the first one's own window: a second photograph is
    // a second confirmation, not one swallowed by the first.
    await advance(600);
    expect(wrapper.find(".y-pic__flash").exists()).toBe(true);
    await advance(700);
    expect(wrapper.find(".y-pic__flash").exists()).toBe(false);
  });
});

it.each(['teardown', 'retry'])('retires the physical aim gesture on media %s', async (method) => {
  const { wrapper } = mountPicture(); await settle();
  const vm = wrapper.vm as any;
  const stopped = vi.spyOn(vm.aimTransport, 'stop');
  vm.dragGesture = 'physical-press'; vm.dragPointerId = 7;
  vm[method]();
  expect(stopped).toHaveBeenCalled();
  expect(vm.dragGesture).toBeNull(); expect(vm.dragPointerId).toBeNull();
  wrapper.unmount();
});

it('retains an initially hydrated camera when a later message carries only richer facts', async () => {
  const messages = reactive<Record<string, { payload: unknown }>>({ n1: { payload: { path: 'pocket', cost: 'preview', running: true, aim: { state: 'present', pan: 4, tilt: 2 }, cameras: [{ id: 'pocket', name: 'Pocket', active: true }] } } });
  const wrapper = mount(YonderPicture, { props: { id: 'n1', props: { path: '-preview', label: '', stillsAfterMs: 12000 } }, global: {
    provide: { $socket: { emit: vi.fn() }, $dataTracker: () => {} }, mocks: { $store: { state: { data: { messages } } } },
  } });
  await settle();
  expect((wrapper.vm as any).streamPath).toBe('pocket-preview');
  messages.n1 = { payload: { saved: { held: 'camera', kind: 'photo', observedAt: Date.now() } } };
  await nextTick(); await settle();
  expect((wrapper.vm as any).streamPath).toBe('pocket-preview');
  expect((wrapper.vm as any).cameraRunning).toBe(true);
  expect(wrapper.text()).not.toContain('which camera');
  expect((wrapper.vm as any).aim.pan).toBe(4);
  wrapper.unmount();
});

it('hydrates state without replaying a cached full-rate action on mount', async () => {
  const { wrapper } = mountWithRail('rate:full'); await settle();
  expect((wrapper.vm as any).rate).toBe('preview');
  wrapper.unmount();
});

it('keeps private aim metadata and drag availability without drawing gimbal values over the image', async () => {
  const { wrapper } = mountPicture({ report: { aim: { state:'present', pan:12, tilt:6, url:'/video/pocket/aim', generation:1, maxRate:10 } } });
  await settle();
  expect((wrapper.vm as any).aimable).toBe(true);
  expect(wrapper.findAll('.y-pic__foot-k').map(label => label.text())).not.toContain('PAN');
  expect(wrapper.findAll('.y-pic__foot-k').map(label => label.text())).not.toContain('TILT');
  wrapper.unmount();
});


it('reports thumbnail demand for the selected and other visible cameras and releases it on unmount', async () => {
  const { wrapper } = mountPicture({ path:'front-preview', report: { cameras: [{id:'front',active:true,thumbSrc:'/video/front/still?v=1',ageSeconds:2},{id:'tail',active:false,thumbSrc:null,ageSeconds:null}] } });
  await settle();
  expect(reportCalls).toEqual(expect.arrayContaining([{path:'front',body:{want:'video',stills:true}},{path:'tail',body:{want:'off',stills:true}}]));
  wrapper.unmount();await settle();
  expect(reportCalls).toEqual(expect.arrayContaining([{path:'front',body:{want:'off',stills:false}},{path:'tail',body:{want:'off',stills:false}}]));
});


it('binds Picture Start to its displayed camera rather than a newer flow selection', async () => {
  const { wrapper, emit } = mountWithRail({ running: false, runState: 'stopped' });
  await settle();
  (wrapper.vm as any).pressStart();
  expect(emit).toHaveBeenLastCalledWith('widget-action', expect.any(String), { camera: 'cam0', payload: 'start' });
});

it('uses report-response encoder readback and measures receiver buffering on a monotonic interval', async () => {
  const { wrapper } = mountPicture(); await settle();
  reportState = { camera:'cam0', viewer:'viewer-1', overlay:{head:'adaptive',size:'1280×720',bitrate:'950 kb/s'}, mine:{receiverBufferMs:120,decodeMs:2.5} };
  pc().statsReport=fakeStats({inbound:{jitterBufferDelay:10,jitterBufferEmittedCount:100,totalDecodeTime:1,framesDecoded:100},pair:{availableIncomingBitrate:undefined}});
  await advance(1000);
  pc().statsReport=fakeStats({inbound:{jitterBufferDelay:13.6,jitterBufferEmittedCount:130,totalDecodeTime:1.075,framesDecoded:130,bytesReceived:200000},pair:{availableIncomingBitrate:undefined}});
  await advance(1000);
  const body=reportCalls.at(-1)!.body as any;
  expect(body.stats.receiverBufferMs).toBeCloseTo(120);
  expect(body.stats.decodeMs).toBeCloseTo(2.5);
  expect(body.stats.capacity).toBeNull();
  expect(wrapper.find('.y-pic__toolbar').text()).toContain('950 kb/s');
  expect(wrapper.find('.y-pic__toolbar').text()).toContain('Buffer 120 ms');
  expect(wrapper.find('.y-pic__frame .y-pic__state').exists()).toBe(false);
  reportState={camera:'another',viewer:'viewer-1',overlay:{head:'wrong'}};
  await advance(1000);
  expect(wrapper.find('.y-pic__toolbar').text()).not.toContain('wrong');
});

it('offers sign-in and stops retrying an expired session', async () => {
  reply={status:401};const {wrapper}=mountPicture();await settle();
  expect(wrapper.find('a.y-pic__action').text()).toBe('Sign in');
  const calls=fetchMock.mock.calls.length;await advance(30000);
  expect(fetchMock.mock.calls.length).toBe(calls);
  expect(wrapper.findAll('.y-pic__view-modes button').every(button=>button.attributes('disabled')!==undefined)).toBe(true);
});

it('starts a stopped camera, distinguishes startup, and keeps an existing preview through running readback', async () => {
  const {wrapper,emit}=mountPicture({report:{running:false,runState:'stopped'}});await settle();
  expect(fetchMock).not.toHaveBeenCalled();expect(wrapper.text()).toContain('Start video');
  await wrapper.get('.y-pic__start').trigger('click');await wrapper.get('.y-pic__start').trigger('click');
  expect(emit.mock.calls.filter(call=>(call[2] as any)?.payload==='start')).toHaveLength(1);
  await wrapper.setProps({props:{path:PATH,report:{running:null,runState:'starting'}}});await settle();
  expect(wrapper.find('.y-pic__stopped').exists()).toBe(false);expect(badge(wrapper)).toBe('Starting video');
  const count=FakePeerConnection.made.length;
  await wrapper.setProps({props:{path:PATH,report:{running:true,runState:'running'}}});await settle();
  expect(FakePeerConnection.made).toHaveLength(count);
  await wrapper.get('.y-pic__action').trigger('click');
  expect(emit).toHaveBeenLastCalledWith('widget-action','n1',{camera:'cam0',payload:'stop'});
});

it('local preview controls do not stop the camera stream', async () => {
  const {wrapper,emit}=mountPicture({report:{running:true,runState:'running'}});await settle();
  await wrapper.findAll('.y-pic__view-modes button').find(button=>button.text()==='Off')!.trigger('click');
  expect(emit.mock.calls.some(call=>(call[2] as any)?.payload==='stop')).toBe(false);
  expect(wrapper.get('.y-pic__action').text()).toBe('Stop video');
  expect(wrapper.text()).toContain('Preview is off in this browser.');
});

function dragPoint(type: string, clientX: number, clientY: number): Event {
  const e = new MouseEvent(type, {clientX, clientY, bubbles:true});
  Object.defineProperty(e, 'pointerId', {value:1}); return e;
}

it('keeps a captured video drag active outside the frame and releases capture on release',async()=>{
  const {wrapper,press}=mountWithRail();await settle();await press({aim:{state:'present',maxRate:120}});await nextTick();
  const el=wrapper.get('.y-pic__frame').element as any;
  el.setPointerCapture=vi.fn();el.hasPointerCapture=vi.fn(()=>true);el.releasePointerCapture=vi.fn();
  el.dispatchEvent(dragPoint('pointerdown',100,100));el.dispatchEvent(dragPoint('pointermove',172,100));await nextTick();
  const vm=wrapper.vm as any;const gesture=vm.dragGesture;
  expect(gesture).toBeTruthy();expect(wrapper.find('.y-pic__stick-origin').exists()).toBe(true);
  expect(z(wrapper,'.y-pic__stick-origin')).toBeGreaterThan(z(wrapper,'.y-pic__video'));
  el.dispatchEvent(dragPoint('pointerleave',900,100));expect(vm.dragGesture).toBe(gesture);
  el.dispatchEvent(dragPoint('pointerup',900,100));await nextTick();
  expect(vm.dragGesture).toBeNull();expect(el.releasePointerCapture).toHaveBeenCalled();
  expect(wrapper.find('.y-pic__stick-origin').exists()).toBe(false);
});

it('a tiny video drag does not start a zero-wire gesture; continuing the same hold starts real motion',async()=>{
  const {wrapper,press}=mountWithRail();await settle();await press({aim:{state:'present',maxRate:120}});await nextTick();
  const vm=wrapper.vm as any;vm.responseExpo=100;vm.responseSpeed=40;const el=wrapper.get('.y-pic__frame').element;
  el.dispatchEvent(dragPoint('pointerdown',100,100));el.dispatchEvent(dragPoint('pointermove',109,100));
  expect(vm.dragGesture).toBeNull();el.dispatchEvent(dragPoint('pointermove',172,100));expect(vm.dragGesture).toBeTruthy();
  expect(vm.dragAt({clientX:172,clientY:100,shiftKey:true}).pan).toBe(10);
  expect(vm.dragAt({clientX:172,clientY:100}).pan).toBe(40);
});


it('shows the private stills status without a live WebRTC statistics session', async () => {
  const {wrapper}=mountPicture({report:{running:true,runState:'running'}});await settle();
  reportState={camera:'cam0',viewer:'viewer-1',at:Date.now(),overlay:{head:'Stills',size:'1280×720',bitrate:'6 kb/s'}};
  await (wrapper.vm as any).setMode('stills');await settle();
  await advance(5000);
  expect(wrapper.get('.y-pic__state').text()).toContain('STILLS');
  expect(wrapper.get('.y-pic__state').text()).toContain('6 kb/s');
  expect((wrapper.vm as any).pc).toBeNull();
});
