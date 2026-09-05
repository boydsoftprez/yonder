// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { outputReach, type ReachPaths } from "./outputs.js";

/** In flight, on cellular alone: no LAN, no mesh. */
const cell: ReachPaths = { lan: false, mesh: false, cellular: true };

describe("outputReach", () => {
  it("the ground station dials out, so cellular carries it", () => {
    expect(outputReach("rtp", cell)).toMatchObject({ direction: "outbound", reachable: true });
  });

  it("an outbound push also works over the mesh or a LAN alone, not only cellular", () => {
    // A wrong implementation could read paths.cellular alone and still pass
    // the test above and the no-path-at-all test below — neither one turns
    // on lan or mesh without cellular.
    expect(outputReach("rtp", { lan: true, mesh: false, cellular: false }).reachable).toBe(true);
    expect(outputReach("rtp", { lan: false, mesh: true, cellular: false }).reachable).toBe(true);
  });

  it("an outbound push reaches nothing when no path at all is up", () => {
    expect(outputReach("rtp", { lan: false, mesh: false, cellular: false }).reachable).toBe(false);
  });

  it("nothing can dial in to an RTSP listener over cellular, and the note says mesh", () => {
    const r = outputReach("rtsp", cell);
    expect(r.reachable).toBe(false);
    expect(r.note).toMatch(/cellular/);
    expect(r.note).toMatch(/mesh/);
  });

  it("the mesh, and a LAN, give a listener an address a peer can reach", () => {
    for (const paths of [{ lan: true, mesh: false, cellular: false },
                         { lan: false, mesh: true, cellular: false }]) {
      expect(outputReach("rtsp", paths).reachable).toBe(true);
    }
  });

  it("treats srt exactly like rtsp: a listener, unreachable on cellular alone", () => {
    // rtsp and srt are the two listener kinds (schema/config.ts); a fix that
    // only special-cased the string "rtsp" would leave srt wrongly outbound.
    const r = outputReach("srt", cell);
    expect(r.direction).toBe("listener");
    expect(r.reachable).toBe(false);
    expect(r.note).toMatch(/cellular/);
    expect(r.note).toMatch(/mesh/);
  });

  it("srt, too, is reachable on the mesh or a LAN", () => {
    for (const paths of [{ lan: true, mesh: false, cellular: false },
                         { lan: false, mesh: true, cellular: false }]) {
      expect(outputReach("srt", paths).reachable).toBe(true);
    }
  });

  it("names a listener's direction correctly, not just an outbound one", () => {
    // Nothing above checks rtsp/srt's direction: without this, an
    // implementation that always returned "outbound" would still be green.
    expect(outputReach("rtsp", cell).direction).toBe("listener");
    expect(outputReach("srt", cell).direction).toBe("listener");
  });

  // The console states and does not act (R-CMD-04): a sentence, never an action.
  it("returns exactly direction, reachable and note", () => {
    expect(Object.keys(outputReach("rtsp", cell)).sort()).toEqual(["direction", "note", "reachable"]);
  });

  it("returns exactly those three fields for rtp and srt too, not only rtsp", () => {
    expect(Object.keys(outputReach("rtp", cell)).sort()).toEqual(["direction", "note", "reachable"]);
    expect(Object.keys(outputReach("srt", cell)).sort()).toEqual(["direction", "note", "reachable"]);
  });

  it("the note changes to match reachable, rather than repeating one sentence regardless", () => {
    const unreachable = outputReach("rtsp", cell).note;
    const reachable = outputReach("rtsp", { lan: true, mesh: false, cellular: false }).note;
    expect(reachable).not.toBe(unreachable);
  });
});
