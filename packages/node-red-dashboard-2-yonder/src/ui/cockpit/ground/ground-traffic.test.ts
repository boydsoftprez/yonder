// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node
import { it, expect } from "vitest";
import { TrafficFeed } from "./ground-traffic.mjs";
const epoch = 1788790000000,
  center = { lat: 35.96, lon: -83.36, radiusNm: 1 },
  raw = (extra = {}) => ({
    hex: "abc123",
    lat: 35.961,
    lon: -83.36,
    seen_pos: 0,
    alt_geom: 2000,
    alt_baro: 1500,
    ...extra,
  });
it("preserves core observation age/trail gaps and accepts actual one-NM radius", () => {
  let now = epoch;
  const f = new TrafficFeed({ now: () => now });
  f.ingest({ now, ac: [raw()] }, center);
  expect(f.snapshot(center).tracks[0].altitudeMslM).toBeNull();
  now += 2000;
  f.ingest({ now, ac: [raw({ seen_pos: 2 })] }, center);
  expect(f.snapshot(center).tracks[0].observedAtMs).toBe(epoch);
  expect(f.snapshot(center).tracks[0].history).toHaveLength(1);
  now += 2000;
  f.ingest({ now, ac: [raw({ lat: null })] }, center);
  now += 2000;
  f.ingest({ now, ac: [raw({ lat: 35.962 })] }, center);
  expect(f.snapshot(center).tracks[0].history[1].breakBefore).toBe(true);
  now += 61000;
  expect(f.snapshot(center).tracks).toHaveLength(0);
  f.close();
});
it("uses only geometric height with a ground-provisioned geoid, never pressure altitude", () => {
  const f = new TrafficFeed({
    now: () => epoch,
    geoid: { undulation: () => -31.7 },
  });
  f.ingest(
    { now: epoch, ac: [raw(), raw({ hex: "abc124", alt_geom: undefined })] },
    center,
  );
  expect(f.snapshot(center).tracks[0].altitudeMslM).toBeCloseTo(641.3);
  expect(f.snapshot(center).tracks[1].altitudeMslM).toBeNull();
  f.close();
});
it("bounds local tracks, histories and missing-fix markers and expires stale feeds", () => {
  let now = epoch;
  const f = new TrafficFeed({ now: () => now });
  for (let i = 0; i < 1000; i++) {
    f.ingest(
      {
        now,
        ac: [
          raw({ hex: i.toString(16).padStart(6, "0") }),
          raw({ hex: (i - 1).toString(16).padStart(6, "0"), lat: null }),
        ],
      },
      center,
    );
    now++;
  }
  expect(f.snapshot(center).tracks.length).toBeLessThanOrEqual(128);
  expect(f.breaks.size).toBeLessThanOrEqual(128);
  now += 16000;
  expect(f.snapshot(center).status).toBe("stale");
  expect(() => f.ingest({ now: now + 6000, ac: [] }, center)).toThrow();
  f.close();
});
