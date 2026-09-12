// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { AdminCredential } from "../console/credential.js";
import { AttemptThrottle } from "../console/throttle.js";
import { recoveryToolsRoute } from "./recovery-tools.js";
const owner = "session-fixture-0123456789";
const restoreId = "32b8db9a-c493-4d50-b12b-e34b18189eaf";
const generation = "2549c257-44d9-48a4-88b0-deb81af24d42";
function fixture() {
  const client = { exportRecovery: vi.fn(async () => Buffer.from("private-archive-fixture")),
    previewRecovery: vi.fn(async () => ({ restoreId, destinationGeneration: generation, expiresAt: 1, remainingMs: 600_000,
      summary: { replacesLinuxOwner: true, replacesDeviceCredentials: true, replacesMeshIdentity: false,
        membershipCount: 0, networkInterruption: true, warnings: [], excluded: [] } })),
    commitRecovery: vi.fn(async () => ({ operationId: restoreId, generation })), cancelRecovery: vi.fn(async () => {}) };
  return { client, credential: { isSet: () => true, verify: (password: string) => password === "fixture-password" } as AdminCredential,
    runtimeGeneration: "fe0f1276-5d34-48f0-8158-3986cbdf60f2",
    throttle: new AttemptThrottle(), afterRestore: vi.fn(async () => {}) };
}
const auth = { owner, currentPassword: "fixture-password" };
describe("recovery public boundary", () => {
  it("requires fresh reauthentication to export secrets and never reflects them in errors", async () => {
    const f = fixture();
    expect((await recoveryToolsRoute(f, "POST", "/recovery/export", { ...auth, currentPassword: "wrong" }))?.status).toBe(401);
    expect(f.client.exportRecovery).not.toHaveBeenCalled();
    const result = await recoveryToolsRoute(f, "POST", "/recovery/export", auth);
    expect(result?.status).toBe(200); expect(result?.headers?.["cache-control"]).toBe("no-store");
    expect(Buffer.from((result?.body as { archiveBase64: string }).archiveBase64, "base64").toString()).toBe("private-archive-fixture");
    f.client.exportRecovery.mockRejectedValueOnce(Error("private-archive-fixture"));
    expect(JSON.stringify(await recoveryToolsRoute(f, "POST", "/recovery/export", auth))).not.toContain("private-archive-fixture");
  });
  it("binds previews to the authenticated session without forwarding passwords", async () => {
    const f = fixture(), bytes = Buffer.from("archive-fixture");
    const result = await recoveryToolsRoute(f, "POST", "/recovery/preview", { ...auth, archiveBase64: bytes.toString("base64") });
    expect(result?.status).toBe(200);
    expect(f.client.previewRecovery).toHaveBeenCalledWith({ bytes, sessionId: owner });
    expect((await recoveryToolsRoute(f, "POST", "/recovery/preview", { ...auth, archiveBase64: "not base64" }))?.status).not.toBe(200);
    expect(f.client.previewRecovery).toHaveBeenCalledTimes(1);
  });
  it("requires confirmation and runtime activation before a restore succeeds", async () => {
    const f = fixture(), input = { ...auth, restoreId, destinationGeneration: generation, confirm: true };
    expect((await recoveryToolsRoute(f, "POST", "/recovery/commit", { ...input, confirm: false }))?.status).toBe(400);
    expect((await recoveryToolsRoute({ ...f, afterRestore: undefined }, "POST", "/recovery/commit", input))?.status).toBe(503);
    expect(f.client.commitRecovery).not.toHaveBeenCalled();
    const result = await recoveryToolsRoute(f, "POST", "/recovery/commit", input);
    expect(result?.status).toBe(200); expect(f.afterRestore).toHaveBeenCalledWith({ operationId: restoreId, generation });
    f.afterRestore.mockRejectedValueOnce(Error("native-private"));
    const failed = await recoveryToolsRoute(f, "POST", "/recovery/commit", input);
    expect(failed?.status).toBe(503); expect(failed?.body).toMatchObject({ operationId: restoreId, code: "RESTORE_OUTCOME_UNKNOWN" });
    expect(JSON.stringify(failed)).not.toContain("native-private");
  });
  it("cancels only the session's preview and rejects arbitrary fields", async () => {
    const f = fixture();
    expect((await recoveryToolsRoute(f, "POST", "/recovery/cancel", { owner, restoreId }))?.status).toBe(200);
    expect(f.client.cancelRecovery).toHaveBeenCalledWith({ restoreId, sessionId: owner });
    expect((await recoveryToolsRoute(f, "POST", "/recovery/export", { ...auth, path: "/etc/shadow" }))?.status).toBe(400);
    expect(f.client.exportRecovery).not.toHaveBeenCalled();
  });
});
