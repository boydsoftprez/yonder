// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { pathCheck, type LinkState, type PathCheckInput } from "yonder-core";
import { groupThousands } from "yonder-core/presentation";
import { formatBaud, formatKbRate, formatSeconds, formatSpan } from "./format.js";

/**
 * Presentation arithmetic for the Telemetry page, tested the way
 * `node-red-contrib-yonder-remote`'s own `format.ts` is: small, pure, and
 * covered directly rather than only through the messages that use it.
 */
describe("formatBaud", () => {
  it("groups the thousands with a plain space, matching the built page", () => {
    // An ordinary space, not the thin space (U+2009) the earlier mockup HTML
    // used. `flows/flows.json` carried this exact reading, byte-checked, as
    // a mock for `tel-speed` while the page was being designed; the mock is
    // gone now that the page reads the device, but the convention it
    // settled stuck.
    expect(formatBaud(57600)).toBe("57 600");
    expect(formatBaud(115200)).toBe("115 200");
    expect(formatBaud(921600)).toBe("921 600");
  });

  it("does not group a number under a thousand", () => {
    expect(formatBaud(600)).toBe("600");
  });

  it("is null for anything that is not a finite number, never a crash", () => {
    // Same reasoning as yonder-core's own formatBytes/formatRate: this value
    // crosses a process boundary from a daemon that may be older than this
    // console, and an unknown field must read as unknown rather than throw.
    expect(formatBaud(null)).toBeNull();
    expect(formatBaud(undefined)).toBeNull();
    expect(formatBaud("57600")).toBeNull();
    expect(formatBaud(Number.NaN)).toBeNull();
  });

  it("is yonder-core's groupThousands under this package's own boundary guard", () => {
    // Not a coincidence that these agree: `formatBaud` calls `groupThousands`
    // directly. This is the regression the delegation exists to prevent — if
    // a future edit gave `formatBaud` its own copy of the arithmetic again,
    // the two would be free to drift apart the way they already did once.
    for (const baud of [0, 600, 57600, 115200, 230400, 921600]) {
      expect(formatBaud(baud)).toBe(groupThousands(baud));
    }
  });
});

/**
 * **This is the bug, written as a test.** The Autopilot panel's Speed
 * reading (`formatBaud`, above, read by `state.ts`'s `messageFor`) and the
 * path check's own "Autopilot to Yonder" sentence (`yonder-core`'s
 * `mav/check.ts`) draw the *same measurement* — one `LinkState.baud` — on
 * the same page. Before both called `yonder-core/presentation`'s
 * `groupThousands`, `check.ts` built its fragment with `String(state.baud)`
 * and this file grouped the thousands, so a board could read "57 600 baud"
 * in the Autopilot panel and "57600 baud" a few pixels away in the rail's
 * path check, for the same link.
 *
 * This constructs one `LinkState` and reads the baud rate both ways: through
 * this package's own `formatBaud`, and through `yonder-core`'s `pathCheck`,
 * which `mav/check.ts` cannot be imported around (the dependency between
 * the two packages runs the other way). If either file ever stops calling
 * the shared helper, the two spellings part company again and this fails.
 */
describe("formatBaud agrees with mav/check.ts's path-check sentence", () => {
  const LINKED: LinkState = {
    phase: "linked", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1,
    heartbeatHz: 1, lastHeardMs: 300, groundStations: [], triedBauds: [],
    traffic: null, tcpClients: null,
  };

  it("spells the same baud rate the same way in both surfaces", () => {
    const input: PathCheckInput = {
      state: LINKED, telemetryRunning: true, routerRunning: true, endpoints: [], autocast: true,
    };
    const { autopilot } = pathCheck(input);
    const grouped = formatBaud(LINKED.baud);
    expect(grouped).not.toBeNull();
    expect(autopilot.detail).toContain(`${grouped} baud`);
  });
});

describe("formatSeconds", () => {
  it("renders one decimal place, matching check.ts's own convention", () => {
    // The mock's own readings: "0.4 s ago" (tel-heard), "0.3 s ago" (tel-answered).
    expect(formatSeconds(400)).toBe("0.4 s");
    expect(formatSeconds(300)).toBe("0.3 s");
  });

  it("has no ceiling — this page never tiers into minutes, unlike the mesh tab", () => {
    // Deliberately not `formatLastHeard`'s minutes/hours/days ladder: this
    // is the same fractional-second convention `mav/check.ts`'s own
    // (private) `seconds()` helper uses, for the same measurement.
    expect(formatSeconds(3_661_000)).toBe("3661.0 s");
  });

  it("is null for anything that is not a finite number", () => {
    expect(formatSeconds(null)).toBeNull();
    expect(formatSeconds(undefined)).toBeNull();
    expect(formatSeconds(Number.NaN)).toBeNull();
  });
});

describe("formatKbRate", () => {
  it("renders one decimal place and the unit check.ts already chose", () => {
    // check.ts's own outboundLink: `${leaving.toFixed(1)} kB/s leaving`.
    // Deliberately not formatRate's bits-per-second, stepped-unit ladder:
    // this value is already in the router's own kB/s, and re-deriving a
    // different unit for the same number is the mistake formatRate's own
    // docstring warns about.
    expect(formatKbRate(3.1)).toBe("3.1 kB/s");
    expect(formatKbRate(0)).toBe("0.0 kB/s");
  });

  it("is null for anything that is not a finite number", () => {
    expect(formatKbRate(null)).toBeNull();
    expect(formatKbRate(undefined)).toBeNull();
    expect(formatKbRate(Number.NaN)).toBeNull();
  });
});

describe("formatSpan", () => {
  it.each([
    [2_000, "last 2 s"],
    [30_000, "last 30 s"],
    [120_000, "last 2 min"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatSpan(ms)).toBe(expected);
  });

  it.each([null, undefined, 0, -1, Number.NaN])("is null for %s", (bad) => {
    expect(formatSpan(bad)).toBeNull();
  });
});
