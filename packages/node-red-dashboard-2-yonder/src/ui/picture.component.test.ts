// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import YonderPicture from "./YonderPicture.vue";

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

/**
 * What the media server is answering with on the next negotiation.
 *
 * `"gated"` answers nothing until a test says so, which is the only way to
 * hold a handshake open across the thing that abandons it.
 */
let reply: { status: number; sdp?: string } | "throws" | "gated" = { status: 201, sdp: ANSWER };

/** Handshakes the media server has not answered yet, in the order they were made. */
const gates: ((answer: { status: number; sdp?: string }) => void)[] = [];

const fetchMock = vi.fn(async (_url: string, init: unknown) => {
  if (reply === "throws") throw new TypeError("Failed to fetch");
  // A gated request answers when a test says so — or rejects with
  // `AbortError`, which is what a real `fetch` does the moment its signal is
  // aborted, and which lands in `connect()`'s catch.
  const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
  const answered = reply === "gated"
    ? await new Promise<{ status: number; sdp?: string }>((resolve, reject) => {
      gates.push(resolve);
      signal?.addEventListener("abort", () => {
        const aborted = new Error("The user aborted a request.");
        aborted.name = "AbortError";
        reject(aborted);
      });
    })
    : reply;
  const { status, sdp } = answered;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => sdp ?? "",
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
  vi.useFakeTimers();
  FakePeerConnection.made.length = 0;
  gates.length = 0;
  fetchMock.mockClear();
  reply = { status: 201, sdp: ANSWER };
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("asking for the picture", () => {
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
    expect(reasonText(wrapper)).toMatch(/logged in/i);
  });

  it("404 says the camera is not streaming, and where to start it", async () => {
    reply = { status: 404 };
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/not streaming/i);
  });

  it("503 says the media server is not answering, and says nothing about the camera", async () => {
    // The camera is the 404 above — the media server answered, and said that
    // path has no publisher. This is the case where it did not answer at all,
    // and an operator sent to look at a camera that is fine has been sent the
    // wrong way.
    reply = { status: 503 };
    const { wrapper } = mountPicture();
    await settle();
    expect(reasonText(wrapper)).toMatch(/media server/i);
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
    expect(reasonText(wrapper)).toMatch(/not streaming/i);

    // And the attempt that was already scheduled when the deadline expired
    // does not fire: a session negotiated behind a badge reading 'stills'
    // would put live video under a caption saying it is not live.
    const attempts = fetchMock.mock.calls.length;
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
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

  it("does not reconnect once it has fallen back to stills", async () => {
    const { wrapper } = mountPicture();
    await settle();
    await advance(12_000);
    expect(badge(wrapper)).toBe("stills");
    const attempts = fetchMock.mock.calls.length;

    pc(0).goes("failed");
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
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
    expect(wrapper.find(".y-pic__off").text()).toMatch(/not requested/i);
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
