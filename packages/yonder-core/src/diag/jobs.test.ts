// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJobs, diagnosticCommand, diagnosticRequest, type DiagnosticRunner } from "./jobs.js";
const services: DiagnosticJobs[] = [];
afterEach(() => { for (const s of services) s.close(); services.length = 0; vi.useRealTimers(); });
function harness(extra: Partial<ConstructorParameters<typeof DiagnosticJobs>[0]> = {}) {
  let finish!: (v: { code: number | null }) => void;
  let output!: (text: string) => void;
  const stop = vi.fn();
  const runner: DiagnosticRunner = vi.fn((_argv, emit) => { output = emit; return { done: new Promise(resolve => { finish = resolve; }), stop }; });
  const service = new DiagnosticJobs({ runner, devices: async () => ["eth0", "wlan0", "zttest"], ...extra }); services.push(service);
  return { service, runner, stop, emit: (text: string) => output(text), finish: (code: number) => finish({ code }) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("bounded operator diagnostics", () => {
  it("accepts DNS and IPv6 and rejects flags, shell syntax and invalid bounds", () => {
    for (const host of ["example.com", "192.168.1.1", "2001:db8::1"]) expect(diagnosticRequest({ tool: "ping", host }).host).toBe(host);
    for (const host of ["-f", "a;reboot", "$(id)", "1.1.1.1/24", "999.1.1.1"])
      expect(() => diagnosticRequest({ tool: "ping", host })).toThrow();
    expect(() => diagnosticRequest({ tool: "bandwidth", host: "example.com", seconds: 1000 })).toThrow();
    expect(() => diagnosticRequest({ tool: "ping", host: "::1", family: 4 })).toThrow();
    expect(diagnosticCommand(diagnosticRequest({ tool: "bandwidth", host: "example.com", device: "eth0", direction: "download" })))
      .toEqual(["iperf3", "-4", "-c", "example.com", "-p", "5201", "-t", "5", "-i", "1", "--forceflush", "--connect-timeout", "3000", "-b", "10M", "--bind-dev", "eth0", "-R"]);
  });
  it("streams plain output, caps it, and isolates reads/cancellation by session", async () => {
    const h = harness(); const job = h.service.start("a", { tool: "ping", host: "example.com" }); await flush();
    h.emit("<script>alert(1)</script>\r\nhello\u0000");
    expect(h.service.read("a", job.id)!.output).toBe("<script>alert(1)</script>\nhello");
    expect(h.service.read("b", job.id)).toBeNull(); expect(h.service.cancel("b", job.id)).toBeNull();
    h.emit("x".repeat(70_000));
    expect(h.service.read("a", job.id)!.output.length).toBe(65_536);
    expect(h.service.read("a", job.id)!.truncated).toBe(true);
    h.finish(1); await flush();
    expect(h.service.read("a", job.id)).toMatchObject({ status: "failed", exitCode: 1 });
  });
  it("kills timed-out work and does not admit a second process until it closes", async () => {
    vi.useFakeTimers(); const h = harness({ timeoutMs: 20 });
    const job = h.service.start("a", { tool: "traceroute", host: "example.com" }); await flush();
    await vi.advanceTimersByTimeAsync(21);
    expect(h.stop).toHaveBeenCalledOnce(); expect(h.service.read("a", job.id)!.status).toBe("timed-out");
    expect(() => h.service.start("a", { tool: "ping", host: "example.com" })).toThrow("already running");
    h.finish(0); await flush();
    expect(h.service.read("a", job.id)!.status).toBe("timed-out");
    expect(() => h.service.start("a", { tool: "ping", host: "example.com" })).not.toThrow();
  });
  it("does not launch a route command after cancellation during DNS resolution", async () => {
    let resolve!: (address: string) => void;
    const h = harness({ resolve: () => new Promise(r => { resolve = r; }) });
    const job = h.service.start("a", { tool: "route", host: "example.com" });
    h.service.cancel("a", job.id); resolve("192.0.2.1"); await flush();
    expect(h.runner).not.toHaveBeenCalled();
  });
  it("refuses a removed interface instead of silently falling back to LTE", async () => {
    const h = harness(); const job = h.service.start("a", { tool: "ping", host: "1.1.1.1", device: "eth9" }); await flush();
    expect(h.runner).not.toHaveBeenCalled(); expect(h.service.read("a", job.id)!.status).toBe("failed");
  });
  it("shows the resolved address and forces the requested interface in route lookup", async () => {
    const h = harness({ resolve: async () => "192.0.2.1" });
    const job = h.service.start("a", { tool: "route", host: "example.com", device: "eth0" }); await flush();
    expect(h.service.read("a", job.id)!.command).toBe("ip -4 route get 192.0.2.1 oif eth0");
    h.finish(0); await flush();
  });
});
