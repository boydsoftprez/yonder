// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { LinkState } from "yonder-core";
import {
  feedFor, flowFor, linkFor, messageFor, receivingFor, runStateFor, stateMessage,
} from "./state.js";

/** Fixed, so a relative-time assertion never races the wall clock. */
const NOW = 1_700_000_000_000;

/** A link state with nothing measured yet — the shape a fresh tracker answers with. */
function fresh(): LinkState {
  return {
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
  };
}

/** A link that was found, heartbeating, with one ground station answering. */
function linked(over: Partial<LinkState> = {}): LinkState {
  return {
    ...fresh(),
    phase: "linked",
    device: "/dev/ttyAMA0",
    baud: 57600,
    vehicle: "ArduPlane",
    system: 1,
    heartbeatHz: 1,
    lastHeardMs: 400,
    groundStations: [{ name: "gcs0", answering: true, lastHeardMs: 300 }],
    traffic: { rx: [0.4], tx: [3.1], peak: 3.1, windowMs: 5_000 },
    ...over,
  };
}

describe("messageFor — the Autopilot readout", () => {
  it("carries the port, speed, vehicle and heartbeat once linked", () => {
    const msg = messageFor(linked(), NOW);
    expect(msg.payload.port).toBe("/dev/ttyAMA0");
    expect(msg.payload.speed).toBe("57 600 baud");
    expect(msg.payload.vehicle).toBe("ArduPlane · system 1");
    expect(msg.payload.vehicleShort).toBe("ArduPlane · sys 1");
    expect(msg.payload.heartbeat).toBe("1.0 Hz");
    expect(msg.payload.heard).toBe("0.4 s ago");
  });

  it("has no readings while still searching, never a fabricated one", () => {
    const msg = messageFor(fresh(), NOW);
    expect(msg.payload.port).toBeNull();
    expect(msg.payload.speed).toBeNull();
    expect(msg.payload.vehicle).toBeNull();
    expect(msg.payload.vehicleShort).toBeNull();
    expect(msg.payload.heartbeat).toBeNull();
    expect(msg.payload.heard).toBeNull();
  });

  it("keeps reporting port, speed, vehicle and heartbeat while stopped (R-MAV-09)", () => {
    // "The interface goes on reporting heartbeat, port, speed and vehicle
    // throughout" — R-MAV-09's own words. A stop is not the autopilot going
    // away; it is the sending going away.
    const msg = messageFor(linked({ phase: "stopped" }), NOW);
    expect(msg.payload.port).toBe("/dev/ttyAMA0");
    expect(msg.payload.heartbeat).toBe("1.0 Hz");
  });
});

describe("messageFor — the diagnosis band, covering R-MAV-13's kinds of nothing", () => {
  it("is absent once linked — there is nothing to diagnose", () => {
    expect(messageFor(linked()).payload.diagnosis).toBeNull();
  });

  it("is absent while still searching — a sweep that has not reported is not a fault", () => {
    expect(messageFor(fresh()).payload.diagnosis).toBeNull();
  });

  it("names the pins when the sweep heard nothing on the wire (R-MAV-13)", () => {
    const state: LinkState = {
      ...fresh(), phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600],
    };
    const diagnosis = messageFor(state).payload.diagnosis;
    expect(diagnosis).not.toBeNull();
    const prose = (diagnosis ?? []).join(" ");
    expect(prose).toMatch(/pin 8/);
    expect(prose).toMatch(/pin 10/);
    expect(prose).toMatch(/pin 6/);
    // The actual swept rates, not a hardcoded list independent of them.
    expect(prose).toContain("57 600");
    expect(prose).toContain("921 600");
  });

  it("blames the port, not the wiring, when nothing was swept at all", () => {
    // R-MAV-13's third kind of nothing: the port itself would not open, so
    // there is no wiring story to tell — check.ts draws the same line.
    const state: LinkState = { ...fresh(), phase: "silent", device: "/dev/ttyACM0", triedBauds: [] };
    const diagnosis = messageFor(state).payload.diagnosis;
    const prose = (diagnosis ?? []).join(" ");
    expect(prose).toMatch(/\/dev\/ttyACM0/);
    expect(prose).toMatch(/could not be opened/);
    expect(prose).not.toMatch(/pin 8/);
  });

  it("names the autopilot's own parameters when it's noise, not silence (R-MAV-13)", () => {
    const state: LinkState = {
      ...fresh(), phase: "noise", device: "/dev/ttyAMA0", triedBauds: [57600, 115200],
    };
    const diagnosis = messageFor(state).payload.diagnosis;
    const prose = (diagnosis ?? []).join(" ");
    expect(prose).toMatch(/SERIAL.*_PROTOCOL/);
    expect(prose).toMatch(/SERIAL.*_BAUD/);
    // Sends the operator to a different place than silence does — the two
    // must never share a sentence about pins.
    expect(prose).not.toMatch(/pin 8/);
  });
});

describe("messageFor — the ground-station rows, one per configured endpoint", () => {
  it("names each row by position — the node carries no label of its own", () => {
    const state = linked({
      groundStations: [
        { name: "gcs0", answering: true, lastHeardMs: 300 },
        { name: "gcs1", answering: false, lastHeardMs: 6_000 },
      ],
    });
    const rows = messageFor(state).payload.groundStations;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ state: "confirmed", message: "GCS 0 · answering" });
    expect(rows[1]).toEqual({ state: "pending", message: "GCS 1 · silent" });
    expect(rows[2]).toEqual({ state: "idle", message: "GCS 2 · not set" });
  });

  it("reads 'no reply' for a configured row that has never answered", () => {
    const state = linked({ groundStations: [{ name: "gcs0", answering: false, lastHeardMs: null }] });
    expect(messageFor(state).payload.groundStations[0]).toEqual({ state: "idle", message: "GCS 0 · no reply" });
  });

  it("is three dashes when nothing has been sampled yet, never a cross", () => {
    // link.ts: groundStations is populated by the router's own statistics and
    // is empty for the first couple of seconds of every daemon's life, even
    // with endpoints configured. That is not the same fact as "unconfigured",
    // but neither is a fault, and both draw the same "not set" dash here.
    const rows = messageFor(fresh()).payload.groundStations;
    expect(rows).toEqual([
      { state: "idle", message: "GCS 0 · not set" },
      { state: "idle", message: "GCS 1 · not set" },
      { state: "idle", message: "GCS 2 · not set" },
    ]);
  });
});

describe("messageFor — last answered, naming the row (replaces the old unattributed reading)", () => {
  it("names the most recently answering row", () => {
    const state = linked({
      groundStations: [
        { name: "gcs0", answering: true, lastHeardMs: 300 },
        { name: "gcs1", answering: true, lastHeardMs: 9_000 },
      ],
    });
    expect(messageFor(state).payload.answered).toBe("GCS 0 · 0.3 s ago");
  });

  it("still names a row that has since gone quiet — this reads the past, not the present", () => {
    const state = linked({ groundStations: [{ name: "gcs0", answering: false, lastHeardMs: 40_000 }] });
    expect(messageFor(state).payload.answered).toBe("GCS 0 · 40.0 s ago");
  });

  it("says nothing has answered yet, matching mav/check.ts's own wording", () => {
    expect(messageFor(fresh()).payload.answered).toBe("Nothing has answered yet");
  });
});

describe("messageFor — the TCP client count", () => {
  it("is words, not a bare number", () => {
    expect(messageFor(linked({ tcpClients: 1 })).payload.tcpClients).toBe("1 client");
    expect(messageFor(linked({ tcpClients: 2 })).payload.tcpClients).toBe("2 clients");
  });

  it("says 'no clients' rather than a bare zero or null — nothing measures this yet", () => {
    expect(messageFor(linked({ tcpClients: null })).payload.tcpClients).toBe("no clients");
  });
});

describe("messageFor — the throughput sparkline", () => {
  it("is unknown before the router has answered even once — never a ceiling of zero", () => {
    const spark = messageFor(fresh()).payload.spark;
    expect(spark).toEqual({ series: { rx: [], tx: [] }, peak: null, span: null, known: false });
  });

  it("carries the two series and the pre-formatted peak once sampled", () => {
    const state = linked({ traffic: { rx: [0.4, 0.5], tx: [3.1, 3.3], peak: 3.3, windowMs: 5_000 } });
    const spark = messageFor(state).payload.spark;
    expect(spark.known).toBe(true);
    expect(spark.series).toEqual({ rx: [0.4, 0.5], tx: [3.1, 3.3] });
    expect(spark.peak).toBe("3.3 kB/s");
    expect(spark.span).toBe("last 5 s");
  });

  /**
   * The span comes from `LinkTracker`'s own retention window
   * (`traffic.windowMs`), not from the sample count times an assumed
   * sampling interval. Two samples at a 5 s window is "last 5 s"; the same
   * two samples read as `rx.length * STATS_INTERVAL_MS` (2 * 2000 ms) would
   * be "last 4 s" instead — the two formulas disagree here on purpose, so a
   * regression back to the derived figure fails this exact assertion.
   */
  it("reads the span from windowMs, not from the sample count", () => {
    const state = linked({ traffic: { rx: [0.4, 0.5], tx: [3.1, 3.3], peak: 3.3, windowMs: 5_000 } });
    expect(messageFor(state).payload.spark.span).toBe("last 5 s");
    expect(messageFor(state).payload.spark.span).not.toBe("last 4 s");
  });
});

describe("linkFor — the Autopilot panel's headline annunciator", () => {
  it("waits for a heartbeat before confirming an adopted router's link", () => {
    expect(linkFor(linked({ lastHeardMs: null, heartbeatHz: null }), true).state).toBe("pending");
  });

  it.each(["linked", "stopped"] as const)("reports a silent %s link and recovers on the first returning heartbeat", (phase) => {
    expect(linkFor(linked({ phase, lastHeardMs: 2_999 }), true).state).toBe("confirmed");
    expect(linkFor(linked({ phase, lastHeardMs: 3_000 }), true)).toEqual({ state: "pending", message: "No heartbeat" });
    expect(linkFor(linked({ phase, lastHeardMs: 0, heartbeatHz: null }), true).state).toBe("confirmed");
  });
  it("is confirmed 'Connected' once linked", () => {
    expect(linkFor(linked(), true)).toEqual({ state: "confirmed", message: "Connected" });
  });

  it("stays confirmed 'Connected' while stopped — stopped is not broken (R-MAV-09)", () => {
    expect(linkFor(linked({ phase: "stopped" }), true)).toEqual({ state: "confirmed", message: "Connected" });
  });

  it("is pending while still searching", () => {
    expect(linkFor(fresh(), true)).toEqual({ state: "pending", message: "Searching" });
  });

  /**
   * Not its own failure state — the captured mockup for exactly this phase
   * (`docs/console/design/telemetry/telemetry-nothing-on-the-wire.html`)
   * shows this annunciator as `tone-waiting` / "Searching", and the design
   * spec's own list of the page's six mutually exclusive states has no
   * separate "silent" entry. A sweep that heard nothing on the wire is
   * still the sweep looking; the diagnosis panel underneath is what tells
   * an operator this is the wiring case (R-MAV-13), not this annunciator.
   */
  it("shares searching's waiting tone for silence — it has not failed, it is still looking", () => {
    const state: LinkState = { ...fresh(), phase: "silent" };
    expect(linkFor(state, true)).toEqual({ state: "pending", message: "Searching" });
  });

  it("is a bad tone naming noise, distinct from searching and silence", () => {
    const state: LinkState = { ...fresh(), phase: "noise" };
    expect(linkFor(state, true)).toEqual({ state: "rejected", message: "Not MAVLink" });
  });

  /**
   * The trap named in the plan: a link the tracker still remembers is not
   * evidence heartbeats can currently arrive if the router itself is not
   * running to carry the loopback copy. `mav/check.ts`'s own `autopilotLink`
   * makes exactly this distinction for the same reason.
   */
  it("is not checked, not connected, when the router is not running to carry it", () => {
    expect(linkFor(linked(), false)).toEqual({ state: "idle", message: "Not checked" });
  });
});

describe("receivingFor — the Ground stations panel's headline annunciator", () => {
  it("is confirmed the moment any row is answering", () => {
    const state = linked({
      groundStations: [
        { name: "gcs0", answering: false, lastHeardMs: 9_000 },
        { name: "gcs1", answering: true, lastHeardMs: 200 },
      ],
    });
    expect(receivingFor(state, true)).toEqual({ state: "confirmed", message: "Answering" });
  });

  it("reads 'Not sending' while stopped — an operator stopped broadcasting, not listening", () => {
    // Realistic once stopped: no fresh counter movement means no row is
    // currently `answering`, however it looked a moment before the stop.
    const state = linked({ phase: "stopped", groundStations: [{ name: "gcs0", answering: false, lastHeardMs: 40_000 }] });
    expect(receivingFor(state, false)).toEqual({ state: "idle", message: "Not sending" });
  });

  it("reads 'Nothing to send' with no autopilot found", () => {
    expect(receivingFor(fresh(), false)).toEqual({ state: "idle", message: "Nothing to send" });
  });

  /** The same trap as linkFor, on the other side of the page. */
  it("reads 'Nothing to send' when linked but telemetry has not actually started yet", () => {
    const state = linked({ groundStations: [{ name: "gcs0", answering: false, lastHeardMs: null }] });
    expect(receivingFor(state, false)).toEqual({ state: "idle", message: "Nothing to send" });
  });

  it("reads 'Nothing has answered yet' once sending, before anyone has replied", () => {
    const state = linked({ groundStations: [{ name: "gcs0", answering: false, lastHeardMs: null }] });
    expect(receivingFor(state, true)).toEqual({ state: "idle", message: "Nothing has answered yet" });
  });
});

describe("runStateFor — the rail's State annunciator", () => {
  it("is confirmed 'Running' while telemetry is actually flowing", () => {
    expect(runStateFor(linked(), true)).toEqual({ state: "confirmed", message: "Running" });
  });

  it("is idle 'Stopped by you' — never a fault — when the operator stopped it", () => {
    expect(runStateFor(linked({ phase: "stopped" }), false)).toEqual({ state: "idle", message: "Stopped by you" });
  });

  it("is pending 'Waiting' before there is a link to send over", () => {
    expect(runStateFor(fresh(), false)).toEqual({ state: "pending", message: "Waiting" });
  });

  it("is pending 'Waiting', not 'Running', in the linked-but-not-yet-sending trap", () => {
    expect(runStateFor(linked(), false)).toEqual({ state: "pending", message: "Waiting" });
  });
});

describe("feedFor — the Status page's compact Feed annunciator", () => {
  it("mirrors telemetryRunning in two words", () => {
    expect(feedFor(true)).toEqual({ state: "confirmed", message: "Flowing" });
    expect(feedFor(false)).toEqual({ state: "idle", message: "Not flowing" });
  });
});

describe("flowFor — the Status page's three-cell flow strip", () => {
  it("names every place and both legs when everything is healthy", () => {
    const flow = flowFor(linked(), true, true, NOW);
    expect(flow.from).toEqual({ label: "ArduPlane", detail: "/dev/ttyAMA0 · 57 600 baud", absent: false });
    expect(flow.through).toEqual({ label: "Yonder", detail: "mavlink-router", absent: false });
    expect(flow.to.absent).toBe(false);
    expect(flow.legs[0]).toEqual({ rate: "1.0 Hz", caption: "heartbeat", absent: false });
    expect(flow.legs[1].absent).toBe(false);
    expect(flow.legs[1].caption).toBe("answering");
  });

  it("names what is missing rather than blanking or reddening, with no autopilot", () => {
    const flow = flowFor(fresh(), false, false, NOW);
    expect(flow.from.label).toBe("No autopilot");
    expect(flow.from.absent).toBe(true);
    expect(flow.legs[0]).toEqual({ rate: null, caption: "no heartbeat", absent: true });
    expect(flow.legs[1]).toEqual({ rate: null, caption: "nothing to send", absent: true });
  });

  it("keeps the destination present while stopped — it is still configured", () => {
    const state = linked({ phase: "stopped", groundStations: [{ name: "gcs0", answering: false, lastHeardMs: 252_000 }] });
    const flow = flowFor(state, false, true, NOW);
    expect(flow.to.absent).toBe(false);
    expect(flow.legs[1]).toEqual({ rate: null, caption: "nothing to send", absent: true });
  });

  it("has no configured destination at all when there are no ground stations", () => {
    const flow = flowFor(linked({ groundStations: [] }), true, true, NOW);
    expect(flow.to.absent).toBe(true);
  });

  /**
   * The outbound leg reads the window's peak, not the newest sample —
   * deliberately, and the same read `mav/check.ts`'s own `outboundLink`
   * takes of this identical `traffic.tx` field. The router's KB figure is a
   * coarse integer, so a healthy slow link genuinely reads zero for whole
   * samples between movements; a leg driven by the newest point alone would
   * blink between "3.1 kB/s" and "nothing to send" while telemetry is
   * actually working. `tx` here is built so peak and latest disagree, so a
   * regression to the newest sample fails this exact assertion.
   */
  /**
   * **The gap `FlowLeg`'s own comment used to deny.**
   *
   * It claimed `rate` is null exactly when `absent` is true. It is not:
   * `telemetryRunning` is true from the first reply to a start, while
   * `traffic` stays null until the router's own counters have been read
   * twice — there is no rate until two samples exist to divide. So for the
   * whole of every telemetry start the outbound leg is
   * `{ rate: null, caption: "answering", absent: false }`: a dash on a solid
   * arrow, which is right, because the link is there and the number is not.
   * Nothing covered it, in either of the two shapes it arrives in.
   *
   * Pinned so that "fixing" the strip to match the old comment — going
   * absent, or printing a rate nobody measured — fails here.
   */
  it.each([
    ["before the counters have been read at all", null],
    ["with a window that has no outbound sample in it yet", { rx: [], tx: [], peak: 0, windowMs: 5_000 }],
  ])("draws a dash on a solid arrow while telemetry is running but the rate is not known — %s", (_what, traffic) => {
    const flow = flowFor(linked({ traffic }), true, true, NOW);
    expect(flow.legs[1]).toEqual({ rate: null, caption: "answering", absent: false });
  });

  it("reads the peak of the window for the outbound rate, not the newest sample", () => {
    const state = linked({ traffic: { rx: [0.4, 0.4], tx: [3.1, 0.0], peak: 3.1, windowMs: 5_000 } });
    const flow = flowFor(state, true, true, NOW);
    expect(flow.legs[1].rate).toBe("3.1 kB/s");
    expect(flow.legs[1].rate).not.toBe("0.0 kB/s");
  });
});

describe("stateMessage — what the node actually sends, one MavlinkStateBody in", () => {
  it("shows the returning heartbeat as present before a second arrival establishes its rate", () => {
    const msg = stateMessage({ link: linked({ lastHeardMs: 0, heartbeatHz: null }), telemetryRunning: true, routerRunning: true }, NOW);
    expect(msg.payload.link.state).toBe("confirmed");
    expect(msg.payload.heartbeat).toBeNull();
    expect(msg.payload.flow.legs[0]).toEqual({ rate: null, caption: "heartbeat", absent: false });
  });

  it("removes the stale heartbeat reading and arrow while keeping routing state separate", () => {
    const msg = stateMessage({ link: linked({ lastHeardMs: 30_000 }), telemetryRunning: true, routerRunning: true }, NOW);
    expect(msg.payload.link.state).toBe("pending");
    expect(msg.payload.heartbeat).toBeNull();
    expect(msg.payload.heard).toBe("30.0 s ago");
    expect(msg.payload.flow.legs[0]).toEqual({ rate: null, caption: "no heartbeat", absent: true });
    expect(msg.payload.running.message).toBe("Running");
    expect(msg.payload.port).toBe("/dev/ttyAMA0");
  });
  it("combines the state-only fields with the two booleans into one payload", () => {
    const msg = stateMessage({ link: linked(), telemetryRunning: true, routerRunning: true }, NOW);
    expect(msg.payload.link).toEqual({ state: "confirmed", message: "Connected" });
    expect(msg.payload.receiving).toEqual({ state: "confirmed", message: "Answering" });
    expect(msg.payload.running).toEqual({ state: "confirmed", message: "Running" });
    expect(msg.payload.feed).toEqual({ state: "confirmed", message: "Flowing" });
    expect(msg.payload.port).toBe("/dev/ttyAMA0");
    expect(msg.payload.flow.from.label).toBe("ArduPlane");
  });

  /**
   * The whole reason `telemetryRunning` and `routerRunning` are two fields:
   * a stop keeps the autopilot half alive and takes only the ground-station
   * half to neutral. Asserted here, together, because this is the object
   * the page actually receives.
   */
  it("stopped: the autopilot half stays lit while the ground-station half goes neutral", () => {
    const msg = stateMessage(
      {
        link: linked({ phase: "stopped", groundStations: [{ name: "gcs0", answering: false, lastHeardMs: 252_000 }] }),
        telemetryRunning: false,
        routerRunning: true,
      },
      NOW,
    );
    expect(msg.payload.link.state).toBe("confirmed");
    expect(msg.payload.heartbeat).toBe("1.0 Hz");
    expect(msg.payload.receiving).toEqual({ state: "idle", message: "Not sending" });
    expect(msg.payload.running).toEqual({ state: "idle", message: "Stopped by you" });
  });
});
