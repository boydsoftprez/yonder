// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { RateController, type Decision, type LinkReport, type RateChannel } from "./rate.js";
import { EncoderChannel } from "./encoder.js";
import { compose, ENCODE_ELEMENT, PREVIEW_CAPS_ELEMENT } from "./pipeline.js";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";
import { noCapabilities, present } from "./capability.js";
import { atIp, fromIp } from "./present.js";
import type { Camera } from "../schema/config.js";

/**
 * One camera, adaptive at both ends, with an envelope wide enough that every
 * bound below is reached deliberately rather than by accident.
 *
 * `preview.size: "auto"` is the ladder's own mode — `pipeline.ts` starts such
 * a pipeline at `ladder_bottom`, so the controller climbs from the bottom.
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

/**
 * The ladder's own camera: the same one with the stream held still.
 *
 * An adaptive stream is served first and takes what it can up to its own
 * ceiling, which is the rule and is proved separately — but it would make the
 * preview's allowance the *stream's* variable rather than the link's, and the
 * ladder tests are about the preview.
 */
const LADDER = {
  ...CAMERA,
  stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
} as unknown as Camera;
/** What the running pipeline's 2000 kb/s stream costs on the link. */
const STREAM_COST = atIp(2000);

const THRESHOLDS = { tDown: 8_000, tUp: 20_000, hysteresisKbps: 100, staleAfterMs: 6_000 };

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

/**
 * A channel that answers for a pipeline the test decides the state of.
 *
 * **It answers from what it is holding, and moves only when it is told to**,
 * exactly as a real encoder does: a `retune` it accepts changes what
 * `inForce` reports next, and one it refuses does not. A controller that kept
 * its own copy of the encoder's rate would pass every test here against its
 * own bookkeeping; reading it back off this fake is what stops that.
 */
function fakeChannel(start: {
  stream?: number | null; preview?: number | null;
  size?: string | null; fps?: number;
} = {}) {
  const running = {
    stream: start.stream === undefined ? 2000 : start.stream,
    preview: start.preview === undefined ? 400 : start.preview,
    shape: start.size === null
      ? null
      : { size: (start.size ?? "640x360") as never, fps: start.fps ?? 15 },
  };
  const retunes: { encode: string; kbps: number }[] = [];
  const reshapes: { size: string; fps: number }[] = [];
  let refuse: string | null = null;
  let missing = false;

  const channel: RateChannel = {
    inForce: () => (missing ? null : { ...running }),
    retune: (_camera, encode, kbps) => {
      retunes.push({ encode, kbps });
      if (refuse !== null) return Promise.resolve({ notControllable: refuse });
      running[encode] = kbps;
      return Promise.resolve({ requested: kbps, observed: kbps, continuous: true, at: 0 });
    },
    reconfigurePreview: (_camera, shape) => {
      reshapes.push({ ...shape });
      if (refuse !== null) return Promise.resolve({ notControllable: refuse });
      running.shape = { ...shape } as never;
      return Promise.resolve({ requested: shape, observed: shape, continuous: true, at: 0 });
    },
  };
  return {
    channel, retunes, reshapes, running,
    refuseWith(reason: string | null) { refuse = reason; },
    stopRunning() { missing = true; },
  };
}

/** A report every field of which is deliberate; each test overrides what it
 *  is about and leaves the rest generous, so nothing passes by accident. */
function report(over: Partial<LinkReport> & { at: number }): LinkReport {
  return { viewer: "v1", rtt: 40, loss: 0, egress: 0, capacity: 8_000, ...over };
}

function controllerOn(opts: { camera?: Camera; thresholds?: Partial<typeof THRESHOLDS> } = {}) {
  const clock = fakeClock();
  const fake = fakeChannel();
  const applied = { camera: opts.camera ?? CAMERA };
  const controller = new RateController({
    channel: fake.channel,
    clock: clock.clock,
    policy: () => applied.camera,
    thresholds: { ...THRESHOLDS, ...opts.thresholds },
  });
  return { controller, clock, fake, applied };
}

const rateFor = (decisions: readonly Decision[], encode: string): Decision | undefined =>
  decisions.find((d) => d.encode === encode && d.action !== "size" && d.action !== "hold-size");
const sizeFor = (decisions: readonly Decision[]): Decision | undefined =>
  decisions.find((d) => d.action === "size" || d.action === "hold-size");

describe("RateController, inside the applied envelope", () => {
  it("never goes outside the applied envelope", async () => {
    // A link far wider than either ceiling. Both encodes stop at the number
    // the operator applied.
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();

    expect(rateFor(decisions, "stream")).toMatchObject({ action: "rate", kbps: 4000 });
    expect(rateFor(decisions, "preview")).toMatchObject({ action: "rate", kbps: 2000 });
    expect(fake.running.stream).toBe(4000);
    expect(fake.running.preview).toBe(2000);
  });

  it("obeys an envelope that moved by less than the hysteresis", async () => {
    // The envelope always wins over the deadband: a ceiling brought down past
    // the rate in force leaves the encoder outside what the operator applied,
    // and a controller that skipped the move for being small would leave it
    // there.
    const { controller, clock, fake, applied } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(4000);

    applied.camera = {
      ...CAMERA, stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 3950 },
    } as unknown as Camera;
    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(3950);
    expect(rateFor(decisions, "stream")!.reason).toContain("3950");
  });

  it("does not command a change smaller than the hysteresis", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: atIp(2000) }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(2000);
    const commanded = fake.retunes.length;

    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: atIp(2040) }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(commanded);
    expect(rateFor(decisions, "stream")).toMatchObject({ action: "hold-rate", kbps: 2000 });
  });

  it("reserves the stream's spend before the preview gets any", async () => {
    // Enough for the stream's ceiling and 400 kb/s at IP beyond it. The
    // preview gets exactly what is left over — not a share of the whole, and
    // not a kilobit more than the link has room for.
    const { controller, clock, fake } = controllerOn();
    const capacity = atIp(4000) + 400;
    fake.running.preview = 1000;                 // clear of the deadband either way
    controller.observe(report({ at: clock.at(), capacity }));
    controller.tick(clock.at());
    await controller.settled();

    expect(fake.running.stream).toBe(4000);
    const spent = atIp(fake.running.stream!) + atIp(fake.running.preview!);
    expect(spent).toBeLessThanOrEqual(capacity);
    expect(atIp(fake.running.stream!) + atIp(fake.running.preview! + 1))
      .toBeGreaterThan(capacity);
  });

  it("reserves what a Fixed stream actually costs, and never moves it", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    // The pipeline is running the stream at 2000; the preview may have what
    // the link carries beyond that and no more.
    const capacity = STREAM_COST + atIp(700);
    controller.observe(report({ at: clock.at(), capacity }));
    const decisions = controller.tick(clock.at());
    await controller.settled();

    expect(fake.retunes.map((r) => r.encode)).not.toContain("stream");
    expect(rateFor(decisions, "stream")).toMatchObject({ action: "hold-rate", kbps: 2000 });
    expect(fake.running.preview).toBe(700);
    expect(STREAM_COST + atIp(701)).toBeGreaterThan(capacity);
  });
});

describe("RateController, when the floor does not fit", () => {
  it("when even the floor cannot fit, it reports the shortfall and changes nothing", async () => {
    // Enough for the stream and nothing like the preview's floor.
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    controller.observe(report({ at: clock.at(), capacity: STREAM_COST + 100 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();

    const preview = rateFor(decisions, "preview");
    expect(preview).toMatchObject({ action: "shortfall", floorKbps: 300, carryingKbps: 100 });
    expect(preview!.reason).toContain("300");
    expect(fake.retunes).toHaveLength(0);
    expect(fake.running.preview).toBe(400);       // exactly where it was
    // Nothing means nothing: the ladder does not step either.
    expect(fake.reshapes).toHaveLength(0);
    expect(sizeFor(decisions)).toMatchObject({ action: "hold-size", size: "640x360" });
  });

  /**
   * **The picture steps down when the floor will not fit — the operator's
   * decision, 2026-09-06.**
   *
   * This asserted the opposite: that "report the shortfall and change
   * nothing" covered the ladder as well as the rate. He judged that the wrong
   * way round, and the reasoning is the point — a smaller picture is what
   * makes a floor's worth of bits go further, so the moment the floor will not
   * fit is the moment stepping down is worth most. Holding leaves a picture
   * that breaks up instead of one that degrades.
   */
  it("steps the picture down when the floor will not fit, so the bits go further", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: "1280x720", fps: 15 } as never;

    // Not on the first tick: a step down still waits tDown, so a moment's
    // narrowing does not shrink the picture.
    controller.observe(report({ at: clock.at(), capacity: STREAM_COST + 100 }));
    expect(sizeFor(controller.tick(clock.at())))
      .toMatchObject({ action: "hold-size", size: "1280x720" });
    await controller.settled();

    clock.advance(9_000);
    controller.observe(report({ at: clock.at(), capacity: STREAM_COST + 100 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(sizeFor(decisions)).toMatchObject({ action: "size", size: "854x480" });
    // The rate still changes nothing — there is no rate that fits, which is
    // what the shortfall says. Only the size moves.
    expect(fake.retunes).toHaveLength(0);
  });

  it("stops at the smallest size the operator allowed, and says that is why", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: LADDER.preview.ladder_bottom, fps: 15 } as never;
    for (let i = 0; i < 4; i += 1) {
      clock.advance(9_000);
      controller.observe(report({ at: clock.at(), capacity: STREAM_COST + 100 }));
      const decisions = controller.tick(clock.at());
      await controller.settled();
      expect(sizeFor(decisions)).toMatchObject({ action: "hold-size" });
    }
    // Never below the operator's own floor, however long the link stays thin.
    expect(fake.reshapes).toHaveLength(0);
    expect(fake.retunes).toHaveLength(0);
  });

  it("says so for the stream too, and reserves the floor it cannot fit", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 300 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();

    expect(rateFor(decisions, "stream")).toMatchObject({
      action: "shortfall", floorKbps: 500, carryingKbps: 300,
    });
    expect(fake.retunes).toHaveLength(0);
  });
});

describe("RateController and the size ladder", () => {
  const pin = { capacity: STREAM_COST + atIp(300) };
  const room = { capacity: 40_000 };
  const between = { capacity: STREAM_COST + atIp(1000) };

  it("steps down a rung only after being pinned at the floor for tDown", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    // Start the picture at the top so there is somewhere to fall to.
    fake.running.shape = { size: "1280x720", fps: 15 } as never;

    controller.observe(report({ at: clock.at(), ...pin }));
    expect(sizeFor(controller.tick(clock.at()))).toMatchObject({ action: "hold-size" });

    clock.advance(7_000);
    controller.observe(report({ at: clock.at(), ...pin }));
    expect(sizeFor(controller.tick(clock.at())))
      .toMatchObject({ action: "hold-size", size: "1280x720" });
    expect(fake.reshapes).toHaveLength(0);

    clock.advance(1_000);                        // tDown reached, and not before
    controller.observe(report({ at: clock.at(), ...pin }));
    const stepped = sizeFor(controller.tick(clock.at()));
    await controller.settled();
    expect(stepped).toMatchObject({ action: "size", size: "854x480" });
    expect(fake.reshapes).toEqual([{ size: "854x480", fps: 15 }]);
  });

  it("restarts the wait when the pinning is broken", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: "1280x720", fps: 15 } as never;
    controller.observe(report({ at: clock.at(), ...pin }));
    controller.tick(clock.at());

    clock.advance(7_000);
    controller.observe(report({ at: clock.at(), ...between }));
    controller.tick(clock.at());                 // room again: the wait resets

    clock.advance(7_000);
    controller.observe(report({ at: clock.at(), ...pin }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.reshapes).toHaveLength(0);
  });

  it("steps up only after headroom for tUp, and not straight back down", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    controller.observe(report({ at: clock.at(), ...room }));
    expect(sizeFor(controller.tick(clock.at())))
      .toMatchObject({ action: "hold-size", size: "640x360" });

    clock.advance(19_000);
    controller.observe(report({ at: clock.at(), ...room }));
    controller.tick(clock.at());
    expect(fake.reshapes).toHaveLength(0);

    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), ...room }));
    const up = sizeFor(controller.tick(clock.at()));
    await controller.settled();
    expect(up).toMatchObject({ action: "size", size: "854x480" });

    // The link has not changed, so nothing steps back; and the pinning clock
    // starts again from here rather than carrying over.
    clock.advance(9_000);
    controller.observe(report({ at: clock.at(), ...room }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.reshapes).toEqual([{ size: "854x480", fps: 15 }]);
  });

  it("stops at the ends of the applied ladder", async () => {
    const capped = {
      ...LADDER, preview: { ...CAMERA.preview, ladder_top: "854x480" },
    } as unknown as Camera;
    const up = controllerOn({ camera: capped });
    up.fake.running.shape = { size: "854x480", fps: 15 } as never;
    for (let i = 0; i < 4; i += 1) {
      up.clock.advance(21_000);
      up.controller.observe(report({ at: up.clock.at(), ...room }));
      up.controller.tick(up.clock.at());
      await up.controller.settled();
    }
    expect(up.fake.reshapes).toHaveLength(0);

    const down = controllerOn({ camera: LADDER });   // already at ladder_bottom
    for (let i = 0; i < 4; i += 1) {
      down.clock.advance(9_000);
      down.controller.observe(report({ at: down.clock.at(), ...pin }));
      down.controller.tick(down.clock.at());
      await down.controller.settled();
    }
    expect(down.fake.reshapes).toHaveLength(0);
  });

  it("brings a picture outside the applied ladder back inside it at once", async () => {
    // The operator lowers the ladder's top under a picture that had already
    // climbed above it. No launch line changed, so no respawn will fix it.
    const { controller, clock, fake, applied } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: "1280x720", fps: 15 } as never;
    applied.camera = {
      ...LADDER, preview: { ...CAMERA.preview, ladder_top: "854x480" },
    } as unknown as Camera;
    controller.observe(report({ at: clock.at(), ...between }));
    const decision = sizeFor(controller.tick(clock.at()));
    await controller.settled();
    expect(decision).toMatchObject({ action: "size", size: "854x480" });
    expect(decision!.reason).toContain("tops out");
  });

  it("keeps the rate the preview branch is running when it steps", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: "1280x720", fps: 9 } as never;   // not the applied 15
    controller.observe(report({ at: clock.at(), ...pin }));
    controller.tick(clock.at());
    clock.advance(9_000);
    controller.observe(report({ at: clock.at(), ...pin }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.reshapes).toEqual([{ size: "854x480", fps: 9 }]);
  });

  it("a held size never steps; Fixed never moves", async () => {
    const pinnedSize = {
      ...LADDER, preview: { ...CAMERA.preview, size: "1280x720" },
    } as unknown as Camera;
    const a = controllerOn({ camera: pinnedSize });
    a.fake.running.shape = { size: "1280x720", fps: 15 } as never;
    let held: Decision | undefined;
    for (let i = 0; i < 4; i += 1) {
      a.clock.advance(9_000);
      a.controller.observe(report({ at: a.clock.at(), ...pin }));
      held = sizeFor(a.controller.tick(a.clock.at()));
      await a.controller.settled();
    }
    expect(a.fake.reshapes).toHaveLength(0);
    expect(held).toMatchObject({ action: "hold-size", size: "1280x720" });
    expect(held!.reason).toContain("held");

    const fixed = {
      ...LADDER, preview: { ...CAMERA.preview, mode: "fixed" },
    } as unknown as Camera;
    // Fixed holds its target *and* its size (spec §8.1), so the link is left
    // with every reason to step the picture up and enough ticks to do it.
    const b = controllerOn({ camera: fixed });
    b.fake.running.shape = { size: "640x360", fps: 15 } as never;
    let decisions: Decision[] = [];
    for (let i = 0; i < 4; i += 1) {
      b.clock.advance(21_000);
      b.controller.observe(report({ at: b.clock.at(), ...room }));
      decisions = b.controller.tick(b.clock.at());
      await b.controller.settled();
    }
    expect(b.fake.retunes).toHaveLength(0);
    expect(b.fake.reshapes).toHaveLength(0);
    expect(rateFor(decisions, "preview")).toMatchObject({ action: "hold-rate" });
    expect(sizeFor(decisions)).toMatchObject({ action: "hold-size", size: "640x360" });
  });
});

describe("RateController and the evidence it acts on", () => {
  it("uses the most constrained fresh report; a stale one is not headroom", async () => {
    const { controller, clock, fake } = controllerOn();
    // Two viewers. One says the link is wide; the other, on the same path,
    // can carry far less. The narrow one decides.
    controller.observe(report({ viewer: "wide", at: clock.at(), capacity: 40_000 }));
    controller.observe(report({ viewer: "narrow", at: clock.at(), capacity: atIp(900) }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(900);

    // The narrow viewer goes quiet. Its last word is not thereby better news:
    // it drops out of the evidence, and the wide report is all that is left.
    clock.advance(7_000);
    controller.observe(report({ viewer: "wide", at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(4000);

    // And the other way round: a stale wide report cannot raise anything.
    const b = controllerOn();
    b.controller.observe(report({ viewer: "wide", at: b.clock.at(), capacity: 40_000 }));
    b.clock.advance(7_000);
    b.controller.observe(report({ viewer: "narrow", at: b.clock.at(), capacity: atIp(900) }));
    b.controller.tick(b.clock.at());
    await b.controller.settled();
    expect(b.fake.running.stream).toBe(900);
  });

  it("with no fresh evidence it holds and reports unknown", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    clock.advance(6_001);
    const decisions = controller.tick(clock.at());
    await controller.settled();

    expect(fake.retunes).toHaveLength(0);
    expect(fake.reshapes).toHaveLength(0);
    expect(decisions.map((d) => d.action)).toEqual(["hold-rate", "hold-rate", "hold-size"]);
    for (const decision of decisions) expect(decision.reason).toContain("no fresh");
  });

  it("does not let a wait run on through a silence", async () => {
    // The pinning clock measures observed pinning, not elapsed time. A gap in
    // the evidence is not evidence that the pinning continued.
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    fake.running.shape = { size: "1280x720", fps: 15 } as never;
    controller.observe(report({ at: clock.at(), capacity: STREAM_COST + atIp(300) }));
    controller.tick(clock.at());

    clock.advance(7_000);
    controller.tick(clock.at());                 // nothing fresh: the wait resets
    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: STREAM_COST + atIp(300) }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.reshapes).toHaveLength(0);
  });

  it("will not take a report stamped after the moment it is asked about", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at() + 30_000, capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(0);
    expect(decisions[0].reason).toContain("no fresh");
  });

  it("will not take a report whose numbers are not numbers", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: Number.NaN }));
    controller.observe(report({ viewer: "v2", at: clock.at(), loss: 4 }));
    controller.observe(report({ viewer: "v3", at: clock.at(), capacity: -1 }));
    controller.observe(report({ viewer: "", at: clock.at() }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(0);
    expect(decisions[0].reason).toContain("no fresh");
  });

  it("discounts a capacity by what the link is losing", async () => {
    const { controller, clock, fake } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: atIp(4000), loss: 0.5 }));
    controller.tick(clock.at());
    await controller.settled();
    // Half of what it measured is what it is carrying, and that is what the
    // stream may have — not the measurement.
    expect(fake.running.stream).toBe(fromIp(Math.floor(atIp(4000) * 0.5)));
    expect(fake.running.stream).toBe(2000);
  });

  it("withholds headroom from a link that is queueing", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    controller.observe(report({ at: clock.at(), capacity: 40_000, rtt: 30 }));
    controller.tick(clock.at());
    for (let i = 0; i < 4; i += 1) {
      clock.advance(7_000);
      // Room by every arithmetic measure, and a round trip ten times this
      // link's own best: the queue is the capacity, and it is not headroom.
      controller.observe(report({ at: clock.at(), capacity: 40_000, rtt: 300 }));
      controller.tick(clock.at());
      await controller.settled();
    }
    expect(fake.reshapes).toHaveLength(0);
  });

  it("withholds headroom while more is leaving than the link carries", async () => {
    const { controller, clock, fake } = controllerOn({ camera: LADDER });
    for (let i = 0; i < 4; i += 1) {
      clock.advance(7_000);
      controller.observe(report({
        at: clock.at(), capacity: 40_000, loss: 0.1, egress: 39_000,
      }));
      controller.tick(clock.at());
      await controller.settled();
    }
    expect(fake.reshapes).toHaveLength(0);
  });
});

describe("RateController and the policy it reads", () => {
  it("ignores a draft and reads only the applied policy", async () => {
    // The shape the daemon actually holds: an applied camera, and a draft the
    // operator is still editing laid over it. Only the first is the
    // controller's business — a draft is not a decision yet.
    const store = {
      applied: CAMERA,
      draft: {
        ...CAMERA, stream: { mode: "adaptive", floor_kbps: 100, ceiling_kbps: 200 },
      } as unknown as Camera,
    };
    const clock = fakeClock();
    const fake = fakeChannel();
    const controller = new RateController({
      channel: fake.channel, clock: clock.clock,
      policy: () => store.applied, thresholds: THRESHOLDS,
    });

    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(4000);      // the applied ceiling, not the draft's 200

    // And when the draft is applied it is obeyed — so the assertion above is
    // not passing because nothing could ever change.
    store.applied = store.draft;
    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.running.stream).toBe(200);
  });

  it("asks for the applied policy again on every tick", () => {
    const clock = fakeClock();
    const fake = fakeChannel();
    const asked = vi.fn(() => CAMERA);
    const controller = new RateController({
      channel: fake.channel, clock: clock.clock, policy: asked, thresholds: THRESHOLDS,
    });
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    clock.advance(1_000);
    controller.tick(clock.at());
    expect(asked.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("holds a disabled camera and commands nothing", async () => {
    const { controller, clock, fake } = controllerOn({
      camera: { ...CAMERA, enabled: false } as unknown as Camera,
    });
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(0);
    for (const decision of decisions) expect(decision.reason).toContain("disabled");
  });

  it("holds when nothing is running to command", async () => {
    const { controller, clock, fake } = controllerOn();
    fake.stopRunning();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(0);
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) expect(decision.reason).toContain("nothing is running");
  });

  it("holds a feed that carries the source's own encoding", async () => {
    const clock = fakeClock();
    const fake = fakeChannel({ stream: null });
    const controller = new RateController({
      channel: fake.channel, clock: clock.clock,
      policy: () => CAMERA, thresholds: THRESHOLDS,
    });
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes.map((r) => r.encode)).not.toContain("stream");
    expect(rateFor(decisions, "stream")).toMatchObject({ action: "hold-rate", kbps: null });
  });
});

describe("RateController, when the pipeline will not take an instruction", () => {
  it("reports the refusal and does not command the same thing again", async () => {
    const { controller, clock, fake } = controllerOn();
    fake.refuseWith("cam0's pipeline has no control channel");
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(2);

    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const again = controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(2);        // not asked a second time
    expect(rateFor(again, "stream")).toMatchObject({ action: "hold-rate" });
    expect(rateFor(again, "stream")!.reason).toContain("no control channel");
  });

  it("tries again when the link asks for something different", async () => {
    const { controller, clock, fake } = controllerOn();
    fake.refuseWith("cam0's pipeline has no control channel");
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes).toHaveLength(2);

    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: atIp(1000) }));
    controller.tick(clock.at());
    await controller.settled();
    expect(fake.retunes.length).toBeGreaterThan(2);
  });

  it("reports a command that threw as a command that did not happen", async () => {
    const clock = fakeClock();
    const fake = fakeChannel();
    const channel: RateChannel = {
      ...fake.channel,
      retune: () => Promise.reject(new Error("the pipe is closed")),
    };
    const controller = new RateController({
      channel, clock: clock.clock, policy: () => CAMERA, thresholds: THRESHOLDS,
    });
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    controller.tick(clock.at());
    await controller.settled();
    clock.advance(1_000);
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const again = controller.tick(clock.at());
    expect(rateFor(again, "stream")!.reason).toContain("the pipe is closed");
  });
});

describe("RateController reports every decision", () => {
  it("every decision carries a reason", () => {
    const cases: { name: string; run: () => Decision[] }[] = [];
    const wide = controllerOn();
    wide.controller.observe(report({ at: wide.clock.at(), capacity: 40_000 }));
    cases.push({ name: "room", run: () => wide.controller.tick(wide.clock.at()) });

    const tight = controllerOn();
    tight.controller.observe(report({ at: tight.clock.at(), capacity: 200 }));
    cases.push({ name: "shortfall", run: () => tight.controller.tick(tight.clock.at()) });

    const quiet = controllerOn();
    cases.push({ name: "silence", run: () => quiet.controller.tick(quiet.clock.at()) });

    for (const { name, run } of cases) {
      const decisions = run();
      expect(decisions, name).toHaveLength(3);
      for (const decision of decisions) {
        expect(decision.reason.length, `${name}: ${decision.action}`).toBeGreaterThan(0);
        expect(decision.camera, name).toBe("cam0");
        expect(decision.at, name).toBeTypeOf("number");
      }
    }
  });

  it("names both encodes and the size, once each, every tick", () => {
    const { controller, clock } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    const decisions = controller.tick(clock.at());
    const subject = (d: Decision): string =>
      `${d.encode}/${d.action === "size" || d.action === "hold-size" ? "size" : "rate"}`;
    expect(decisions.map(subject)).toEqual(["stream/rate", "preview/rate", "preview/size"]);
  });

  it("takes its own clock when it is not given a moment", () => {
    const { controller, clock } = controllerOn();
    controller.observe(report({ at: clock.at(), capacity: 40_000 }));
    expect(controller.tick()[0].at).toBe(clock.at());
  });
});

/**
 * The last hop, over the real channel and a real launch line.
 *
 * Everything above proves the controller's arithmetic against a fake that
 * answers. These prove the number it decides on arrives at the element that
 * carries it — through `EncoderChannel`, `Supervisor.send`, JSON and back —
 * because a rate that is right in a decision and never reaches
 * `extra-controls` is this branch's most common defect.
 */
describe("RateController over the real encoder channel", () => {
  const CAPS = {
    ...noCapabilities(),
    formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
  };
  const HW = {
    element: "v4l2h264enc" as const, h265: null, decoder: null, device: "/dev/video11", hardware: true,
    detail: "hardware H.264 on /dev/video11",
  };
  interface Sent {
    id: number; op: string;
    sets: { element: string; property: string; value: string }[];
  }

  function board(camera: Camera = CAMERA) {
    const sent: Sent[] = [];
    const inbox: ((line: string) => void)[] = [];
    const spawner: ProcessSpawner = () => ({
      kill: vi.fn(), on: vi.fn(),
      send: (line: string) => { sent.push(JSON.parse(line) as Sent); },
      onMessage: (fn: (line: string) => void) => { inbox.push(fn); },
    } as SpawnedProcess);
    const timers: { at: number; fn: () => void }[] = [];
    let now = 1_000_000;
    const clock = {
      now: () => now,
      setTimer: (ms: number, fn: () => void) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimer: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    };
    const argv = (): string[] => compose({
      camera, capabilities: CAPS, encoder: HW, rtspBase: "rtsp://127.0.0.1:8554",
    });
    const supervisor = new Supervisor({ spawner, clock });
    supervisor.start(camera.id, argv());
    const channel = new EncoderChannel({ supervisor, clock });
    const controller = new RateController({
      channel, clock, policy: () => camera, thresholds: THRESHOLDS,
    });
    return {
      controller, channel, supervisor, sent, clock, argv,
      at: () => now,
      advance(ms: number) {
        now += ms;
        for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      },
      answer(index: number, observed: unknown) {
        const line = JSON.stringify({
          id: sent[index].id, pid: 4200, continuous: true, observed,
        });
        for (const fn of inbox) fn(line);
      },
    };
  }

  it("puts the rate it decided on into the running encoder's own control", () => {
    const b = board();
    b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
    b.controller.tick(b.at());
    expect(b.sent).toHaveLength(2);
    expect(b.sent[0]).toMatchObject({
      op: "retune",
      sets: [{
        element: ENCODE_ELEMENT.stream, property: "extra-controls",
        value: "controls,video_bitrate_mode=1,video_bitrate=4000000",
      }],
    });
    expect(b.sent[1].sets[0].element).toBe(ENCODE_ELEMENT.preview);
    expect(b.sent[1].sets[0].value).toContain("video_bitrate=2000000");
    // The preview keeps its short keyframe interval through the retune.
    expect(b.sent[1].sets[0].value).toContain("h264_i_frame_period=15");
  });

  it("reads the rate back off the encoder, not off its own bookkeeping", async () => {
    const b = board();
    b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
    b.controller.tick(b.at());
    // The encoder confirms a rate it rounded to something of its own. The
    // next tick must reason from that and not from what was asked for: 3960
    // is inside the deadband of 4000, so nothing is commanded again.
    b.answer(0, 3960);
    b.advance(2_000);                            // the preview's request times out
    await b.controller.settled();

    const before = b.sent.length;
    b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
    const decisions = b.controller.tick(b.at());
    expect(rateFor(decisions, "stream")).toMatchObject({ action: "hold-rate", kbps: 3960 });
    expect(b.sent).toHaveLength(before + 1);     // the preview only
  });

  it("puts a rung into the preview's own capsfilter and touches no other branch", () => {
    const b = board();
    for (let i = 0; i < 3; i += 1) {
      b.advance(21_000);
      b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
      b.controller.tick(b.at());
    }
    const reshape = b.sent.filter((s) => s.op === "reconfigure-preview");
    expect(reshape).toHaveLength(1);
    expect(reshape[0].sets.map((s) => s.element))
      .toEqual([PREVIEW_CAPS_ELEMENT.scale, PREVIEW_CAPS_ELEMENT.rate]);
    expect(reshape[0].sets[0].value).toBe("video/x-raw,width=854,height=480");
    for (const set of reshape[0].sets) expect(set.element).not.toBe(ENCODE_ELEMENT.stream);
  });

  it("re-reads what a restarted pipeline is running rather than what it last asked for", async () => {
    const b = board();
    b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
    b.controller.tick(b.at());
    b.answer(0, 4000);
    b.advance(2_000);
    await b.controller.settled();
    expect(b.channel.inForce("cam0")).toMatchObject({ stream: 4000 });

    // The pipeline died and came back on its launch line, at 2000.
    b.supervisor.stop("cam0");
    b.advance(1_000);
    b.supervisor.start("cam0", b.argv());
    expect(b.channel.inForce("cam0")).toMatchObject({ stream: 2000 });

    b.controller.observe(report({ at: b.at(), capacity: 40_000 }));
    b.controller.tick(b.at());
    const retunes = b.sent.filter((s) => s.op === "retune");
    expect(retunes[retunes.length - 2].sets[0].value).toContain("video_bitrate=4000000");
  });
});

describe('receiver feedback without a bandwidth estimate', () => {
  function fixture() {
    const f = fakeChannel({ preview: 500 });
    const camera = { ...CAMERA, outputs: [], preview: { ...CAMERA.preview, floor_kbps: 500 } } as Camera;
    const controller = new RateController({ channel: f.channel, policy: () => camera, thresholds: THRESHOLDS });
    const sample = async (at: number, patch: Partial<LinkReport> = {}) => {
      controller.observe({ viewer: 'browser', rtt: 40, loss: 0, egress: 600, capacity: null, encode: 'preview', at, ...patch });
      const decisions = controller.tick(at); await controller.settled(); return decisions;
    };
    return { ...f, camera, controller, sample };
  }
  it('probes healthy delivery, backs off under loss, then recovers inside the applied bounds', async () => {
    const f = fixture();
    for (let at = 0; at <= 10000; at += 1000) await f.sample(at);
    const peak = f.channel.inForce('cam0')!.preview!;
    expect(peak).toBeGreaterThan(500);
    expect(f.retunes.every(change => change.encode === 'preview')).toBe(true);
    await f.sample(11000, { loss: .1 }); await f.sample(12000, { loss: .1 });
    expect(f.channel.inForce('cam0')!.preview).toBeLessThan(peak);
    for (let at = 13000; at <= 20000; at += 1000) await f.sample(at);
    expect(f.channel.inForce('cam0')!.preview).toBeGreaterThan(500);
    expect(f.retunes.every(change => change.kbps >= 500 && change.kbps <= 2000)).toBe(true);
  });
  it('holds duplicate, stale and unseen-output feedback, and honors Fixed', async () => {
    const f = fixture(); await f.sample(0);
    f.controller.tick(5000); await f.controller.settled();
    f.controller.tick(7000); await f.controller.settled();
    expect(f.retunes).toEqual([]);
    f.camera.preview.mode = 'fixed';
    for (let at = 8000; at <= 20000; at += 1000) await f.sample(at);
    expect(f.retunes).toEqual([]);
  });
  it('repairs an out-of-bounds launch rate without claiming to know link capacity', async () => {
    const f = fixture(); f.camera.preview.floor_kbps = 800;
    const decisions = f.controller.tick(0); await f.controller.settled();
    expect(f.channel.inForce('cam0')!.preview).toBe(800);
    expect(decisions[1].reason).toContain('not a measured');
  });
  it('reacts to RTT inflation and to the constrained viewer', async () => {
    const f = fixture();
    for (let at=0; at<=10000; at+=1000) await f.sample(at);
    const peak = f.channel.inForce('cam0')!.preview!;
    await f.sample(11000, { rtt: 250 });
    await f.sample(12000, { rtt: 250 });
    expect(f.channel.inForce('cam0')!.preview).toBeLessThan(peak);
    f.controller.observe({ viewer:'slow', rtt:40, loss:.2, egress:300, capacity:null, encode:'preview', at:13000 });
    const decisions=await f.sample(13000);
    expect(decisions[1].reason).toContain('congestion');
  });
  it('requires a new healthy interval after feedback goes stale', async () => {
    const f = fixture(); await f.sample(0); await f.sample(4000);
    f.controller.tick(11000); await f.controller.settled();
    await f.sample(12000); expect(f.retunes).toHaveLength(0);
    await f.sample(17000); expect(f.retunes).toHaveLength(1);
  });
  it('steps an automatic preview down at the floor and respects a held size', async () => {
    const f = fixture(); f.running.shape = {size:'1280x720',fps:15} as never;
    for (let at=0; at<=8000; at+=1000) await f.sample(at,{loss:.1});
    expect(f.reshapes).toEqual([{size:'854x480',fps:15}]);
    f.camera.preview.size='854x480';
    for (let at=9000; at<=25000; at+=1000) await f.sample(at,{loss:.1});
    expect(f.reshapes).toHaveLength(1);
  });
  it('latches an encoder refusal instead of repeating the same request every tick', async () => {
    const f = fixture(); f.refuseWith('unsupported');
    for (let at=0; at<=20000; at+=1000) await f.sample(at);
    expect(f.retunes).toEqual([{encode:'preview',kbps:550}]);
  });
  it('does not reserve an unused main stream from measured preview capacity', async () => {
    const f = fixture();
    // An explicitly aggregate link report retains the measured-capacity path.
    await f.sample(0, { capacity: atIp(1200), encode: undefined });
    expect(f.channel.inForce('cam0')!.preview).toBe(1200);
  });
});


it('probes healthy browser delivery even when its estimate stays at 400 kb/s and RTSP is configured', async () => {
  const f=fakeChannel({preview:400});
  const controller=new RateController({channel:f.channel,policy:()=>CAMERA,thresholds:THRESHOLDS});
  for (let at=0;at<=15000;at+=1000) {
    controller.observe({viewer:'browser',encode:'preview',capacity:400,egress:400,rtt:40,loss:0,at});
    controller.tick(at);await controller.settled();
  }
  expect(f.running.preview).toBeGreaterThan(400);
  expect(f.retunes.every(change=>change.encode==='preview')).toBe(true);
});
