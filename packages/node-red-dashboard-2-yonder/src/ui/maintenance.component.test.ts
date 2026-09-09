// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import YonderInterfaces from "./YonderInterfaces.vue";
import YonderDiagnostics from "./YonderDiagnostics.vue";
import YonderSettings from "./YonderSettings.vue";
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { for (const w of wrappers) w.unmount(); wrappers.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); });
function response(value: unknown, status = 200) { return Promise.resolve({ ok: status < 400, status, json: async () => value }); }
const snapshot = { sampledAt: 1, defaultRoutes: [], interfaces: [{
  device: "eth0", kind: "ethernet", state: "connected", carrier: true, defaultRoutes: [],
  addresses: [{ address: "192.168.1.2", prefix: 24, family: 4, scope: "global" }],
}] };
it("clears a previous interface address when refresh fails, then replaces it on recovery", async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => response(snapshot)).mockImplementationOnce(() => Promise.reject(new Error("Device offline")))
    .mockImplementationOnce(() => response({ ...snapshot, interfaces: [{ ...snapshot.interfaces[0], addresses: [] }] }));
  vi.stubGlobal("fetch", fetcher);
  const wrapper = mount(YonderInterfaces); wrappers.push(wrapper); await flushPromises();
  expect(wrapper.text()).toContain("192.168.1.2");
  await wrapper.get("button").trigger("click"); await flushPromises();
  expect(wrapper.text()).not.toContain("192.168.1.2"); expect(wrapper.text()).toContain("Device offline");
  await wrapper.get("button").trigger("click"); await flushPromises();
  expect(wrapper.text()).toContain("No address");
});
it("displays terminal output as text, runs the selected interface and can cancel the job", async () => {
  const job = { id: "00000000-0000-0000-0000-000000000000", tool: "ping", command: "ping -I eth0 example.com", host: "example.com", device: "eth0", status: "running", startedAt: Date.now(), finishedAt: null, exitCode: null, output: "<img src=x onerror=alert(1)>\nreply", truncated: false };
  const fetcher = vi.fn((url: string) => response(url.endsWith("/interfaces") ? snapshot : url.endsWith("/cancel") ? { ...job, status: "cancelled" } : job));
  vi.stubGlobal("fetch", fetcher);
  const wrapper = mount(YonderDiagnostics); wrappers.push(wrapper); await flushPromises();
  await wrapper.findAll("select")[0]!.setValue("ping");
  await wrapper.get('input[placeholder]').setValue("example.com");
  await wrapper.findAll("select")[1]!.setValue("eth0");
  await wrapper.get("form").trigger("submit"); await flushPromises();
  expect(JSON.parse(fetcher.mock.calls.find(c => c[0].endsWith("/diagnostics"))![1]!.body)).toMatchObject({ host: "example.com", device: "eth0" });
  expect(wrapper.get("pre").text()).toContain("<img");
  expect(wrapper.find("img").exists()).toBe(false);
  await wrapper.findAll("button").find(b => b.text() === "Cancel")!.trigger("click"); await flushPromises();
  expect(wrapper.text()).toContain("cancelled");
});
it("masks passwords, rejects mismatch without a request and clears secrets after submission", async () => {
  const fetcher = vi.fn((url: string) => response(url.endsWith("preferences") ? { theme: "night" } : { ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const wrapper = mount(YonderSettings); wrappers.push(wrapper); await flushPromises();
  const inputs = wrapper.findAll('input[type="password"]'); expect(inputs).toHaveLength(3);
  await inputs[0]!.setValue("old password"); await inputs[1]!.setValue("new password"); await inputs[2]!.setValue("different");
  await wrapper.get("form").trigger("submit"); await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(wrapper.text()).toContain("do not match");
  await inputs[2]!.setValue("new password"); await wrapper.get("form").trigger("submit"); await flushPromises();
  expect(wrapper.text()).toContain("Password changed"); expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  expect(wrapper.vm.currentPassword).toBe(""); expect(wrapper.vm.newPassword).toBe("");
});
it("offers a one-click internet speed test without a hostname and shows the measured results", async () => {
  const job = { id: "00000000-0000-0000-0000-000000000001", tool: "internet-speed", status: "succeeded", startedAt: 0, finishedAt: 5000,
    command: "Internet speed test", output: "Download: 45.20 Mb/s", exitCode: 0,
    internetSpeed: { provider: "Cloudflare", phase: "complete", downloadMbps: 45.2, uploadMbps: 8.1, latencyMs: 22.3, transferredBytes: 5_000_000, localIp: "192.0.2.2" } };
  const fetcher = vi.fn((url: string) => response(url.endsWith("/interfaces") ? snapshot : job));
  vi.stubGlobal("fetch", fetcher);
  const wrapper = mount(YonderDiagnostics); wrappers.push(wrapper); await flushPromises();
  expect(wrapper.find('input[placeholder]').exists()).toBe(false);
  expect(wrapper.text()).toContain("No server setup");
  await wrapper.get("form").trigger("submit"); await flushPromises();
  const results = wrapper.get('[aria-label="Internet speed results"]');
  expect(results.text()).toContain("45.2"); expect(results.text()).toContain("8.1");
  expect(results.text()).toContain("22.3");
});
