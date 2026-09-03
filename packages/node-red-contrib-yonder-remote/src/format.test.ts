// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatBytes, formatLastHeard } from "./format.js";

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
