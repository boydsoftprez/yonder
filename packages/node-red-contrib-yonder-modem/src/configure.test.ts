// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { modemRequest } from "./configure.js";

describe("modemRequest", () => {
  it("sends only the fields the operator filled in", () => {
    // An empty box is not an instruction to clear a setting. Sending "" for a
    // password an operator did not touch would wipe a working credential.
    expect(modemRequest({ apn: "ereseller", username: "", password: "", dial: "" }))
      .toEqual({ enabled: true, apn: "ereseller" });
  });

  it("enables the modem, because typing an APN is asking for it to be used", () => {
    expect(modemRequest({ apn: "a" }).enabled).toBe(true);
  });

  it("refuses to send nothing at all", () => {
    // A form submitted empty would otherwise apply a document identical to the
    // one already in force, which reports success and changes nothing.
    expect(() => modemRequest({ apn: "" })).toThrow(/needs an APN/i);
  });
});
