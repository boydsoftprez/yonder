// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigWatch, configFingerprint } from "./changed.js";

/**
 * The decision behind R-UI-20: whether the configuration a console is drawn
 * from has actually moved.
 *
 * The two failures being held apart are opposite and both real. Missing a
 * change leaves a page asserting a setting the device no longer has — which
 * on `mavlink.ingest` is a page saying nothing can command the aircraft while
 * anything on the network can (R-MAV-07). Reporting a change that did not
 * happen re-seeds ten boxes an operator types into, on a clock.
 */
describe("configFingerprint", () => {
  it("gives one document one answer, however its keys are ordered", () => {
    expect(configFingerprint({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(configFingerprint({ a: { c: 3, d: 2 }, b: 1 }));
  });

  /**
   * Order is data in an array and noise in an object, and the difference is
   * load-bearing here: `mavlink.endpoints` is a list, and two ground stations
   * swapped is a different configuration whichever way the keys sort.
   */
  it("keeps the order of a list, because a list's order is the setting", () => {
    const one = { endpoints: [{ host: "10.0.0.1" }, { host: "10.0.0.2" }] };
    const other = { endpoints: [{ host: "10.0.0.2" }, { host: "10.0.0.1" }] };
    expect(configFingerprint(one)).not.toBe(configFingerprint(other));
  });

  it("separates a document that is absent from one that is empty", () => {
    expect(configFingerprint(undefined)).not.toBe(configFingerprint({}));
    expect(configFingerprint(undefined)).not.toBe(configFingerprint(null));
  });

  /** The setting the defect was found on, in both of its two values. */
  it("tells the two ingest settings apart", () => {
    const closed = { mavlink: { ingest: { loopback_only: true } } };
    const open = { mavlink: { ingest: { loopback_only: false } } };
    expect(configFingerprint(closed)).not.toBe(configFingerprint(open));
  });
});

describe("ConfigWatch", () => {
  /**
   * The first read is news. It is what seeds every box on the console when it
   * opens (R-UI-17); a watch that waited for a second, different read would
   * leave a configured device showing empty forms until somebody changed
   * something.
   */
  it("treats the first document it sees as a change", () => {
    const watch = new ConfigWatch();
    expect(watch.started).toBe(false);
    expect(watch.changed({ version: 1 })).toBe(true);
    expect(watch.started).toBe(true);
  });

  /**
   * **The whole point.** Ten `ui-text-input` boxes are seeded from this. If an
   * unchanged document read as news, every one of them would be overwritten
   * every two seconds and nobody could finish typing an APN.
   */
  it("says nothing when the document has not moved, however often it is read", () => {
    const watch = new ConfigWatch();
    const config = { mavlink: { ingest: { loopback_only: true } }, network: { modem: { apn: "ereseller" } } };
    expect(watch.changed(config)).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      // A fresh object each time, as a fresh parse of the same reply would be.
      expect(watch.changed(structuredClone(config))).toBe(false);
    }
  });

  it("says so when one setting under it moved", () => {
    const watch = new ConfigWatch();
    watch.changed({ mavlink: { ingest: { loopback_only: true } } });
    expect(watch.changed({ mavlink: { ingest: { loopback_only: false } } })).toBe(true);
  });

  /**
   * A change and a rollback are one change each, not one between them. The
   * device puts the previous configuration back by itself when nobody
   * confirms (R-CFG-03), and the page that showed the new value has to go
   * back — which is the half of K-25 that was never about the page the change
   * was made on.
   */
  it("reports the way back as its own change", () => {
    const watch = new ConfigWatch();
    const closed = { mavlink: { ingest: { loopback_only: true } } };
    watch.changed(closed);
    expect(watch.changed({ mavlink: { ingest: { loopback_only: false } } })).toBe(true);
    expect(watch.changed(structuredClone(closed))).toBe(true);
    expect(watch.changed(structuredClone(closed))).toBe(false);
  });
});
