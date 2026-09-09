// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJobs, diagnosticRequest, type DiagnosticRunner } from "./jobs.js";
import { internetSpeedTest, parseSpeedMeasurement, speedSample, SPEED_TEST_MAX_BYTES, type InternetSpeedResult } from "./internet-speed.js";
const services: DiagnosticJobs[] = [];
afterEach(() => { services.forEach(s => s.close()); services.length = 0; vi.useRealTimers(); });
function measurement(downloaded: number, uploaded = 0) {
  return { status: 200, downloaded, uploaded, total: 1.2, start: uploaded ? 1.19 : .2,
    connect: .03, dns: .01, pretransfer: .1, remote: "192.0.2.1", local: "192.0.2.2" };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
describe("public internet speed test", () => {
  it("needs no host and always selects the fixed public endpoint", () => {
    expect(diagnosticRequest({ tool: "internet-speed" })).toMatchObject({ host: "speed.cloudflare.com", family: 4 });
    expect(diagnosticRequest({ tool: "internet-speed", host: "http://localhost/secrets" }).host).toBe("speed.cloudflare.com");
  });
  it("measures upload through the request body, not just the short response", () => {
    const result = speedSample(measurement(2, 1_000_000), "upload");
    expect(result.seconds).toBeCloseTo(1.1); expect(result.mbps).toBeCloseTo(7.272727);
    expect(speedSample(measurement(1_000_000), "download").mbps).toBe(8);
    expect(() => parseSpeedMeasurement('{"status":200}')).toThrow();
  });
  it("runs sequential HTTPS requests on the selected interface, caps synthetic data and publishes rates", async () => {
    const requests: { argv: string[]; bytes: number }[] = []; const updates: InternetSpeedResult[] = []; const lines: string[] = [];
    const runner: DiagnosticRunner = (argv, emit, input) => {
      const url = new URL(argv.at(-1)!); const bytes = input?.byteLength ?? Number(url.searchParams.get("bytes"));
      requests.push({ argv, bytes });
      emit(JSON.stringify(measurement(input ? 2 : bytes, input ? bytes : 0)));
      return { done: Promise.resolve({ code: 0 }), stop() {} };
    };
    const run = internetSpeedTest({ runner, device: "eth0", family: 4, output: l => lines.push(l), progress: v => updates.push(v) });
    expect(await run.done).toEqual({ code: 0 });
    expect(requests.length).toBe(7);
    expect(requests.every(r => r.argv.includes("if!eth0") && r.argv.includes("=https") && r.argv[1] === "-q")).toBe(true);
    expect(requests.every(r => new URL(r.argv.at(-1)!).hostname === "speed.cloudflare.com")).toBe(true);
    expect(requests.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(SPEED_TEST_MAX_BYTES);
    expect(requests.filter(r => r.argv.includes("@-")).every(r => r.bytes <= 5_000_000)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ provider: "Cloudflare", phase: "complete", downloadMbps: 24 });
    expect(updates.at(-1)!.latencyMs).toBeCloseTo(20);
    expect(lines.join("")).toContain("Upload:");
  });
  it("stops the active request on cancellation and starts no further transfers", async () => {
    let resolve!: (v: { code: number }) => void;
    const stop = vi.fn(() => resolve({ code: 143 }));
    const runner: DiagnosticRunner = vi.fn(() => ({ done: new Promise(r => { resolve = r; }), stop }));
    const run = internetSpeedTest({ runner, family: 4, output() {}, progress() {} });
    run.stop(); await run.done;
    expect(stop).toHaveBeenCalledOnce(); expect(runner).toHaveBeenCalledOnce();
  });
  it("does not report fabricated speeds when the service refuses or sends a truncated payload", async () => {
    let last: InternetSpeedResult | undefined;
    const runner: DiagnosticRunner = (_argv, emit) => { emit(JSON.stringify(measurement(0))); return { done: Promise.resolve({ code: 0 }), stop() {} }; };
    const run = internetSpeedTest({ runner, family: 4, output() {}, progress: v => { last = v; } });
    expect((await run.done).code).toBe(1);
    expect(last).toMatchObject({ downloadMbps: null, uploadMbps: null });
  });
  it("uses the existing job ownership, output and final result lifecycle without automatic network traffic", async () => {
    const runner: DiagnosticRunner = vi.fn((argv, emit, input) => {
      const bytes = input?.byteLength ?? Number(new URL(argv.at(-1)!).searchParams.get("bytes"));
      emit(JSON.stringify(measurement(input ? 2 : bytes, input ? bytes : 0)));
      return { done: Promise.resolve({ code: 0 }), stop() {} };
    });
    const jobs = new DiagnosticJobs({ runner, devices: async () => ["eth0"] }); services.push(jobs);
    expect(runner).not.toHaveBeenCalled();
    const started = jobs.start("operator", { tool: "internet-speed", device: "eth0" }); await flush();
    expect(jobs.read("other", started.id)).toBeNull();
    expect(jobs.read("operator", started.id)).toMatchObject({ status: "succeeded", internetSpeed: { phase: "complete" } });
  });
});
