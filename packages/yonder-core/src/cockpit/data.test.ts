// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CockpitData } from "./data.js";
import { TrafficFeed } from './traffic.js';
it('keeps public downloads off the aircraft unless aircraft proxy is explicitly selected',async()=>{
 let trafficCalls=0,tileCalls=0;
 const feed=new TrafficFeed({fetcher:async()=>{trafficCalls++;return {now:Date.now(),ac:[]}}});
 const data=new CockpitData({traffic:feed,fetcher:async()=>{tileCalls++;return {bytes:Buffer.from([137,80,78,71,13,10,26,10]),type:'image/png'}}});
 expect(data.options.sourceMode).toBe('ground');
 data.configure({traffic:true,terrain:true,imagery:true});
 data.snapshot({lat:35,lon:-83,valid:true});
 expect((await data.tile('imagery',12,10,10)).status).toBe(403);
 expect(trafficCalls).toBe(0);expect(tileCalls).toBe(0);
 data.configure({sourceMode:'offline'});data.snapshot({lat:35,lon:-83,valid:true});
 expect(trafficCalls).toBe(0);
 data.configure({sourceMode:'aircraft'});data.snapshot({lat:35,lon:-83,valid:true});
 expect((await data.tile('imagery',12,10,10)).status).toBe(200);
 expect(trafficCalls).toBe(1);expect(tileCalls).toBe(1);
 data.close();
});
it('rejects unknown source paths without enabling other sources',()=>{
 const data=new CockpitData();expect(data.configure({sourceMode:'automatic-fallback',traffic:true})).toBe(false);
 expect(data.options.traffic).toBe(false);data.close();
});
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
    expect(data.configure({ sourceMode: "aircraft", terrain: true })).toBe(true);
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
    data.configure({ sourceMode: "aircraft", imagery: true });
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
    data.configure({ sourceMode: "aircraft", imagery: true });
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
    data.configure({ sourceMode: "aircraft", imagery: true });
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


describe("tile cancellation ownership", () => {
  const png = (marker: number) => ({ bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, marker]), type: "image/png" });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  it.each([["imagery", "imagery"], ["elevation", "terrain"]] as const)("aborts active %s work on layer opt-out and refuses its late cache write", async (layer, setting) => {
    let calls = 0, signal: AbortSignal | undefined, finish!: (reply: ReturnType<typeof png>) => void;
    const data = new CockpitData({ fetcher: async (_url, _limit, currentSignal) => {
      calls++; signal = currentSignal;
      // Deliberately finish after abort: a raced provider completion must not enter the cache.
      return calls === 1 ? new Promise(resolve => { finish = resolve; }) : png(2);
    } });
    data.configure({ sourceMode: "aircraft", [setting]: true });
    const pending = data.tile(layer, 8, 1, 1); await settle();
    try {
      data.configure({ [setting]: false });
      expect(signal?.aborted).toBe(true);
      finish(png(1)); expect((await pending).status).toBe(403);
      data.configure({ [setting]: true });
      const fresh = await data.tile(layer, 8, 1, 1);
      expect(calls).toBe(2); expect(fresh).toMatchObject({ status: 200, body: { data: png(2).bytes.toString("base64") } });
    } finally { finish(png(1)); data.close(); await pending; }
  });
  it("discards an old source response even when aircraft mode is re-enabled before it arrives", async () => {
    let calls = 0, finish!: (reply: ReturnType<typeof png>) => void;
    const data = new CockpitData({ fetcher: async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : png(2) });
    data.configure({ sourceMode: "aircraft", imagery: true });
    const pending = data.tile("imagery", 8, 1, 1); await settle();
    try {
      data.configure({ sourceMode: "ground" }); data.configure({ sourceMode: "aircraft" });
      finish(png(1)); expect((await pending).status).toBe(403);
      expect((await data.tile("imagery", 8, 1, 1)).body.data).toBe(png(2).bytes.toString("base64"));
      expect(calls).toBe(2);
    } finally { finish(png(1)); data.close(); await pending; }
  });
  it("cancels queued source work instead of starting it with a replacement controller", async () => {
    let calls = 0;
    const data = new CockpitData({ fetcher: async (_url, _limit, signal) => {
      calls++;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    data.configure({ sourceMode: "aircraft", imagery: true });
    const pending = Array.from({ length: 10 }, (_, x) => data.tile("imagery", 8, x, 0)); await settle();
    try {
      expect(calls).toBe(8);
      data.configure({ sourceMode: "offline" }); data.configure({ sourceMode: "aircraft" });
      await settle(); expect(calls).toBe(8);
      expect((await Promise.all(pending)).every(reply => reply.status === 403)).toBe(true);
    } finally { data.close(); await Promise.all(pending); }
  });
});
