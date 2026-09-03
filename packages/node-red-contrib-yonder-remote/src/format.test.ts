// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatBytes, formatLastHeard, formatRate, formatSpan } from "./format.js";

/**
 * The kind of arithmetic that stays quietly wrong for years: nobody notices a
 * traffic counter is off by a unit until somebody compares it against a bill.
 */
describe("formatBytes", () => {
  it("is a whole number of bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps to KB at 1024 bytes, with no decimal", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    // The mock's own traffic line: "405 KB out".
    expect(formatBytes(405 * 1024)).toBe("405 KB");
  });

  it("steps to MB at 1024 KB, with one decimal", () => {
    // The mock's own traffic line: "1.5 MB in".
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("steps to GB at 1024 MB, with one decimal", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

/**
 * Bits per second, at 1000 steps - not 1024. Bytes are 1024 because a byte
 * count is a memory quantity; a bit rate is a network quantity, and every
 * network standard from Ethernet to the ZeroTier link itself has always
 * quoted its speed in decimal - a "1 Gbps" NIC moves 1,000,000,000 bits per
 * second, not 2^30. Reusing formatBytes's divisor here would be the classic
 * mistake, and it would be quiet: every reading would print a plausible
 * number that was fractionally wrong until somebody compared it to a bill or
 * a link's rated speed.
 */
describe("formatRate", () => {
  it("is a whole number of bits per second below 1000", () => {
    expect(formatRate(0)).toBe("0 bps");
    expect(formatRate(999)).toBe("999 bps");
  });

  it("steps to kbps at 1000 bits per second, with no decimal", () => {
    expect(formatRate(1000)).toBe("1 kbps");
    // The mock's own reading: "340 kbps".
    expect(formatRate(340_000)).toBe("340 kbps");
  });

  it("steps to Mbps at 1000 kbps, with one decimal", () => {
    // The mock's own reading: "1.4 Mbps".
    expect(formatRate(1_400_000)).toBe("1.4 Mbps");
    expect(formatRate(1_000_000)).toBe("1.0 Mbps");
  });

  it("steps to Gbps at 1000 Mbps, with one decimal", () => {
    expect(formatRate(1_000_000_000)).toBe("1.0 Gbps");
    expect(formatRate(2_500_000_000)).toBe("2.5 Gbps");
  });

  it("is null for anything that is not a finite number, never a crash", () => {
    // Same reason as formatBytes: this crosses a process boundary from a
    // daemon that may be older than this console, and an unknown field must
    // read as unknown rather than throw the console into a restart loop.
    expect(formatRate(null)).toBeNull();
    expect(formatRate(undefined)).toBeNull();
    expect(formatRate("1400000")).toBeNull();
    expect(formatRate(Number.NaN)).toBeNull();
    expect(formatRate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

/**
 * Relative time, held still. `now` is a parameter rather than a call to
 * `Date.now()` in here, so none of this races the wall clock.
 */
describe("formatLastHeard", () => {
  const now = 1_000_000_000;

  it("is null when nothing has ever been heard, not a bogus duration", () => {
    expect(formatLastHeard(null, now)).toBeNull();
  });

  it("is 'just now' under ten seconds", () => {
    expect(formatLastHeard(now, now)).toBe("just now");
    expect(formatLastHeard(now - 9_999, now)).toBe("just now");
  });

  it("counts seconds from ten up to a minute", () => {
    expect(formatLastHeard(now - 10_000, now)).toBe("10 s ago");
    expect(formatLastHeard(now - 42_000, now)).toBe("42 s ago");
    expect(formatLastHeard(now - 59_000, now)).toBe("59 s ago");
  });

  it("counts minutes from one up to an hour", () => {
    expect(formatLastHeard(now - 60_000, now)).toBe("1 min ago");
    expect(formatLastHeard(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(formatLastHeard(now - 59 * 60_000, now)).toBe("59 min ago");
  });

  it("counts hours from one up to a day", () => {
    expect(formatLastHeard(now - 60 * 60_000, now)).toBe("1 h ago");
    expect(formatLastHeard(now - 2 * 60 * 60_000, now)).toBe("2 h ago");
    expect(formatLastHeard(now - 23 * 60 * 60_000, now)).toBe("23 h ago");
  });

  it("counts days from one, with no ceiling", () => {
    expect(formatLastHeard(now - 24 * 60 * 60_000, now)).toBe("1 d ago");
    expect(formatLastHeard(now - 3 * 24 * 60 * 60_000, now)).toBe("3 d ago");
  });
});

describe("formatSpan", () => {
  it.each([
    [2_000, "last 2 s"],
    [30_000, "last 30 s"],
    [120_000, "last 2 min"],
    [600_000, "last 10 min"],
    [7_200_000, "last 2 h"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatSpan(ms)).toBe(expected);
  });

  it.each([null, undefined, 0, -1, Number.NaN, "2000"])("is null for %s", (bad) => {
    expect(formatSpan(bad)).toBeNull();
  });
});
