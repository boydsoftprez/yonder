// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  STILLS_INTERVAL_MS, stillCostKbps, Viewers,
  type CameraReport, type PreviewState, type ViewerStats,
} from "./viewers.js";
import type { Decision } from "./rate.js";
import type { RunningEncodes } from "./pipeline.js";
import { atIp } from "./present.js";
import type { Camera } from "../schema/config.js";

/**
 * Who is watching, and what it costs (spec §8.2).
 *
 * Two properties run through all of it and are worth naming before the tests
 * that check them: **one browser session is one viewer**, however many pages
 * it has open; and **nothing here may change what the aircraft sends anyone
 * else** — not another viewer's delivery, not the shared encode, and above
 * all not a configured output.
 */

const CAMERA = {
  id: "cam0", name: "Nose", source: "usb",
  device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: {
    mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
    floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
  },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [{ kind: "rtp", enabled: true, host: "192.168.1.50", port: 5600 }],
  stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 4000 },
} as unknown as Camera;

const SECOND = { ...CAMERA, id: "cam1", name: "Tail" } as unknown as Camera;

/** What the pipeline is running: 2000 on the stream, 900 on the preview. */
const RUNNING: RunningEncodes = {
  stream: 2000, preview: 900, shape: { size: "854x480", fps: 15 },
};

function fakeClock(from = 1_000_000) {
  let now = from;
  return {
    clock: {
      now: () => now,
      setTimer: (ms: number, fn: () => void) => setTimeout(fn, ms),
      clearTimer: (h: unknown) => { clearTimeout(h as NodeJS.Timeout); },
    },
    at: () => now,
    advance(ms: number) { now += ms; },
  };
}

function stats(over: Partial<ViewerStats> = {}): ViewerStats {
  return { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 8_000, ...over };
}

function viewersOn(opts: {
  cameras?: readonly Camera[];
  running?: (id: string) => RunningEncodes | null;
} = {}) {
  const clock = fakeClock();
  const applied = { cameras: opts.cameras ?? [CAMERA] };
  const published: PreviewState[] = [];
  const reports: CameraReport[] = [];
  const viewers = new Viewers({
    cameras: () => applied.cameras,
    inForce: opts.running ?? ((id) => (applied.cameras.some((c) => c.id === id) ? RUNNING : null)),
    clock: clock.clock,
    onState: (s) => published.push(s),
    onReport: (r) => reports.push(r),
  });
  return { viewers, clock, applied, published, reports };
}

describe("Viewers, and the encode two browsers share", () => {
  it("gives two viewers of one camera the same shared encode", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "video");

    const one = viewers.state("cam0", "v1");
    const two = viewers.state("cam0", "v2");
    expect(one.shared).toEqual(two.shared);
    expect(one.shared).toMatchObject({ size: "854x480", fps: 15, kbps: 900, floor: 300, ceiling: 2000 });
    // One encode, two transmissions of it.
    expect(one.cost.shared).toBe(atIp(900));
    expect(two.cost.shared).toBe(atIp(900));
    expect(one.mine.source).toBe("cam0-preview");
    expect(two.mine.source).toBe("cam0-preview");
  });

  it("treats two pages of one camera in one session as one subscription", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    const alone = viewers.state("cam0", "v1").cost.path;
    // The same session opens the camera in a second tab.
    viewers.subscribe("v1", "cam0", "video");
    expect(viewers.state("cam0", "v1").cost.path).toBe(alone);
    expect(viewers.watching("cam0")).toEqual(["v1"]);

    // A different session is a different viewer, and does cost another copy.
    viewers.subscribe("v2", "cam0", "video");
    expect(viewers.state("cam0", "v1").cost.path).toBe(alone + atIp(900));
  });
});

describe("Viewers and the full-rate hold", () => {
  it("switches only the viewer that holds it on to the main stream", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "video");
    const beforeShared = viewers.state("cam0", "v2").shared;

    viewers.fullRate("v1", "cam0", true);

    const held = viewers.state("cam0", "v1");
    const other = viewers.state("cam0", "v2");
    expect(held.mine).toMatchObject({ fullRate: true, source: "cam0", kbps: 2000 });
    expect(other.mine).toMatchObject({ fullRate: false, source: "cam0-preview", kbps: 900 });
    // The shared preview encode did not move for one browser's key.
    expect(other.shared).toEqual(beforeShared);
    expect(held.shared).toEqual(beforeShared);
    expect(held.overlay.head).toBe("full-rate");
    expect(other.overlay.head).not.toBe("full-rate");
  });

  it("does not move another viewer off stills", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "stills");
    viewers.fullRate("v1", "cam0", true);
    expect(viewers.state("cam0", "v2").mine).toMatchObject({ delivery: "stills", fullRate: false });
  });

  it("refuses the hold to a browser that is not watching video", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    viewers.fullRate("v1", "cam0", true);
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(false);
  });

  it("ends on release, and on the browser going away, and on expiry", () => {
    const { viewers, clock } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");

    // Release, cancel and blur are all the browser saying false.
    viewers.fullRate("v1", "cam0", true);
    viewers.fullRate("v1", "cam0", false);
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(false);

    // Disconnect: the page went, and coming back does not resume the hold.
    viewers.fullRate("v1", "cam0", true);
    viewers.unsubscribe("v1");
    viewers.subscribe("v1", "cam0", "video");
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(false);

    // Expiry: nobody renewed it, and no message at all arrives to end it.
    viewers.fullRate("v1", "cam0", true);
    clock.advance(14_999);
    viewers.sweep();
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(true);
    clock.advance(2);
    viewers.sweep();
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(false);
  });

  it("keeps the hold alive while the browser renews it", () => {
    const { viewers, clock } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.fullRate("v1", "cam0", true);
    for (let i = 0; i < 5; i += 1) {
      clock.advance(10_000);
      viewers.fullRate("v1", "cam0", true);
      viewers.sweep();
    }
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(true);
  });

  it("switching to stills lets go of the hold", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.fullRate("v1", "cam0", true);
    viewers.subscribe("v1", "cam0", "stills");
    expect(viewers.state("cam0", "v1").mine.fullRate).toBe(false);
  });
});

describe("Viewers and what a picture costs", () => {
  it("counts every transmitted copy once per path, and shows mine separately", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "video");
    viewers.subscribe("v3", "cam0", "stills");
    viewers.transmitted("v3", "cam0", 100_000);
    viewers.fullRate("v2", "cam0", true);

    const mine = viewers.state("cam0", "v1");
    // One configured RTP output at the stream's running rate, one full-rate
    // viewer at the same rate, one preview viewer, and one stills viewer at
    // the copy it was sent over the interval it is sent at.
    const still = stillCostKbps(100_000, STILLS_INTERVAL_MS);
    expect(mine.cost.path).toBe(atIp(2000) + atIp(2000) + atIp(900) + still);
    expect(mine.cost.mine).toBe(atIp(900));
    expect(viewers.state("cam0", "v2").cost.mine).toBe(atIp(2000));
    expect(viewers.state("cam0", "v3").cost.mine).toBe(still);
    // The encode itself, once, whoever is watching it.
    expect(mine.cost.shared).toBe(atIp(900));
  });

  it("counts a browser's stills strip in its own cost, across cameras", () => {
    const { viewers } = viewersOn({ cameras: [CAMERA, SECOND] });
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v1", "cam1", "stills");
    viewers.transmitted("v1", "cam1", 60_000);
    expect(viewers.state("cam0", "v1").cost.mine)
      .toBe(atIp(900) + stillCostKbps(60_000, STILLS_INTERVAL_MS));
  });

  it("charges nothing for a still nothing has been sent", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    expect(viewers.state("cam0", "v1").cost.mine).toBe(0);
    expect(viewers.state("cam0", "v1").mine.kbps).toBeNull();
    expect(viewers.state("cam0", "v1").cost.path).toBe(atIp(2000));
  });

  it("charges nothing for a camera that is not enabled", () => {
    const off = { ...CAMERA, enabled: false } as unknown as Camera;
    const { viewers } = viewersOn({ cameras: [off], running: () => null });
    viewers.subscribe("v1", "cam0", "video");
    expect(viewers.state("cam0", "v1").cost.path).toBe(0);
  });
});

/**
 * The stills the strip is made of (R-VID-14, R-VID-11; spec §8.6).
 *
 * Two rules, each with a test that a plausible wrong implementation fails:
 * **one still per camera however many browsers want it** is `wantingStills`
 * naming a camera once; **every transmitted copy counted** is three browsers
 * on one camera costing the path three copies of one image.
 */
describe("Viewers and the stills it accounts for", () => {
  const still = (bytes: number): number => stillCostKbps(bytes, STILLS_INTERVAL_MS);

  it("names each camera with a stills subscriber once, however many there are", () => {
    const { viewers } = viewersOn({ cameras: [CAMERA, SECOND] });
    viewers.subscribe("v1", "cam0", "stills");
    viewers.subscribe("v2", "cam0", "stills");
    viewers.subscribe("v3", "cam0", "video");
    viewers.subscribe("v3", "cam1", "video");
    // cam0 once — not twice for its two stills viewers — and cam1 not at all:
    // a video viewer is not a reason to take a still.
    expect(viewers.wantingStills()).toEqual(["cam0"]);

    viewers.subscribe("v3", "cam1", "stills");
    expect(viewers.wantingStills()).toEqual(["cam0", "cam1"]);
    viewers.unsubscribe("v1");
    viewers.unsubscribe("v2");
    expect(viewers.wantingStills()).toEqual(["cam1"]);
  });

  it("names no camera that is not enabled, and none nobody wants", () => {
    const off = { ...SECOND, enabled: false } as unknown as Camera;
    const { viewers } = viewersOn({ cameras: [CAMERA, off] });
    viewers.subscribe("v1", "cam1", "stills");
    expect(viewers.wantingStills()).toEqual([]);
    viewers.subscribe("v1", "cam0", "off");
    expect(viewers.wantingStills()).toEqual([]);
  });

  it("charges every transmitted copy: three browsers on one image is three copies", () => {
    const { viewers } = viewersOn();
    for (const v of ["v1", "v2", "v3"]) viewers.subscribe(v, "cam0", "stills");
    for (const v of ["v1", "v2", "v3"]) viewers.transmitted(v, "cam0", 100_000);

    // **The mutation this catches:** counting the still once per camera
    // rather than once per transmission would put one copy on the path here
    // and leave two browsers' worth of uplink unstated.
    expect(viewers.state("cam0", "v1").cost.path).toBe(atIp(2000) + 3 * still(100_000));
    for (const v of ["v1", "v2", "v3"]) {
      expect(viewers.state("cam0", v).cost.mine).toBe(still(100_000));
      expect(viewers.state("cam0", v).mine.kbps).toBe(still(100_000));
    }
    expect(viewers.stillsKbps()).toBe(3 * still(100_000));
  });

  it("costs a copy as its size over the interval, at IP", () => {
    // 100 kB every 5 s is 160 kb/s on the wire, and a little more at IP.
    expect(still(100_000)).toBe(atIp(160));
    expect(stillCostKbps(0, STILLS_INTERVAL_MS)).toBe(0);
    expect(stillCostKbps(100_000, 0)).toBe(0);
  });

  it("charges every copy sent within the accounting window", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    viewers.transmitted("v1", "cam0", 100_000);
    viewers.transmitted("v1", "cam0", 80_000);
    expect(viewers.state("cam0", "v1").cost.mine).toBe(still(180_000));
  });

  it("counts a fetch without turning it into continuing still demand", () => {
    const { viewers } = viewersOn();
    viewers.transmitted("v1", "cam0", 100_000);
    expect(viewers.state("cam0", "v1").mine.delivery).toBe("off");
    expect(viewers.wantingStills()).toEqual([]);
    expect(viewers.state("cam0", "v1").cost.mine).toBe(still(100_000));
  });

  it("counts a strip fetch independently while leaving its viewer on video", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.transmitted("v1", "cam0", 100_000);
    expect(viewers.state("cam0", "v1").mine.delivery).toBe("video");
    expect(viewers.state("cam0", "v1").cost.mine).toBe(atIp(900) + still(100_000));
    expect(viewers.stillsKbps()).toBe(still(100_000));
  });

  it("ages transmitted traffic out even while subscription heartbeats continue", () => {
    const { viewers, clock } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.transmitted("v1", "cam0", 100_000);
    expect(viewers.stillsKbps()).toBe(still(100_000));

    clock.advance(STILLS_INTERVAL_MS);
    viewers.subscribe("v1", "cam0", "video");
    expect(viewers.stillsKbps()).toBe(0);
    expect(viewers.state("cam0", "v1").cost.mine).toBe(atIp(900));
  });

  it("expires an older copy while retaining newer bytes from the same viewer", () => {
    const { viewers, clock } = viewersOn();
    viewers.transmitted("v1", "cam0", 100_000);
    clock.advance(STILLS_INTERVAL_MS / 2);
    viewers.transmitted("v1", "cam0", 80_000);
    clock.advance(STILLS_INTERVAL_MS / 2);

    expect(viewers.stillsKbps()).toBe(still(80_000));
  });

  it("does not overwrite a still-live partial bucket when the ring wraps", () => {
    const { viewers, clock } = viewersOn();
    clock.advance(499);
    viewers.transmitted("v1", "cam0", 100_000);
    clock.advance(4_501);
    viewers.transmitted("v1", "cam0", 100_000);

    // The first copy is 4,501 ms old, so both belong to the 5 s window even
    // though the second has crossed ten 500 ms slot boundaries.
    expect(viewers.stillsKbps()).toBe(still(200_000));
    clock.advance(499);
    expect(viewers.stillsKbps()).toBe(still(100_000));
    clock.advance(4_501);
    expect(viewers.stillsKbps()).toBe(0);
  });

  it("bounds accounting storage while retaining every delivered byte", () => {
    const { viewers, clock } = viewersOn();
    for (let bucket = 0; bucket < 11; bucket += 1) {
      for (let copy = 0; copy < 100; copy += 1) viewers.transmitted("v1", "cam0", 1_000);
      if (bucket < 10) clock.advance(STILLS_INTERVAL_MS / 10);
    }
    expect(viewers.stillsKbps()).toBe(still(1_000_000));

    const internals = viewers as unknown as {
      subs: Map<string, Map<string, { stillTraffic: unknown[] }>>;
    };
    expect(internals.subs.get("v1")?.get("cam0")?.stillTraffic.filter(Boolean))
      .toHaveLength(11);
  });

  it("requests shared still generation for a thumbnail without changing video delivery", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.requestStills("v1", "cam0", true);
    expect(viewers.wantingStills()).toEqual(["cam0"]);
    expect(viewers.state("cam0", "v1").mine.delivery).toBe("video");

    viewers.requestStills("v1", "cam0", false);
    expect(viewers.wantingStills()).toEqual([]);
  });

  it("refuses to count a copy for a camera this device does not have", () => {
    const { viewers } = viewersOn();
    viewers.transmitted("v1", "nope", 100_000);
    expect(viewers.watching("nope")).toEqual([]);
    expect(viewers.stillsKbps()).toBe(0);
  });

  it("reports the still's own age, shape and the interval on a stills viewer's mine", () => {
    const clock = fakeClock();
    const taken = { at: clock.at(), bytes: 100_000, width: 1280, height: 720 };
    const viewers = new Viewers({
      cameras: () => [CAMERA],
      inForce: () => RUNNING,
      clock: clock.clock,
      stillFor: (camera) => (camera === "cam0" ? taken : null),
    });
    viewers.subscribe("v1", "cam0", "stills");
    clock.advance(3_200);

    const mine = viewers.state("cam0", "v1").mine;
    // The daemon's own measurement of the frame it is holding, in whole
    // seconds — not a browser's report, which an `<img>` has no media clock
    // to make.
    expect(mine.frameAge).toBe(3_000);
    expect(mine.interval).toBe(STILLS_INTERVAL_MS);
    expect(mine.size).toBe("1280x720");
    expect(mine.delivery).toBe("stills");
    // And the overlay's head reads `STILLS · every 5 s` (spec §8.2).
    const overlay = viewers.state("cam0", "v1").overlay;
    expect(overlay.head).toBe("stills");
    expect(overlay.rate).toBe("every 5 s");
    expect(overlay.size).toBe("1280×720");
  });

  it("reports no age and no size for a camera with no still to have one", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    const mine = viewers.state("cam0", "v1").mine;
    expect(mine.frameAge).toBeNull();
    expect(mine.size).toBeNull();
    expect(mine.interval).toBe(STILLS_INTERVAL_MS);
    expect(viewers.state("cam0", "v1").overlay.rate).toBe("every 5 s");
  });

  it("publishes to the browser whose copy was counted, because its cost moved", () => {
    const { viewers, published } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    const before = published.length;
    viewers.transmitted("v1", "cam0", 100_000);
    expect(published.length).toBe(before + 1);
    expect(published.at(-1)?.cost.mine).toBe(still(100_000));
  });
});

describe("Viewers, and a page that leaves", () => {
  it("ends that browser's delivery and changes no configured output", () => {
    const { viewers, applied } = viewersOn();
    const before = structuredClone(applied.cameras);
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "video");
    const shared = viewers.state("cam0", "v2").shared;

    viewers.unsubscribe("v1");

    // The output is exactly as the operator applied it, and it is still
    // being charged to the path, because it is still leaving the aircraft.
    expect(applied.cameras).toEqual(before);
    expect(applied.cameras[0].outputs[0].enabled).toBe(true);
    const left = viewers.state("cam0", "v2");
    expect(left.cost.path).toBe(atIp(2000) + atIp(900));
    // The other browser's picture is untouched.
    expect(left.shared).toEqual(shared);
    expect(left.mine).toMatchObject({ delivery: "video", source: "cam0-preview" });
    // And the browser that went is being sent nothing.
    expect(viewers.state("cam0", "v1").mine).toMatchObject({ delivery: "off", source: null });
    expect(viewers.watching("cam0")).toEqual(["v2"]);
  });

  it("one camera's page closing leaves that browser's other cameras alone", () => {
    const { viewers, applied } = viewersOn({ cameras: [CAMERA, SECOND] });
    const before = structuredClone(applied.cameras);
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v1", "cam1", "stills");

    viewers.leave("v1", "cam1");

    expect(viewers.state("cam0", "v1").mine.delivery).toBe("video");
    expect(viewers.state("cam1", "v1").mine.delivery).toBe("off");
    expect(applied.cameras).toEqual(before);
  });

  it("lets go of a browser that has said nothing for long enough to have gone", () => {
    const { viewers, clock, applied } = viewersOn();
    const before = structuredClone(applied.cameras);
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v2", "cam0", "video");

    clock.advance(30_000);
    viewers.subscribe("v2", "cam0", "video");
    clock.advance(31_000);
    viewers.sweep();

    expect(viewers.watching("cam0")).toEqual(["v2"]);
    // Still no configured output has moved.
    expect(applied.cameras).toEqual(before);
  });
});

describe("Viewers and the evidence it passes on", () => {
  it("hands a statistic on once, stamped when it arrived, and never again", () => {
    const { viewers, clock, reports } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    const arrived = clock.at();
    viewers.report("v1", stats({ capacity: 1_200 }));
    expect(reports).toEqual([
      { camera: "cam0", viewer: "v1", rtt: 40, loss: 0, egress: 900, capacity: 1_200, at: arrived },
    ]);

    // Ten seconds of ticking, publishing and asking for state. A stale
    // statistic must not be re-offered as evidence with a fresh date on it —
    // the controller's "a stale report is not headroom" is only worth
    // anything if what feeds it cannot manufacture freshness.
    for (let i = 0; i < 10; i += 1) {
      clock.advance(1_000);
      viewers.sweep();
      viewers.state("cam0", "v1");
    }
    expect(reports).toHaveLength(1);
    expect(reports[0].at).toBe(arrived);
    // And the page is told how old the reading is rather than shown a fresh
    // looking one.
    expect(viewers.state("cam0", "v1").mine.statsAt).toBe(arrived);
  });

  it("is not evidence from a browser that is not watching this camera's video", () => {
    const { viewers, reports } = viewersOn({ cameras: [CAMERA, SECOND] });
    viewers.subscribe("v1", "cam0", "stills");
    viewers.report("v1", stats());
    viewers.subscribe("v2", "cam1", "video");
    viewers.report("v2", stats({ camera: "cam0" }));
    expect(reports).toEqual([]);

    viewers.subscribe("v1", "cam0", "video");
    viewers.report("v1", stats());
    expect(reports).toHaveLength(1);
  });

  it("refuses a report about a camera this device does not have", () => {
    const { viewers, reports, published } = viewersOn();
    viewers.subscribe("v1", "nope", "video");
    viewers.report("v1", stats({ camera: "nope" }));
    expect(reports).toEqual([]);
    expect(published).toEqual([]);
    expect(viewers.watching("nope")).toEqual([]);
  });

  it("carries the browser's own frame age rather than one of its own", () => {
    const { viewers, clock } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.report("v1", stats({ frameAge: 240 }));
    clock.advance(9_000);
    const state = viewers.state("cam0", "v1");
    expect(state.mine.frameAge).toBe(240);
    expect(state.at - state.mine.statsAt!).toBe(9_000);
  });
});

describe("Viewers and the revision", () => {
  it("increments on every publish, and does not publish what has not changed", () => {
    const { viewers, published } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    expect(published.map((p) => p.revision)).toEqual([1]);

    viewers.report("v1", stats());
    expect(published.map((p) => p.revision)).toEqual([1, 2]);

    // The same subscription again is the second tab, and changes nothing.
    viewers.subscribe("v1", "cam0", "video");
    expect(published).toHaveLength(2);

    viewers.fullRate("v1", "cam0", true);
    expect(published.map((p) => p.revision)).toEqual([1, 2, 3]);
    expect(published[2].camera).toBe("cam0");
    expect(published[2].viewer).toBe("v1");
    expect(published[2].at).toBeGreaterThan(0);
  });

  it("publishes to every viewer whose picture a second browser changed", () => {
    const { viewers, published } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    published.length = 0;
    // v2 arriving costs the path another copy, which is a change to v1's
    // picture as much as to v2's.
    viewers.subscribe("v2", "cam0", "video");
    expect(published.map((p) => p.viewer).sort()).toEqual(["v1", "v2"]);
  });
});

describe("Viewers and what the rate controller decided", () => {
  const step = (over: Partial<Decision> = {}): Decision => ({
    action: "size", camera: "cam0", encode: "preview", size: "640x360",
    reason: "the preview has been pinned at its 300 kb/s floor for 5 s; the picture "
      + "steps from 854x480 to 640x360",
    at: 1_000_000, ...over,
  } as Decision);

  it("puts the reason on the picture", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.decided([step()]);
    const state = viewers.state("cam0", "v1");
    expect(state.shared.step?.reason).toContain("pinned at its 300 kb/s floor");
    expect(state.overlay.step).toBe(state.shared.step?.reason);
  });

  it("prefers a shortfall to a step, and a step to a hold", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    const hold: Decision = {
      action: "hold-size", camera: "cam0", encode: "preview", size: "854x480",
      reason: "a hold", at: 1_000_000,
    };
    viewers.decided([hold, step()]);
    expect(viewers.state("cam0", "v1").shared.step?.reason).toContain("steps from");

    const short: Decision = {
      action: "shortfall", camera: "cam0", encode: "preview",
      floorKbps: 300, carryingKbps: 200, reason: "nothing was changed", at: 1_000_001,
    };
    viewers.decided([hold, step(), short]);
    expect(viewers.state("cam0", "v1").shared.step?.reason).toBe("nothing was changed");
  });

  it("still reports a hold, because a hold is a decision", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.decided([{
      action: "hold-size", camera: "cam0", encode: "preview", size: "854x480",
      reason: "pinned at the floor for 2 s of the 5 s a step down needs", at: 1_000_000,
    }]);
    expect(viewers.state("cam0", "v1").overlay.step).toContain("of the 5 s a step down needs");
  });

  it("keeps one camera's step off another camera's picture", () => {
    const { viewers } = viewersOn({ cameras: [CAMERA, SECOND] });
    viewers.subscribe("v1", "cam0", "video");
    viewers.subscribe("v1", "cam1", "video");
    viewers.decided([step()]);
    expect(viewers.state("cam1", "v1").shared.step).toBeNull();
  });
});

describe("Viewers and the words the picture wears", () => {
  it("says full rate before anything else", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    viewers.fullRate("v1", "cam0", true);
    expect(viewers.state("cam0", "v1").overlay.head).toBe("full-rate");
  });

  it("says the floor when the preview is pinned to it", () => {
    const { viewers } = viewersOn({
      running: () => ({ stream: 2000, preview: 300, shape: { size: "640x360", fps: 15 } }),
    });
    viewers.subscribe("v1", "cam0", "video");
    const state = viewers.state("cam0", "v1");
    expect(state.shared.pinned).toBe(true);
    expect(state.overlay.head).toBe("floor");
  });

  it("says held when the operator chose the size", () => {
    const chosen = {
      ...CAMERA, preview: { ...CAMERA.preview, size: "854x480" },
    } as unknown as Camera;
    const { viewers } = viewersOn({ cameras: [chosen] });
    viewers.subscribe("v1", "cam0", "video");
    const state = viewers.state("cam0", "v1");
    expect(state.shared.held).toBe("854x480");
    expect(state.overlay.head).toBe("held");
  });

  it("says stills for a browser that is on stills", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "stills");
    const state = viewers.state("cam0", "v1");
    expect(state.overlay.head).toBe("stills");
    expect(state.mine.interval).toBe(5_000);
  });

  it("composes the readings the overlay draws, at IP, and never a raw number", () => {
    const { viewers } = viewersOn();
    viewers.subscribe("v1", "cam0", "video");
    const overlay = viewers.state("cam0", "v1").overlay;
    expect(overlay).toMatchObject({
      head: "adaptive",
      size: "854×480",
      rate: "15 fps",
      bitrate: "0.93 Mb/s",
      detail: "0.93 of 0.31–2.07",
    });
    expect(overlay.cost.view).toBe("0.93 Mb/s");
    expect(overlay.cost.path).toBe("3.00 Mb/s");
  });

  it("says nothing rather than zero about a camera with no pipeline", () => {
    const { viewers } = viewersOn({ running: () => null });
    viewers.subscribe("v1", "cam0", "video");
    const state = viewers.state("cam0", "v1");
    expect(state.shared).toMatchObject({ size: null, fps: null, kbps: null });
    expect(state.overlay.size).toBe("");
    expect(state.overlay.detail).toBe("");
  });
});
