// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { groupThousands } from "./digits.js";

describe("groupThousands", () => {
  it("groups the thousands with a plain space", () => {
    expect(groupThousands(57600)).toBe("57 600");
    expect(groupThousands(115200)).toBe("115 200");
    expect(groupThousands(921600)).toBe("921 600");
  });

  it("does not group a number under a thousand", () => {
    expect(groupThousands(600)).toBe("600");
    expect(groupThousands(0)).toBe("0");
  });

  it("groups more than one thousands separator", () => {
    expect(groupThousands(1_234_567)).toBe("1 234 567");
  });

  it("truncates a fractional value rather than grouping a decimal point", () => {
    // Callers hand this whole measurements (a baud rate); truncating rather
    // than rounding or throwing is the same choice `Math.trunc` elsewhere in
    // this package makes for a value that should never be fractional in the
    // first place.
    expect(groupThousands(57600.9)).toBe("57 600");
  });
});
