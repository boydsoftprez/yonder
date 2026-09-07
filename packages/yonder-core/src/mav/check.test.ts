// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { LinkState } from "./link.js";
import { pathCheck, type PathCheckInput } from "./check.js";

/**
 * R-DIA-04, as the three-link chain the console draws (§8).
 *
 * **The whole file is about `null`.** `ok: null` means *nobody attempted
 * this*, and it draws a dash; `false` means *this was attempted and it is not
 * working*, and it draws a cross. A link nobody tried is not a link that
 * failed, and the difference is the reason an operator who deliberately
 * stopped telemetry does not open the page to a row of red.
 */

/** A link state with nothing measured — the shape a fresh tracker answers with. */
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
    lastHeardMs: 300,
    groundStations: [{ name: "gcs0", answering: true, lastHeardMs: 300 }],
    traffic: { rx: [0.4], tx: [3.1], peak: 3.1, windowMs: 5_000 },
    ...over,
  };
}

/** The ordinary healthy device: linked, running, one station configured. */
function healthy(over: Partial<PathCheckInput> = {}): PathCheckInput {
  return {
    state: linked(),
    telemetryRunning: true,
    routerRunning: true,
    endpoints: ["gcs0"],
    autocast: true,
    ...over,
  };
}

describe("pathCheck — Autopilot to Yonder", () => {
  it("is a tick with the rate and the speed when heartbeats are arriving", () => {
    const { autopilot } = pathCheck(healthy());
    expect(autopilot.ok).toBe(true);
    expect(autopilot.detail).toMatch(/1\.0 Hz/);
    expect(autopilot.detail).toMatch(/57 600 baud/);
  });

  /**
   * A sweep that has not reported is not a sweep that failed. This is the
   * state every device is in for the first seconds of its life, and the page
   * must not open on a cross.
   */
  it("is a dash, not a cross, while nothing has reported yet", () => {
    const { autopilot } = pathCheck(healthy({ state: fresh() }));
    expect(autopilot.ok).toBeNull();
    expect(autopilot.detail).toMatch(/looking/i);
  });

  it("is a cross when the sweep heard nothing on the wire (R-MAV-13)", () => {
    const state: LinkState = {
      ...fresh(), phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600],
    };
    const { autopilot } = pathCheck(healthy({ state }));
    expect(autopilot).toEqual({ ok: false, detail: "No data on the wire, at any speed" });
  });

  /**
   * R-MAV-13's two kinds of nothing are two different errands for the
   * operator, and an empty `triedBauds` is a third: nothing was swept because
   * the port would not open at all.
   */
  it("says the port would not open when nothing was swept", () => {
    const state: LinkState = { ...fresh(), phase: "silent", device: "/dev/ttyACM0", triedBauds: [] };
    const { autopilot } = pathCheck(healthy({ state }));
    expect(autopilot.ok).toBe(false);
    expect(autopilot.detail).toMatch(/\/dev\/ttyACM0/);
    expect(autopilot.detail).toMatch(/could not be opened/);
  });

  it("tells noise from silence, because they send the operator to different places", () => {
    const state: LinkState = {
      ...fresh(), phase: "noise", device: "/dev/ttyAMA0", triedBauds: [57600, 115200],
    };
    const { autopilot } = pathCheck(healthy({ state }));
    expect(autopilot.ok).toBe(false);
    expect(autopilot.detail).toMatch(/no MAVLink frame/i);
    expect(autopilot.detail).not.toMatch(/No data on the wire/);
  });

  /**
   * **Stopping telemetry stops the sending, not the listening.**
   *
   * A stop takes the ground-station endpoints out of the generated file and
   * restarts the router onto the remainder — the flight controller link and
   * the loopback copy stay — so heartbeats go on arriving and this row goes on
   * being a live measurement rather than a stale one. An operator stops
   * broadcasting; they do not ask to be blinded, and the approved page shows
   * *OK · Autopilot to Yonder* beside *— · Stopped by you*.
   *
   * This is the one row where `telemetryRunning` is false and the answer is
   * still `true`, which is exactly why the two running facts are separate
   * fields.
   */
  it("stays a tick while telemetry is stopped, because the loopback is still delivering", () => {
    const { autopilot } = pathCheck(healthy({
      state: linked({ phase: "stopped" }), telemetryRunning: false, routerRunning: true,
    }));
    expect(autopilot.ok).toBe(true);
    expect(autopilot.detail).toMatch(/1\.0 Hz/);
    expect(autopilot.detail).toMatch(/57 600 baud/);
  });

  // And the honest limit of that: if the router really is down — the stop's
  // own restart failed — nothing can arrive and the row says so rather than
  // reporting the last rate it happened to have seen.
  it("is a dash while stopped if the router did not come back", () => {
    const { autopilot } = pathCheck(healthy({
      state: linked({ phase: "stopped" }), telemetryRunning: false, routerRunning: false,
    }));
    expect(autopilot.ok).toBeNull();
    expect(autopilot.detail).toMatch(/not running/);
  });

  it("is a dash when a link was found but the router is not on the air", () => {
    const { autopilot } = pathCheck(healthy({ telemetryRunning: false, routerRunning: false, autocast: false }));
    expect(autopilot.ok).toBeNull();
    expect(autopilot.detail).toMatch(/not running/);
  });

  /**
   * Adoption, and the first second of every boot: the router is running and
   * the sweep found a link, but no heartbeat has come off the loopback feed
   * yet. Nothing has failed — the answer is simply not in yet.
   */
  it("is a dash, not a cross, in the moment before the first heartbeat", () => {
    const { autopilot } = pathCheck(healthy({ state: linked({ lastHeardMs: null, heartbeatHz: null }) }));
    expect(autopilot.ok).toBeNull();
    expect(autopilot.detail).toMatch(/first heartbeat/i);
  });

  /**
   * This is the failure the row exists for: heartbeats were arriving and have
   * stopped. The aircraft powered down, or the cable came out. That was
   * measured, so it is a cross.
   */
  it("is a cross once the heartbeat has been gone longer than a few beats", () => {
    const { autopilot } = pathCheck(healthy({ state: linked({ lastHeardMs: 9_000 }) }));
    expect(autopilot.ok).toBe(false);
    expect(autopilot.detail).toMatch(/9\.0 s/);
  });

  it("reports the last arrival rather than a rate when only one beat has been heard", () => {
    const { autopilot } = pathCheck(healthy({ state: linked({ heartbeatHz: null, lastHeardMs: 400 }) }));
    expect(autopilot.ok).toBe(true);
    expect(autopilot.detail).toMatch(/0\.4 s ago/);
  });

  /**
   * `Date.now()` has millisecond resolution and HEARTBEAT is 1 Hz, so two
   * arrivals inside one millisecond are a real possibility on a real board —
   * and `(n-1)/0` is `Infinity`, which would reach the page as the word.
   */
  it("does not print Infinity when two heartbeats share a millisecond", () => {
    const { autopilot } = pathCheck(healthy({ state: linked({ heartbeatHz: Infinity, lastHeardMs: 0 }) }));
    expect(autopilot.ok).toBe(true);
    expect(autopilot.detail).not.toMatch(/Infinity/);
  });
});

describe("pathCheck — Yonder to ground stations", () => {
  it("is a tick with the rate leaving and the number of stations", () => {
    const { outbound } = pathCheck(healthy());
    expect(outbound.ok).toBe(true);
    expect(outbound.detail).toMatch(/3\.1 kB\/s leaving/);
    expect(outbound.detail).toMatch(/one ground station/);
  });

  // §8, in as many words: when the autopilot is missing this reads "nothing
  // to send" and is grey, because there is nothing to send.
  it("is a dash saying there is nothing to send when there is no link", () => {
    const state: LinkState = { ...fresh(), phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600] };
    expect(pathCheck(healthy({ state })).outbound).toEqual({ ok: null, detail: "Nothing to send" });
  });

  it("is a dash saying the operator stopped it, never a failure (R-MAV-09)", () => {
    const { outbound } = pathCheck(healthy({
      state: linked({ phase: "stopped" }), telemetryRunning: false, routerRunning: true,
    }));
    expect(outbound.ok).toBeNull();
    expect(outbound.detail).toMatch(/stopped by you/i);
  });

  /**
   * R-MAV-16: a router that will not start is reported on the page. With
   * `autocast` on, a link found and the operator not having stopped anything,
   * a router that is not running is the one genuinely measured failure this
   * leg has — so it is the one case that draws a cross.
   */
  it("is a cross when the router should be running and is not (R-MAV-16)", () => {
    const { outbound } = pathCheck(healthy({ telemetryRunning: false, routerRunning: false }));
    expect(outbound.ok).toBe(false);
    expect(outbound.detail).toMatch(/not running/);
  });

  // R-MAV-08's opposite: `autocast: false` means telemetry deliberately does
  // not start on its own, so a router that is not running is the setting
  // working, not a fault.
  it("is a dash when telemetry is configured not to start on its own", () => {
    const { outbound } = pathCheck(healthy({ telemetryRunning: false, routerRunning: false, autocast: false }));
    expect(outbound.ok).toBeNull();
    expect(outbound.detail).toMatch(/does not start on its own/);
  });

  it("is a dash when no ground station has been configured to send to", () => {
    const { outbound } = pathCheck(healthy({ endpoints: [] }));
    expect(outbound.ok).toBeNull();
    expect(outbound.detail).toMatch(/no ground stations are configured/i);
  });

  it("is a dash until the router's own counters have been read once", () => {
    const { outbound } = pathCheck(healthy({ state: linked({ traffic: null }) }));
    expect(outbound.ok).toBeNull();
    expect(outbound.detail).toMatch(/counters/);
  });

  /**
   * The router's KB figure is a coarse integer, so a slow link goes whole
   * samples without it moving (`link.ts` says so at length). That is not a
   * path that has failed — the router is running and configured, and every
   * frame is being sent to every endpoint — so it stays a tick and says
   * plainly that no traffic has been measured yet.
   */
  it("stays a tick, saying so, when the counters have not moved yet", () => {
    const traffic = { rx: [0, 0], tx: [0, 0], peak: 0, windowMs: 5_000 };
    const { outbound } = pathCheck(healthy({ state: linked({ traffic }) }));
    expect(outbound.ok).toBe(true);
    expect(outbound.detail).toMatch(/no measurable traffic yet/i);
  });

  it("counts more than one station in words a page can print unchanged", () => {
    const { outbound } = pathCheck(healthy({ endpoints: ["gcs0", "gcs1", "gcs2"] }));
    expect(outbound.detail).toMatch(/3 ground stations configured/);
  });
});

describe("pathCheck — Ground station to Yonder", () => {
  it("is a tick naming how long ago something answered", () => {
    const { inbound } = pathCheck(healthy());
    expect(inbound.ok).toBe(true);
    expect(inbound.detail).toMatch(/answering/i);
    expect(inbound.detail).toMatch(/0\.3 s ago/);
  });

  /**
   * §8's own words: "not checked" — grey for never-attempted, not red for
   * failed. A ground station that has never sent anything is not a fault of
   * this device's, and a UDP endpoint is under no obligation to answer at
   * all.
   */
  it("is a dash reading 'not checked' whenever there is nothing to check", () => {
    const state: LinkState = { ...fresh(), phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600] };
    expect(pathCheck(healthy({ state })).inbound).toEqual({ ok: null, detail: "Not checked" });
    expect(pathCheck(healthy({ endpoints: [] })).inbound).toEqual({ ok: null, detail: "Not checked" });
    expect(pathCheck(healthy({ telemetryRunning: false, routerRunning: false, autocast: false })).inbound)
      .toEqual({ ok: null, detail: "Not checked" });
  });

  // A stop takes the ground-station endpoints out of the generated file, so
  // there is no longer a path for one of them to answer over.
  it("is a dash while telemetry is stopped", () => {
    const { inbound } = pathCheck(healthy({
      state: linked({ phase: "stopped" }), telemetryRunning: false, routerRunning: true,
    }));
    expect(inbound).toEqual({ ok: null, detail: "Not checked" });
  });

  it("is a dash, not a cross, when nothing has ever answered", () => {
    const groundStations = [{ name: "gcs0", answering: false, lastHeardMs: null }];
    const { inbound } = pathCheck(healthy({ state: linked({ groundStations }) }));
    expect(inbound.ok).toBeNull();
    expect(inbound.detail).toMatch(/nothing has answered yet/i);
  });

  /**
   * A station that answered and has gone quiet is a measurement, not an
   * absence — something worked and has stopped working, which is exactly what
   * a cross is for.
   */
  it("is a cross once a station that was answering has gone quiet", () => {
    const groundStations = [{ name: "gcs0", answering: false, lastHeardMs: 12_000 }];
    const { inbound } = pathCheck(healthy({ state: linked({ groundStations }) }));
    expect(inbound.ok).toBe(false);
    expect(inbound.detail).toMatch(/12\.0 s/);
  });

  it("reports the station that answered most recently, out of several", () => {
    const groundStations = [
      { name: "gcs0", answering: false, lastHeardMs: 4_000 },
      { name: "gcs1", answering: true, lastHeardMs: 200 },
      { name: "gcs2", answering: false, lastHeardMs: null },
    ];
    const { inbound } = pathCheck(healthy({ state: linked({ groundStations }) }));
    expect(inbound.ok).toBe(true);
    expect(inbound.detail).toMatch(/0\.2 s ago/);
  });
});

describe("pathCheck — the chain as a whole", () => {
  /**
   * The approved page, in one assertion: an operator who stopped telemetry
   * sees the aircraft still there, the sending switched off by them, and
   * nothing red anywhere. **A tick and two dashes**, not three dashes and not
   * a cross — the autopilot half is a live measurement the whole time.
   */
  it("shows the aircraft still there on a device whose telemetry was stopped on purpose", () => {
    const check = pathCheck(healthy({
      state: linked({ phase: "stopped" }), telemetryRunning: false, routerRunning: true,
    }));
    expect([check.autopilot.ok, check.outbound.ok, check.inbound.ok]).toEqual([true, null, null]);
    expect(check.outbound.detail).toMatch(/stopped by you/i);
  });

  it("draws no cross anywhere on a device that has only just started", () => {
    const check = pathCheck({
      state: fresh(), telemetryRunning: false, routerRunning: false, endpoints: [], autocast: true,
    });
    expect([check.autopilot.ok, check.outbound.ok, check.inbound.ok]).toEqual([null, null, null]);
  });

  it("gives every link a sentence, never an empty cell", () => {
    for (const input of [
      healthy(),
      healthy({ state: fresh() }),
      healthy({ telemetryRunning: false, routerRunning: false }),
      healthy({ state: linked({ phase: "stopped" }), telemetryRunning: false }),
      healthy({ state: { ...fresh(), phase: "noise", device: "/dev/ttyAMA0", triedBauds: [57600] } }),
    ]) {
      const check = pathCheck(input);
      for (const link of [check.autopilot, check.outbound, check.inbound]) {
        expect(link.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
