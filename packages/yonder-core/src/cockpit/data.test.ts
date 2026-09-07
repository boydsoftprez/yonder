// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CockpitData } from "./data.js";
describe("bounded optional geographic data", () => {
  it("requires enablement, validates tile coordinates and coalesces identical fetches", async () => {
    const urls: string[] = [];
    const data = new CockpitData({
      fetcher: async (url) => {
        urls.push(url);
        return {
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          type: "image/png",
        };
      },
    });
    expect((await data.tile("elevation", 12, 1000, 1000)).status).toBe(403);
    expect(urls).toHaveLength(0);
    expect(data.configure({ terrain: true })).toBe(true);
    expect((await data.tile("elevation", 12, -1, 0)).status).toBe(400);
    const [one, two] = await Promise.all([
      data.tile("elevation", 12, 1000, 1000),
      data.tile("elevation", 12, 1000, 1000),
    ]);
    expect(one.status).toBe(200);
    expect(two).toEqual(one);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1000/1000.png",
    );
    expect((await data.tile("untrusted", 12, 0, 0)).status).toBe(400);
    data.close();
  });
  it("rejects invalid data configuration without partially changing state", () => {
    const data = new CockpitData();
    expect(data.configure({ traffic: true, trafficRadiusNm: 1000 })).toBe(
      false,
    );
    expect(data.options.traffic).toBe(false);
    expect(data.configure({ traffic: true, trafficRadiusNm: 50 })).toBe(true);
    expect(data.options.trafficRadiusNm).toBe(50);
    data.close();
  });
  it("does not cache provider errors or decode HTML as an image", async () => {
    let calls = 0;
    const data = new CockpitData({
      fetcher: async () => {
        calls++;
        return { bytes: Buffer.from("<html>"), type: "text/html" };
      },
    });
    data.configure({ imagery: true });
    expect((await data.tile("imagery", 12, 1000, 1000)).status).toBe(502);
    expect(calls).toBe(1);
    data.close();
  });
  it("queues a map's concurrent layer requests within an eight-fetch limit", async () => {
    let active = 0,
      peak = 0;
    const releases: (() => void)[] = [];
    const data = new CockpitData({
      fetcher: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return {
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          type: "image/png",
        };
      },
    });
    data.configure({ imagery: true });
    const tiles = Array.from({ length: 24 }, (_, x) =>
      data.tile("imagery", 8, x, 0),
    );
    for (let batch = 0; batch < 3; batch++) {
      await new Promise((resolve) => setImmediate(resolve));
      expect(active).toBe(8);
      releases.splice(0).forEach((release) => release());
    }
    expect(
      (await Promise.all(tiles)).every((tile) => tile.status === 200),
    ).toBe(true);
    expect(peak).toBe(8);
    data.close();
  });
  it("bounds queued work and never starts queued provider requests after opt-out", async () => {
    let calls = 0;
    const releases: (() => void)[] = [];
    const data = new CockpitData({
      fetcher: async () => {
        calls++;
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          type: "image/png",
        };
      },
    });
    data.configure({ imagery: true });
    const tiles = Array.from({ length: 64 }, (_, x) =>
      data.tile("imagery", 8, x, 0),
    );
    expect((await data.tile("imagery", 8, 64, 0)).status).toBe(429);
    expect(calls).toBe(8);
    data.configure({ imagery: false });
    releases.splice(0).forEach((release) => release());
    const results = await Promise.all(tiles);
    expect(results.slice(8).every((tile) => tile.status === 403)).toBe(true);
    expect(calls).toBe(8);
    data.close();
  });
});
