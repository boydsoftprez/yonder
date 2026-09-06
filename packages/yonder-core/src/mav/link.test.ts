// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Clock } from "../apply/types.js";
import type { EndpointStats } from "./router/stats.js";
import { LinkTracker } from "./link.js";

function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  return {
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
    advance(ms) { now += ms; },
  };
}

const vehicle = { system: 1, component: 1, vehicleType: 1, autopilot: 3, fromVehicle: true };
const gcs = { system: 255, component: 190, vehicleType: 6, autopilot: 8, fromVehicle: false };

describe("LinkTracker", () => {
  it("starts out searching, with nothing to report", () => {
    expect(new LinkTracker().state()).toMatchObject({ phase: "searching", device: null, vehicle: null });
  });

  // The full shape of a tracker nobody has fed yet (§the brief's "state()
  // called before any sample has arrived"), so a field a later task adds a
  // reader for has a documented starting point rather than "whatever
  // toMatchObject happened not to check".
  it("reports every field as empty before anything has been observed, heard or sampled", () => {
    expect(new LinkTracker().state()).toEqual({
      phase: "searching",
      device: null,
      baud: null,
      vehicle: null,
      system: null,
      heartbeatHz: null,
      lastHeardMs: null,
      groundStations: [],
      triedBauds: [],
      traffic: null,
      tcpClients: null,
    });
  });

  it("carries silence through as the wiring case, with the rates tried", () => {
    const t = new LinkTracker();
    t.observed({ kind: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600] });
    expect(t.state()).toMatchObject({ phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600] });
  });

  it("carries noise through as its own phase (R-MAV-13)", () => {
    const t = new LinkTracker();
    t.observed({ kind: "noise", device: "/dev/ttyAMA0", triedBauds: [57600], bytes: 800 });
    expect(t.state().phase).toBe("noise");
  });

  it("reports the vehicle and speed once a link is found", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    expect(t.state()).toMatchObject({ phase: "linked", baud: 57600, vehicle: "ArduPlane", system: 1 });
  });

  // A fresh sweep result is a new measurement of the link itself. Carrying a
  // stale vehicle name through a sweep that just came back silent would be
  // reporting something this observation never measured — the same mistake
  // §6 made about ground stations, one level up.
  it("drops the old vehicle when a later sweep finds silence instead", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.observed({ kind: "silent", device: "/dev/ttyAMA0", triedBauds: [57600] });
    expect(t.state()).toMatchObject({ phase: "silent", vehicle: null, baud: null, system: null });
  });

  it("computes a heartbeat rate from arrivals, not from a configured number", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    for (let i = 0; i < 5; i += 1) { t.heard(vehicle); clock.advance(1_000); }
    expect(t.state().heartbeatHz).toBeCloseTo(1, 1);
  });

  // heartbeatHz demands two arrivals before it will claim a rate at all — a
  // single beat fixes no interval, so no measurement backs a number yet.
  it("reports no heartbeat rate from a single arrival", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().heartbeatHz).toBeNull();
    expect(t.state().lastHeardMs).toBe(0);
  });

  // lastHeardMs is asked, not pushed: state() has no timer of its own, so
  // "how long ago" has to grow between calls even when nothing new arrived,
  // or a console left open on a lost link would read the last good moment
  // forever.
  it("keeps aging lastHeardMs between state() calls when nothing new arrives", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    clock.advance(2_500);
    expect(t.state().lastHeardMs).toBe(2_500);
    clock.advance(2_500);
    expect(t.state().lastHeardMs).toBe(5_000);
  });

  // frame.ts's `fromVehicle` is what separates the aircraft's own heartbeat
  // from a ground station's — a GCS heartbeats back too (that is the whole
  // premise of §6), and mixing one into this ring would corrupt the vehicle's
  // own rate with an arrival that says nothing about it.
  it("counts only the vehicle's own heartbeats toward the rate, never a ground station's", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    clock.advance(1_000);
    t.heard(gcs);
    clock.advance(1_000);
    t.heard(vehicle);
    // Only two vehicle heartbeats were ever heard, 2 s apart - a ground
    // station's heartbeat arriving in between must not count as a second
    // vehicle arrival at half the true interval.
    expect(t.state().heartbeatHz).toBeCloseTo(0.5, 1);
  });

  // §6: this is the whole point — "configured" is not "connected". The
  // attribution comes from the router's own counters (Task 8b), never from the
  // merged loopback copy, in which every ground station identifies itself the
  // same way. Measured on a board 2026-09-05: the answering endpoint's count
  // tracked its replies exactly and the silent one stayed at zero.
  //
  // receivedKb/transmittedKb default to mirroring the message counts so
  // every test that does not care about the traffic sparkline can ignore
  // them entirely, while still keeping sampled()'s backwards-counter guard
  // self-consistent (a call site that makes `received` decrease for a
  // restart test gets a decreasing `receivedKb` for free, matching the real
  // router where every counter resets together). Tests that exercise the
  // traffic figure itself pass explicit, distinct values.
  const udp = (name: string, received: number, transmitted: number, receivedKb = received, transmittedKb = transmitted): EndpointStats =>
    ({ name, kind: "udp", received, transmitted, crcErrors: 0, sequenceLost: 0, receivedKb, transmittedKb });

  it("calls a ground station answering only once its own counter has moved", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);

    t.sampled([udp("gcs0", 0, 954), udp("gcs1", 0, 954)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);

    clock.advance(1_000);
    t.sampled([udp("gcs0", 21, 1008), udp("gcs1", 0, 1008)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // The console must be able to say *which* one went quiet, which is the
  // whole reason this is an array — and "went quiet" is a transition: both
  // stations must be honestly established as answering first, with a real
  // counter increase against a trustworthy prior, and only then does one
  // keep replying while the other goes flat.
  //
  // Correction from review round two (2026-09-05), corrected again in round
  // three: the brief's own version of this test seeded both stations at a
  // non-zero `received` on their very first sampled() call and expected
  // gcs1 — whose counter then never moved again — to still read
  // `lastHeardMs: 7_000` at the end, crediting that first sighting itself as
  // an answer. Round two's fix changed only the final expectation to
  // `lastHeardMs: null`, which is correct under the rule but stopped this
  // test from proving a transition at all: a station that never once
  // increases was never answering to begin with, merely never-answering,
  // which "reports a configured station absent from the statistics as never
  // heard" and "never credits a first sighting as answering..." already
  // cover. This version gives gcs1 a real, counter-verified answer before
  // letting it go quiet, so the assertion exercises the one thing an array
  // of per-station state exists for: naming the one that stopped while the
  // other keeps going.
  it("names the station that went quiet, not merely that one did", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    // gcs1's very first sighting is already non-zero - it may have answered
    // the router at any point before this tracker existed (R-MAV-06) - and
    // must not be credited as answering on that total alone. Checking this
    // here, before any genuine increase would overwrite it, is what makes
    // this test actually depend on that rule: a version of this test that
    // starts every station at zero would pass even with the old, wrong
    // "non-zero first sighting answers now" fallback reinstated, because a
    // later genuine increase overwrites whatever a first sighting recorded
    // regardless of which rule produced it.
    t.sampled([udp("gcs0", 0, 60), udp("gcs1", 5, 60)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);

    clock.advance(1_000);
    // Both now genuinely answer - a real increase against a trustworthy
    // prior, not a first-sighting total.
    t.sampled([udp("gcs0", 1, 120), udp("gcs1", 6, 120)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: true, lastHeardMs: 0 },
    ]);

    clock.advance(1_000);
    // gcs0 keeps answering; gcs1 goes flat, but is still within windowMs.
    t.sampled([udp("gcs0", 2, 180), udp("gcs1", 6, 180)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: true, lastHeardMs: 1_000 },
    ]);

    clock.advance(6_000);
    // gcs0 is still answering every sample; gcs1's silence has now outlasted
    // windowMs, and the tracker must name gcs1, not gcs0, as the one that
    // went quiet.
    t.sampled([udp("gcs0", 3, 540), udp("gcs1", 6, 540)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: false, lastHeardMs: 7_000 },
    ]);
  });

  // `kind` cannot do this filtering: `yonder` (the control plane's own
  // loopback copy, always present, R-MAV-05) and `inbound` (the ingest
  // listener, present once R-MAV-07 is opened) are both legitimately UDP,
  // indistinguishable from a real ground station by kind alone — and
  // `yonder`'s counter moves continuously whenever telemetry is flowing at
  // all, so a kind-only filter would show Yonder's own control-plane copy as
  // a permanently-answering ground station, on every device, every boot.
  // Attribution is by name against the configured set instead, which is why
  // `sampled` takes it as a second argument.
  it("keeps only the endpoints in the configured ground-station set, in that order", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([
      udp("gcs0", 0, 954),
      { name: "autopilot", kind: "uart", received: 955, transmitted: 0, crcErrors: 0, sequenceLost: 0, receivedKb: 34, transmittedKb: 0 },
      udp("yonder", 40, 40),
      udp("inbound", 0, 0),
      udp("gcs1", 0, 954),
    ], ["gcs0", "gcs1"]);
    expect(t.state().groundStations.map((g) => g.name)).toEqual(["gcs0", "gcs1"]);
  });

  // Even a `yonder`/`inbound` counter that happens to be *higher* than a real
  // ground station's must never leak in: the filter is by name membership,
  // not by "everything except the UART", so this must hold regardless of
  // which numbers the reserved endpoints carry.
  it("never attributes the reserved yonder or inbound endpoints, however their counters move", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 10), udp("yonder", 40, 40), udp("inbound", 12, 0)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 0, 20), udp("yonder", 90, 90), udp("inbound", 30, 0)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // A ground station configured but not yet in the router's own statistics
  // at all — the router has not started, or the endpoint was just added —
  // must read as "nothing heard", not throw and not be silently omitted.
  it("reports a configured station absent from the statistics as never heard", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // A block missing from one particular reading — router/stats.ts drops a
  // truncated block outright — must not be read as "went silent this
  // instant": a station's last *genuine* answer keeps aging normally rather
  // than being wiped by a read that simply did not carry it this time.
  it("keeps a station's last answer when one reading omits it, rather than resetting it", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    // Establish a real answer for gcs1 first: its counter genuinely
    // increases against a trustworthy prior, which is what makes the
    // timestamp that follows an actual measurement rather than a total.
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 0, 10)], ["gcs0", "gcs1"]);
    clock.advance(500);
    t.sampled([udp("gcs0", 0, 20), udp("gcs1", 5, 20)], ["gcs0", "gcs1"]);
    clock.advance(500);
    // gcs1's block was cut short this reading and parseStats dropped it.
    t.sampled([udp("gcs0", 0, 30)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: true, lastHeardMs: 500 },
    ]);
  });

  // The configured set can change between readings — an endpoint added or
  // removed in config.yaml. Removed means gone from the report entirely, not
  // carried forward as a stale row; added means it starts exactly like any
  // other station seen for the first time.
  it("drops a ground station's row the moment it leaves the configured set", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 5, 10)], ["gcs0", "gcs1"]);
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 5, 10)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // gcs1 already has a non-zero counter the first moment it is watched — it
  // may have answered at any point since the router started, which could be
  // long before this name was ever added to the configured set, so its
  // first sighting is reported exactly like a brand new station's: not yet
  // known to be answering. "Not backfilled" cuts both ways — no history is
  // invented for it, including a plausible-looking "just now".
  it("adds a newly configured ground station as freshly seen, not backfilled", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 10)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 3, 6)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // The router's counters are cumulative since it started (§the bench note):
  // a lower reading than last time means the router itself restarted, not
  // that a ground station un-answered. TrafficSampler (remote/sampler.ts)
  // solves this exact problem by discarding the stale baseline; this follows
  // the same rule, per endpoint — and, per the correction above, an
  // immediate post-restart reading that is already non-zero is *still* only
  // a total, not a rate: it is treated exactly like a first sighting, not
  // credited as answering until a genuine increase is observed against it.
  it("does not credit an immediate post-restart reading as answering, even when it is non-zero", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    t.sampled([udp("gcs0", 50, 100)], ["gcs0"]);
    clock.advance(1_000);
    // The router restarted: its counters are small again, but still
    // non-zero. That alone says gcs0 answered *at some point* since the
    // restart, not that it is answering *now*.
    t.sampled([udp("gcs0", 2, 4)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);

    clock.advance(1_000);
    // The next sample shows a genuine increase from the post-restart
    // baseline — real, timestamped evidence, exactly like the ordinary case.
    t.sampled([udp("gcs0", 5, 10)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: true, lastHeardMs: 0 }]);
  });

  it("does not call a station answering the instant the router restarts silent", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    t.sampled([udp("gcs0", 50, 100)], ["gcs0"]);
    clock.advance(1_000);
    // Restarted, and nothing has answered yet since — 0 is 0, not a claim.
    t.sampled([udp("gcs0", 0, 0)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // Pins the rule directly, independent of any restart: a first sighting
  // never counts as answering, however large the total is, and it takes
  // nothing more than one further genuine increase to start counting.
  it("never credits a first sighting as answering, whatever the counter already reads", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    // A fresh tracker meeting a ground station the router has already been
    // routing to for a long time (R-MAV-06: the router survives a
    // yonder-core restart) — a large total that predates this tracker
    // entirely.
    t.sampled([udp("gcs0", 10_000, 10_000)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);

    clock.advance(1_000);
    t.sampled([udp("gcs0", 10_001, 10_001)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: true, lastHeardMs: 0 }]);
  });

  // Nothing has measured how a connected TCP client appears in the router's
  // output (Task 8b), so this reports nothing rather than a zero.
  it("leaves the TCP client count unmeasured rather than reporting zero", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([udp("gcs0", 0, 954)], ["gcs0"]);
    expect(t.state().tcpClients).toBeNull();
  });

  it("reports no traffic before the router's statistics have ever been sampled", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().traffic).toBeNull();
  });

  // The Throughput sparkline sits in the design under "Ground stations", not
  // under the autopilot half (docs/console/design/telemetry/README.md), so
  // it is the ground stations' own KB counters — the router's own unit,
  // beside the message counts already read for `groundStations` — turned
  // into a rate the way TrafficSampler turns interface byte counters into
  // one: a delta between two readings, divided by the clock time between
  // them. The very first reading is a total, not a rate, exactly as it is
  // there. KB values here are deliberately different from the message
  // counts, to prove this reads the router's own byte figure rather than
  // relabelling the message-count delta.
  it("turns the ground stations' own KB counters into a kB/s traffic rate once two readings exist", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 0, 0, 0), udp("gcs1", 0, 0, 0, 0)], ["gcs0", "gcs1"]);
    expect(t.state().traffic).toEqual({ rx: [], tx: [], peak: null, windowMs: 5_000 });

    clock.advance(1_000);
    // gcs0 answered 10 messages (1 KB) and both stations had 100 messages
    // (34 KB each) of telemetry mirrored to them in that second.
    t.sampled([udp("gcs0", 10, 100, 1, 34), udp("gcs1", 0, 100, 0, 34)], ["gcs0", "gcs1"]);
    expect(t.state().traffic).toEqual({ rx: [1], tx: [68], peak: 68, windowMs: 5_000 });
  });

  // Traffic history ages out on the same recency window the ground stations'
  // own `answering` flag uses — one clock, one meaning of "recent", rather
  // than a second window invented just for the sparkline.
  it("ages traffic history out of the window once it is older than windowMs", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 2_000 });
    t.sampled([udp("gcs0", 0, 0, 0, 0)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 5, 5, 2, 3)], ["gcs0"]);
    clock.advance(3_000);
    // No further traffic, but enough time has passed that the one point of
    // history recorded so far is now outside the window and must not still
    // be reported alongside this reading's own (zero) point.
    t.sampled([udp("gcs0", 5, 5, 2, 3)], ["gcs0"]);
    expect(t.state().traffic).toEqual({ rx: [0], tx: [0], peak: 0, windowMs: 2_000 });
  });

  /**
   * R-MAV-09 has no setter here, and that is the point.
   *
   * An operator's stop is a fact about *this device's routing*, and the only
   * object that can undo one is the renderer that performed it — with a
   * pinned or an adopted link there is no sweep to come back through, so a
   * flag held here could never be cleared again. It lived here with **no
   * production caller at all** until it was withdrawn; `MavlinkRenderer`
   * holds the flag and overlays `phase: "stopped"` itself, and this asserts
   * that nothing in this class can produce that value on its own.
   */
  it("never reports a phase only the renderer can know about (R-MAV-09)", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().phase).toBe("linked");
    expect("stopped" in t).toBe(false);
  });

  /**
   * The other half of the same division. The loopback listener goes on
   * handing heartbeats to this tracker the whole time telemetry is stopped —
   * the autopilot never hears about the stop and keeps heartbeating over the
   * UART — so everything measured here stays exactly as it was, and the
   * page's "stopped" comes from the layer above rather than from a
   * measurement being suppressed.
   */
  it("keeps the autopilot half alive whatever the operator did", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state()).toMatchObject({ vehicle: "ArduPlane", baud: 57600, lastHeardMs: 0 });
  });
});
