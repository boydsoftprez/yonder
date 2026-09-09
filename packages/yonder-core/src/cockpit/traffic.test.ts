// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { TrafficFeed } from "./traffic.js";
import { GeoidGrid } from "./geoid.js";
const epoch = 1788790000000;
const center = { lat: 35.96, lon: -83.36, radiusNm: 25 };
const raw = (extra = {}) => ({
  hex: "abc123",
  lat: 35.97,
  lon: -83.36,
  seen_pos: 0,
  alt_geom: 2000,
  alt_baro: 1500,
  ...extra,
});
describe("ported observed ADS-B traffic", () => {
  it("converts geometric altitude with the bundled geoid, never pressure altitude", () => {
    const grid = new GeoidGrid();
    expect(grid.undulation(35.9607874, -83.3668696)).toBeCloseTo(-31.72435, 4);
    const feed = new TrafficFeed({ now: () => epoch, geoid: grid });
    feed.ingest({ now: epoch, ac: [raw()] }, center);
    expect(feed.snapshot(center).tracks[0]!.altitudeMslM).toBeCloseTo(
      2000 * 0.3048 - grid.undulation(35.97, -83.36),
      4,
    );
    feed.ingest(
      { now: epoch + 1, ac: [raw({ hex: "bcd123", alt_geom: undefined })] },
      center,
    );
    expect(
      feed.snapshot(center).tracks.find((t) => t.id === "bcd123")!.altitudeMslM,
    ).toBeNull();
  });
  it("does not freshen cached positions and breaks trails on invalid fixes and long gaps", () => {
    let now = epoch;
    const feed = new TrafficFeed({ now: () => now });
    feed.ingest({ now, ac: [raw()] }, center);
    now += 2000;
    feed.ingest({ now, ac: [raw({ seen_pos: 2 })] }, center);
    expect(feed.snapshot(center).tracks[0]!.observedAtMs).toBe(epoch);
    expect(feed.snapshot(center).tracks[0]!.history).toHaveLength(1);
    now += 2000;
    feed.ingest({ now, ac: [raw({ lat: null })] }, center);
    now += 2000;
    feed.ingest({ now, ac: [raw({ lat: 35.971 })] }, center);
    expect(feed.snapshot(center).tracks[0]!.history[1]!.breakBefore).toBe(true);
    now += 61000;
    expect(feed.snapshot(center).tracks).toHaveLength(0);
  });
  it("bounds output and rejects future or oversized provider arrays", () => {
    const feed = new TrafficFeed({ now: () => epoch });
    expect(() => feed.ingest({ now: epoch + 6000, ac: [] }, center)).toThrow();
    expect(() =>
      feed.ingest({ now: epoch, ac: Array(10001).fill(raw()) }, center),
    ).toThrow();
    feed.ingest(
      {
        now: epoch,
        ac: Array.from({ length: 250 }, (_, i) =>
          raw({ hex: i.toString(16).padStart(6, "0") }),
        ),
      },
      center,
    );
    expect(feed.snapshot(center).tracks).toHaveLength(128);
  });
  it("coalesces requests, backs off failures and does not poll on construction", async () => {
    let now = epoch,
      calls = 0;
    const feed = new TrafficFeed({
      now: () => now,
      fetcher: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    expect(calls).toBe(0);
    await Promise.all([feed.poll(center), feed.poll(center)]);
    expect(calls).toBe(1);
    await feed.poll(center);
    expect(calls).toBe(1);
    expect(feed.snapshot(center).status).toBe("error");
    now += 3000;
    await feed.poll(center);
    expect(calls).toBe(2);
    feed.close();
    now += 10000;
    await feed.poll(center);
    expect(calls).toBe(2);
  });
});

it('bounds missing-fix trail markers through sustained aircraft churn',()=>{
 const feed=new TrafficFeed({now:()=>epoch});
 for(let i=0;i<1000;i++)feed.ingest({now:epoch,ac:[raw({hex:i.toString(16).padStart(6,'0'),lat:35.99-i*.00002}),raw({hex:(i-1).toString(16).padStart(6,'0'),lat:null})]},center);
 expect(Reflect.get(feed,'breaks').size).toBeLessThanOrEqual(128);
 feed.close();expect(Reflect.get(feed,'breaks').size).toBe(0);
});
