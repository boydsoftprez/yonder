// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { DetectOutcome } from "yonder-core";
import { chooseAction, outcomeMessage } from "./run.js";

/**
 * `yonder-mav-run` covers `POST /mav/start`, `/mav/stop` and `/mav/detect` —
 * three actions behind one node type, the way `yonder-diag`'s `config.probe`
 * chooses between `ping` and `reachable`. What differs here is `toggle`,
 * the default: R-MAV-09's own button is one control reading the current
 * state, never an ON beside an OFF, so the node instance most flows wire
 * reads the daemon's own `telemetryRunning` and acts on the opposite of it
 * rather than being told which way to go.
 */
describe("chooseAction — one control, reading the current state (R-MAV-09)", () => {
  it("starts when telemetry is not running", () => {
    expect(chooseAction("toggle", false)).toBe("start");
  });

  it("stops when telemetry is running", () => {
    expect(chooseAction("toggle", true)).toBe("stop");
  });

  it("honours an explicit action regardless of the current state", () => {
    expect(chooseAction("start", true)).toBe("start");
    expect(chooseAction("stop", false)).toBe("stop");
    expect(chooseAction("detect", true)).toBe("detect");
  });
});

describe("outcomeMessage — what the re-detect actually found", () => {
  it("names the vehicle, the port and the speed when one is found", () => {
    const outcome: DetectOutcome = { kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 };
    expect(outcomeMessage(outcome)).toBe("ArduPlane found on /dev/ttyAMA0 at 57 600 baud");
  });

  // Reuses mav/check.ts's own wording for the identical fact, rather than a
  // second, disagreeing sentence about the same sweep.
  it("reuses check.ts's own wording for silence", () => {
    const outcome: DetectOutcome = { kind: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600] };
    expect(outcomeMessage(outcome)).toBe("No data on the wire, at any speed");
  });

  it("blames the port when nothing was swept at all", () => {
    const outcome: DetectOutcome = { kind: "silent", device: "/dev/ttyACM0", triedBauds: [] };
    expect(outcomeMessage(outcome)).toBe("/dev/ttyACM0 could not be opened");
  });

  it("reuses check.ts's own wording for noise", () => {
    const outcome: DetectOutcome = { kind: "noise", device: "/dev/ttyAMA0", triedBauds: [57600], bytes: 18402 };
    expect(outcomeMessage(outcome)).toBe("Bytes on the wire, but no MAVLink frame at any speed");
  });
});
