// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { cockpitProxy } from "./cockpit.js";
import { DaemonClient, type DaemonRequest } from "./client.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((r) => server.close(() => r()));
});
async function harness(session: string | null = "server-session") {
  const calls: DaemonRequest[] = [];
  const client = new DaemonClient({
    transport: async (request) => {
      calls.push(request);
      return { status: 202, body: JSON.stringify({ operationId: "one" }) };
    },
  });
  const handler = cockpitProxy({ client, session: () => session ?? undefined });
  const server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    calls,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-yonder-cockpit": "1" },
  body: JSON.stringify(body),
});
describe("authenticated cockpit boundary", () => {
  it("refuses unauthenticated reads and writes before contacting the daemon", async () => {
    const { url, calls } = await harness(null);
    expect((await fetch(url + "/cockpit/api/state")).status).toBe(401);
    expect((await fetch(url + "/cockpit/api/command", post({}))).status).toBe(
      401,
    );
    expect(calls).toHaveLength(0);
  });
  it("injects session provenance and never accepts the body session", async () => {
    const { url, calls } = await harness();
    const res = await fetch(
      url + "/cockpit/api/command",
      post({
        id: "one",
        sessionId: "spoof",
        confirmed: true,
        action: { kind: "arm", armed: true },
      }),
    );
    expect(res.status).toBe(202);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/cockpit/command",
      body: {
        id: "one",
        sessionId: "server-session",
        confirmed: true,
        action: { kind: "arm", armed: true },
      },
    });
  });
  it("rejects cross-origin or simple form writes", async () => {
    const { url, calls } = await harness();
    expect(
      (
        await fetch(url + "/cockpit/api/command", {
          ...post({}),
          headers: { ...post({}).headers, origin: "https://elsewhere.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url + "/cockpit/api/command", {
          method: "POST",
          body: "confirmed=true",
        })
      ).status,
    ).toBe(415);
    expect(calls).toHaveLength(0);
  });
  it("bounds mission bodies and rejects malformed JSON", async () => {
    const { url, calls } = await harness();
    expect(
      (await fetch(url + "/cockpit/api/command", { ...post({}), body: "{" }))
        .status,
    ).toBe(400);
    expect(
      (
        await fetch(
          url + "/cockpit/api/command",
          post({ data: "x".repeat(524289) }),
        )
      ).status,
    ).toBe(413);
    expect(calls).toHaveLength(0);
  });
  it("only relays explicitly named cockpit routes", async () => {
    const { url, calls } = await harness();
    expect(
      (await fetch(url + "/cockpit/api/../../apply", post({}))).status,
    ).toBe(404);
    expect((await fetch(url + "/cockpit/api/state", post({}))).status).toBe(
      405,
    );
    expect(calls).toHaveLength(0);
    await fetch(url + "/cockpit/api/state");
    expect(calls[0]).toEqual({ method: "GET", path: "/cockpit/state" });
  });
});

it("uses the real console session and rejects a revoked cookie", async () => {
  const { SessionStore } = await import("./session.js");
  const { consoleMiddleware, viewerFor, SESSION_COOKIE } = await import(
    "./middleware.js"
  );
  const sessions = new SessionStore(),
    token = sessions.mint(),
    calls: DaemonRequest[] = [];
  const client = new DaemonClient({
    transport: async (request) => {
      calls.push(request);
      return { status: 202, body: "{}" };
    },
  });
  const middleware = consoleMiddleware({ client, sessions });
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/cockpit/api/command`;
  const request = {
    ...post({ id: "test", sessionId: "spoof" }),
    headers: { ...post({}).headers, cookie: `${SESSION_COOKIE}=${token}` },
  };
  expect((await fetch(url, request)).status).toBe(202);
  expect(calls[0]?.body).toEqual({ id: "test", sessionId: viewerFor(token) });
  sessions.revoke(token);
  expect((await fetch(url, request)).status).toBe(401);
  expect(calls).toHaveLength(1);
});
