// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { PathCheck } from "yonder-core";
import { messageFor } from "./check.js";

/**
 * `GET /mav/check` is already decided — `pathCheck` in `yonder-core`
 * (`mav/check.ts`) is a pure function with its own tests, and it has already
 * chosen `true`/`false`/`null` and written the sentence. This file does not
 * re-derive any of that: it picks the mark from `ok` and prints `detail`
 * unchanged, which is the whole of the decision left to make here.
 */

function link(ok: boolean | null, detail: string): PathCheck["autopilot"] {
  return { ok, detail };
}

const healthy: PathCheck = {
  autopilot: link(true, "Heartbeat at 1.0 Hz, 57600 baud"),
  outbound: link(true, "3.1 kB/s leaving, one ground station configured"),
  inbound: link(true, "Answering, last heard 0.3 s ago"),
};

describe("messageFor — the mark, from ok", () => {
  it("is OK for a working link, and prints the detail unchanged", () => {
    const msg = messageFor(healthy);
    expect(msg.payload.autopilot).toBe("OK · Heartbeat at 1.0 Hz, 57600 baud");
    expect(msg.payload.outbound).toBe("OK · 3.1 kB/s leaving, one ground station configured");
    expect(msg.payload.inbound).toBe("OK · Answering, last heard 0.3 s ago");
  });

  it("is a cross for a link that was attempted and is not working", () => {
    const msg = messageFor({ ...healthy, autopilot: link(false, "No data on the wire, at any speed") });
    expect(msg.payload.autopilot).toBe("✕ · No data on the wire, at any speed");
  });

  /**
   * The distinction the whole file exists for: `ok: null` draws a dash and
   * never a cross, because nobody attempting a link is not the same fact as
   * a link that failed (R-DIA-04).
   */
  it("is a dash, never a cross, for a link nobody attempted", () => {
    const msg = messageFor({
      ...healthy,
      outbound: link(null, "Nothing to send"),
      inbound: link(null, "Not checked"),
    });
    expect(msg.payload.outbound).toBe("— · Nothing to send");
    expect(msg.payload.inbound).toBe("— · Not checked");
  });

  /**
   * R-MAV-09's own approved wording, named in the plan: stopped reads a tick
   * on the autopilot row beside a dash on the ground-station rows, never a
   * cross on either.
   */
  it("draws the approved stopped page: a tick beside two dashes", () => {
    const msg = messageFor({
      autopilot: link(true, "Heartbeat every second, 57600 baud"),
      outbound: link(null, "Stopped by you"),
      inbound: link(null, "Not checked"),
    });
    expect(msg.payload.autopilot).toBe("OK · Heartbeat every second, 57600 baud");
    expect(msg.payload.outbound).toBe("— · Stopped by you");
    expect(msg.payload.inbound).toBe("— · Not checked");
  });

  it("never rewrites the sentence — a wrong one is a bug in check.ts, not here", () => {
    const oddButValid = link(true, "Anything pathCheck decided to say, verbatim");
    expect(messageFor({ ...healthy, autopilot: oddButValid }).payload.autopilot)
      .toBe("OK · Anything pathCheck decided to say, verbatim");
  });
});
