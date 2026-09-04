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

  /**
   * **The guard the seeded form put pressure on (R-UI-17).**
   *
   * The boxes are now filled from `network.modem` when the page opens, and an
   * unconfigured device has `apn: null` there. `null` is neither `undefined`
   * nor `""`: it sailed past the old test, and `enabled: true, apn: null`
   * would have been applied — the modem turned on with no APN, which is the
   * exact failure this guard exists for. `modemForm` seeds `""` rather than
   * `null` for that reason, and this is the second lock on the same door.
   */
  it.each([null, undefined, 42, {}])("refuses an APN that is not one (%s)", (apn) => {
    expect(() => modemRequest({ apn } as never)).toThrow(/needs an APN/i);
  });

  /**
   * The seeded form's ordinary case: nothing touched, CONNECT pressed. Every
   * box holds what the configuration holds, so the request restates it and the
   * apply is a no-op on those fields — except that the operator has now
   * explicitly asked for the modem to be used.
   */
  it("sends a seeded form back unchanged", () => {
    expect(modemRequest({ apn: "ereseller", dial: "*99#", username: "sim-user", password: "" }))
      .toEqual({ enabled: true, apn: "ereseller", username: "sim-user", dial: "*99#" });
  });
});
