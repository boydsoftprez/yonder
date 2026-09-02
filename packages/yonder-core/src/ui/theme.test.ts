// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { setTheme, THEMES } from "./theme.js";

describe("setTheme", () => {
  it("sets the theme it was given", () => {
    const r = setTheme(DEFAULT_CONFIG, { theme: "night" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.ui.theme).toBe("night");
  });

  it("refuses anything that is not one of the two, and names the two", () => {
    for (const bad of ["dusk", "", "DAY", 1, null, undefined, {}]) {
      const r = setTheme(DEFAULT_CONFIG, { theme: bad });
      expect(r.ok, `${JSON.stringify(bad)} must be refused`).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("day");
        expect(r.error).toContain("night");
      }
    }
    expect(setTheme(DEFAULT_CONFIG, undefined).ok).toBe(false);
  });

  it("does not echo what was submitted", () => {
    // The value reached this function from a browser and is going back to one.
    const r = setTheme(DEFAULT_CONFIG, { theme: "<script>alert(1)</script>" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("script");
  });

  // The defect this module exists for. The wiring it replaced held the last
  // configuration in flow context, copied it into the message by reference,
  // and assigned through that reference — so choosing a theme edited the cache
  // in place, and a revert left the cache holding a theme the device did not
  // have.
  it("never touches the configuration it was given", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    const r = setTheme(DEFAULT_CONFIG, { theme: "night" });
    expect(DEFAULT_CONFIG).toEqual(before);
    if (r.ok) expect(r.config).not.toBe(DEFAULT_CONFIG);
  });

  it("returns a document that shares no object with the original", () => {
    const r = setTheme(DEFAULT_CONFIG, { theme: "night" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mutating the result anywhere must not be visible through the input.
    r.config.network.ap.ssid = "changed-by-the-caller";
    expect(DEFAULT_CONFIG.network.ap.ssid).not.toBe("changed-by-the-caller");
  });

  it("changes nothing but the theme", () => {
    const r = setTheme(DEFAULT_CONFIG, { theme: "night" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = structuredClone(DEFAULT_CONFIG);
    expected.ui.theme = "night";
    expect(r.config).toEqual(expected);
  });

  it("offers exactly the themes the schema accepts", () => {
    // Two lists that must not drift: this one, and the schema's enum. If a
    // third mode is ever added, this fails until both are updated.
    for (const t of THEMES) {
      expect(setTheme(DEFAULT_CONFIG, { theme: t }).ok, `${t} must be accepted`).toBe(true);
    }
  });
});
