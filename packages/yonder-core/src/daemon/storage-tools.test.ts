// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { storageToolsRoute } from "./storage-tools.js";
import type { AdminCredential } from "../console/credential.js";
import type { PublicStorageState } from "../admin/storage-service.js";
import { AttemptThrottle } from "../console/throttle.js";
const auth = { owner: "session-fixture-0123456789", currentPassword: "fixture-password", confirm: "MAINTENANCE" };
function fixture() {
  const state: PublicStorageState = { managed: true, mode: "protected", ownerConfigured: true, operation: null };
  return { state, client: { storageState: vi.fn(async () => state), requestMaintenance: vi.fn(async () => ({ id: "operation", generation: "generation" })) },
    credential: { isSet: () => true, verify: (value: string) => value === "fixture-password" } as AdminCredential,
    throttle: new AttemptThrottle(), reboot: vi.fn(async () => {}), refusal: () => null as string | null };
}
describe("storage maintenance authorization", () => {
  it("requires reauthentication and explicit confirmation before saving a request or rebooting", async () => {
    const f = fixture();
    expect((await storageToolsRoute(f, "POST", "/storage/enter", { ...auth, currentPassword: "wrong" }))?.status).toBe(401);
    expect((await storageToolsRoute(f, "POST", "/storage/enter", { ...auth, confirm: "PROTECT" }))?.status).toBe(400);
    expect((await storageToolsRoute({ ...f, refusal: () => "Disarm first" }, "POST", "/storage/enter", auth))?.status).toBe(409);
    expect(f.client.requestMaintenance).not.toHaveBeenCalled(); expect(f.reboot).not.toHaveBeenCalled();
    expect((await storageToolsRoute(f, "POST", "/storage/enter", auth))?.status).toBe(200);
    expect(f.client.requestMaintenance).toHaveBeenCalledOnce(); expect(f.reboot).toHaveBeenCalledOnce();
  });
  it("retries only reboot scheduling when a maintenance request already exists", async () => {
    const f = fixture(); f.state.operation = { id: "existing-operation", kind: "maintenance", phase: "awaiting-maintenance-reboot" };
    const result = await storageToolsRoute(f, "POST", "/storage/enter", auth);
    expect(result?.body).toMatchObject({ operationId: "existing-operation" });
    expect(f.client.requestMaintenance).not.toHaveBeenCalled(); expect(f.reboot).toHaveBeenCalledOnce();
  });
  it("leaves a persisted request identifiable if reboot scheduling fails", async () => {
    const f = fixture(); f.reboot.mockRejectedValueOnce(Error("native private error"));
    const result = await storageToolsRoute(f, "POST", "/storage/enter", auth);
    expect(result?.status).toBe(503); expect(result?.body).toMatchObject({ operationId: "operation" });
    expect(JSON.stringify(result)).not.toContain("native private error");
  });
  it("returns from maintenance using an ordinary reboot without publishing another token", async () => {
    const f = fixture(); f.state.mode = "maintenance";
    f.state.operation = { id: "operation", kind: "maintenance", phase: "entered-maintenance" };
    expect((await storageToolsRoute(f, "POST", "/storage/exit", { ...auth, confirm: "PROTECT" }))?.status).toBe(200);
    expect(f.client.requestMaintenance).not.toHaveBeenCalled(); expect(f.reboot).toHaveBeenCalledOnce();
    f.state.managed = false;
    expect((await storageToolsRoute(f, "POST", "/storage/exit", { ...auth, confirm: "PROTECT" }))?.status).toBe(409);
  });
});
