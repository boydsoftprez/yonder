// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { maintenanceProxy } from "./maintenance.js";
import { DaemonClient, type DaemonRequest } from "./client.js";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } servers.length = 0; });
async function harness(session: string | undefined) {
  const calls: DaemonRequest[] = []; const changed = vi.fn();
  const client = new DaemonClient({ transport: async r => { calls.push(r); return { status: 200, body: JSON.stringify({ ok: true }) }; } });
  const handler = maintenanceProxy({ client, session: () => session, passwordChanged: changed });
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end(); } });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, changed,
    setSession: (value: string | undefined) => { session = value; } };
}
const headers = { "content-type": "application/json", "x-yonder-maintenance": "1" };
describe("maintenance HTTP boundary", () => {
  it("allows bounded recovery uploads only on the preview route and revokes restored sessions", async () => {
    const h = await harness("server-session");
    const body = JSON.stringify({ archiveBase64: Buffer.alloc(12 * 1024).toString("base64"), owner: "attacker" });
    expect((await fetch(h.url + "/maintenance/api/recovery/preview", { method: "POST", headers, body })).status).toBe(200);
    expect(h.calls[0]).toMatchObject({ path: "/recovery/preview", timeoutMs: 60_000, body: { owner: "server-session" } });
    expect((await fetch(h.url + "/maintenance/api/recovery/commit", { method: "POST", headers, body })).status).toBe(413);
    await fetch(h.url + "/maintenance/api/recovery/commit", { method: "POST", headers, body: "{}" });
    expect(h.changed).toHaveBeenCalledOnce();
  });
  it("rechecks authentication after an upload has finished", async () => {
    const h = await harness("server-session");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(h.url + "/maintenance/api/recovery/preview", { method: "POST", headers }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.write('{"archiveBase64":"');
      setTimeout(() => { h.setSession(undefined); req.end('eA=="}'); }, 30);
    });
    expect(status).toBe(401); expect(h.calls).toEqual([]);
  });
  it("rejects unauthenticated reads/writes and cross-origin or ordinary form POSTs before the daemon", async () => {
    const a = await harness(undefined);
    expect((await fetch(a.url + "/maintenance/api/interfaces")).status).toBe(401);
    const b = await harness("server-session");
    expect((await fetch(b.url + "/maintenance/api/reboot", { method: "POST", headers: { ...headers, origin: "https://elsewhere.example" }, body: "{}" })).status).toBe(403);
    expect((await fetch(b.url + "/maintenance/api/reboot", { method: "POST", body: "confirm=REBOOT" })).status).toBe(415);
    expect(a.calls).toEqual([]); expect(b.calls).toEqual([]);
  });
  it("uses the trusted session owner, ignores owner/query spoofing and revokes sessions on password success", async () => {
    const h = await harness("server-session");
    await fetch(h.url + "/maintenance/api/diagnostics", { method: "POST", headers, body: JSON.stringify({ tool: "ping", host: "1.1.1.1", owner: "attacker" }) });
    expect(h.calls[0]!.body).toMatchObject({ owner: "server-session" });
    await fetch(h.url + "/maintenance/api/diagnostics/00000000-0000-0000-0000-000000000000?owner=attacker");
    expect(h.calls[1]!.path).toContain("owner=server-session");
    await fetch(h.url + "/maintenance/api/password", { method: "POST", headers, body: "{}" });
    expect(h.changed).toHaveBeenCalledOnce();
  });
  it("authenticates owner tools, replaces spoofed sessions and keeps console login after a Linux password change", async () => {
    const denied = await harness(undefined);
    expect((await fetch(denied.url + "/maintenance/api/owner")).status).toBe(401);
    expect((await fetch(denied.url + "/maintenance/api/owner/create", { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect(denied.calls).toEqual([]);
    const h = await harness("server-session");
    expect((await fetch(h.url + "/maintenance/api/owner/ssh", { method: "POST", headers: { ...headers, origin: "https://elsewhere.example" }, body: "{}" })).status).toBe(403);
    await fetch(h.url + "/maintenance/api/owner/password", { method: "POST", headers, body: JSON.stringify({ owner: "attacker", currentPassword: "console", newPassword: "linux", confirmPassword: "linux" }) });
    expect(h.calls[0]).toMatchObject({ path: "/owner/password", body: { owner: "server-session" } });
    expect(h.changed).not.toHaveBeenCalled();
    expect((await fetch(h.url + "/maintenance/api/owner/ssh", { method: "POST", headers, body: JSON.stringify({ authorizedKeys: ["x".repeat(9000)] }) })).status).toBe(413);
    expect(h.calls).toHaveLength(1);
  });
  it("bounds input and refuses undeclared endpoints/methods", async () => {
    const h = await harness("server-session");
    expect((await fetch(h.url + "/maintenance/api/password", { method: "POST", headers, body: JSON.stringify({ password: "x".repeat(9000) }) })).status).toBe(413);
    expect((await fetch(h.url + "/maintenance/api/reboot")).status).toBe(405);
    expect((await fetch(h.url + "/maintenance/api/execute")).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});
