// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { StorageService } from "./storage-service.js";
import type { DurableStateCoordinator } from "../state/coordinator.js";
describe("privileged maintenance request", () => {
  it("binds the request to the inspected owner generation and refuses unmanaged or writable roots", async () => {
    const requestMaintenance = vi.fn(async () => ({ id: "request", generation: "generation" }));
    const coordinator = { requestMaintenance,
      readActiveState: async () => ({ generation: "generation", state: { linuxOwner: { username: "pilot" } } }) } as unknown as DurableStateCoordinator;
    await new StorageService(coordinator, () => true, () => "protected").request();
    expect(requestMaintenance).toHaveBeenCalledWith({ id: expect.any(String), expectedActiveGeneration: "generation" });
    await expect(new StorageService(coordinator, () => false).request()).rejects.toThrow("does not use");
    await expect(new StorageService(coordinator, () => true, () => "maintenance").request()).rejects.toThrow("already");
    expect(requestMaintenance).toHaveBeenCalledOnce();
  });
});
