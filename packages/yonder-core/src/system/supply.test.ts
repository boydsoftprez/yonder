// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseThrottled, readSupply } from "./supply.js";
import type { CommandRunner } from "../net/runner.js";

describe("parseThrottled", () => {
  it("reads a clean board as clean", () => {
    const s = parseThrottled("0x0");
    expect(s.clean).toBe(true);
    expect(s.now).toEqual({ undervoltage: false, throttled: false, capped: false });
    expect(s.sinceBoot).toEqual({ undervoltage: false, throttled: false, capped: false });
  });

  it("distinguishes now from has-happened-since-boot (R-SYS-09)", () => {
    // The whole point of the requirement. An undervoltage event restarts the
    // board, and a restart in flight presents as an aircraft that went quiet
    // with nothing to explain it — so 'it happened' has to survive the moment
    // it stopped happening. Bits 0-2 are now; bits 16-18 are since boot.
    // 0x50000 is bits 16 and 18 — under-voltage has occurred, and throttling
    // has occurred. Bit 17, the frequency cap, is *not* set, and K-41 names
    // the same two bits. Pinned in both directions so the three flags stay
    // distinguishable: a shift that slid capped and throttled into each other
    // would satisfy either assertion alone.
    const s = parseThrottled("0x50000");
    expect(s.now).toEqual({ undervoltage: false, throttled: false, capped: false });
    expect(s.sinceBoot).toEqual({ undervoltage: true, capped: false, throttled: true });
    expect(s.clean).toBe(false);
  });

  it("reads a board browning out right now", () => {
    // The same two bits as the latched pair above, in the low half: bit 0
    // under-voltage and bit 2 throttled, with bit 1's frequency cap clear.
    const s = parseThrottled("0x50005");
    expect(s.now).toEqual({ undervoltage: true, capped: false, throttled: true });
    expect(s.sinceBoot).toEqual({ undervoltage: true, capped: false, throttled: true });
    expect(s.clean).toBe(false);
  });

  it("reads the frequency cap on its own bit", () => {
    // Nothing else in this file sets bit 1 or bit 17, so without this the
    // capped flag could be wired to any bit at all and stay green.
    expect(parseThrottled("0x2").now).toEqual(
      { undervoltage: false, capped: true, throttled: false },
    );
    expect(parseThrottled("0x20000").sinceBoot).toEqual(
      { undervoltage: false, capped: true, throttled: false },
    );
  });

  it("treats output it cannot read as not clean", () => {
    // The failure mode that matters is recording a number as clean when it
    // was not. Unreadable is dirty.
    for (const bad of ["", "throttled=", "not a number", "0xZZ"]) {
      expect(parseThrottled(bad).clean).toBe(false);
    }
  });

  it("accepts the vcgencmd form as well as a bare word", () => {
    expect(parseThrottled("throttled=0x0").clean).toBe(true);
  });
});

describe("readSupply", () => {
  it("returns null on a board with no vcgencmd, rather than claiming clean", () => {
    // R-SYS-09 is 'where the board exposes it'. A board that does not is
    // unknown, and unknown is not the same as good.
    const none: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    return expect(readSupply({ runner: none })).resolves.toBeNull();
  });

  it("reads the register through the injected runner", async () => {
    const ok: CommandRunner = async () => ({ code: 0, stdout: "throttled=0x0\n", stderr: "" });
    await expect(readSupply({ runner: ok })).resolves.toMatchObject({ clean: true });
  });
});
