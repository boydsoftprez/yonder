// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { AdminCredential } from "../console/credential.js";
import { AttemptThrottle } from "../console/throttle.js";
import { OwnerAdminError } from "../admin/client.js";
import { ownerToolsRoute } from "./owner-tools.js";
const publicState = { configured: false, username: null, sshEnabled: false, sshPasswordAuthentication: false, authorizedKeyFingerprints: [] };
function fixture(set = true) {
  const credential = { isSet: () => set, verify: vi.fn((password: string) => password === "console-fixture-password") } as unknown as AdminCredential;
  const client = { ownerState: vi.fn(async () => publicState), createOwner: vi.fn(async () => publicState), changeOwnerPassword: vi.fn(async () => publicState), configureOwnerSsh: vi.fn(async () => publicState) };
  return { credential, client, throttle: new AttemptThrottle() };
}
const body = { owner: "session-fixture", currentPassword: "console-fixture-password", username: "pilot", newPassword: "linux-fixture-password", confirmPassword: "linux-fixture-password" };
describe("owner tools reauthentication boundary", () => {
  it("rejects unprovisioned and incorrect-password requests without reaching native operations", async () => {
    const unset = fixture(false);
    expect((await ownerToolsRoute(unset, "POST", "/owner/create", body))?.status).toBe(403);
    expect(unset.client.createOwner).not.toHaveBeenCalled();
    const f = fixture();
    for (let i = 0; i < 5; i++) expect((await ownerToolsRoute(f, "POST", "/owner/create", { ...body, currentPassword: "wrong" }))?.status).toBe(401);
    expect((await ownerToolsRoute(f, "POST", "/owner/create", body))?.status).toBe(429);
    expect(f.client.createOwner).not.toHaveBeenCalled();
    expect(f.credential.verify).toHaveBeenCalledTimes(5);
  });
  it("forwards only Linux fields and removes console passwords and session identifiers", async () => {
    const f = fixture();
    const result = await ownerToolsRoute(f, "POST", "/owner/create", body);
    expect(result?.status).toBe(200);
    expect(result?.headers?.["cache-control"]).toBe("no-store");
    expect(f.client.createOwner).toHaveBeenCalledWith({ username: "pilot", newPassword: "linux-fixture-password", confirmPassword: "linux-fixture-password" });
    expect(JSON.stringify(result)).not.toContain("password");
  });
  it("rejects extra fields and absent session identity before reauthentication", async () => {
    const f = fixture();
    for (const input of [{ ...body, shell: "/bin/sh" }, { ...body, owner: undefined }]) {
      expect((await ownerToolsRoute(f, "POST", "/owner/create", input))?.status).toBe(400);
    }
    expect(f.client.createOwner).not.toHaveBeenCalled(); expect(f.credential.verify).not.toHaveBeenCalled();
  });
  it("does not reflect arbitrary native errors", async () => {
    const f = fixture(); f.client.createOwner.mockRejectedValueOnce(Error("private-fixture"));
    expect(JSON.stringify(await ownerToolsRoute(f, "POST", "/owner/create", body))).not.toContain("private-fixture");
    f.client.createOwner.mockRejectedValueOnce(new OwnerAdminError("OWNER_DESTINATION_CONFLICT"));
    expect((await ownerToolsRoute(f, "POST", "/owner/create", body))?.status).toBe(409);
  });
});
