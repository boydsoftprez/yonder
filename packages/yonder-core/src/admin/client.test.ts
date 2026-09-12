// SPDX-License-Identifier: GPL-3.0-or-later
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminClient } from "./client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("AdminClient deadlines", () => {
  it("bounds a connected helper that never replies", async () => {
    const root = mkdtempSync(join(tmpdir(), "yonder-admin-timeout-"));
    roots.push(root);
    const path = join(root, "socket");
    let accepted: Socket | undefined;
    const server = createServer((socket) => { accepted = socket; /* deliberately never reply */ });
    server.listen(path);
    await once(server, "listening");
    const client = new AdminClient(path, 100);
    const started = Date.now();
    await expect(client.status()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(1_000);
    client.close();
    accepted?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uses fixed owner errors instead of displaying helper-supplied diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "yonder-admin-owner-error-"));
    roots.push(root);
    const path = join(root, "socket");
    const secret = "submitted-password-private";
    const operationId = "00000000-0000-4000-8000-000000000099";
    let accepted: Socket | undefined;
    const server = createServer((socket) => {
      accepted = socket;
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: string };
        socket.write(`${JSON.stringify({
          id: request.id,
          ok: false,
          error: {
            code: "OWNER_OUTCOME_UNKNOWN",
            message: `native failure contained ${secret}`,
            operationId,
          },
        })}\n`);
      });
    });
    server.listen(path);
    await once(server, "listening");
    const client = new AdminClient(path, 1_000);
    let failure: unknown;
    try {
      await client.createOwner({ username: "pilot", newPassword: secret, confirmPassword: secret });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      code: "OWNER_OUTCOME_UNKNOWN",
      operationId,
      message: "Linux access outcome needs recovery; check device state before retrying",
    });
    expect((failure as Error).message).not.toContain(secret);
    client.close();
    accepted?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
