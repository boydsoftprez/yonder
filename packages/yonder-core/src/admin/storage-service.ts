// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { DurableStateCoordinator, StateCoordinatorError } from "../state/coordinator.js";
import { managedImageTarget, observeStorageMode } from "./storage-mode.js";

export interface PublicStorageState {
  managed: boolean;
  mode: "protected" | "maintenance" | "writable";
  ownerConfigured: boolean;
  operation: null | { id: string; kind: string; phase: string };
}
export class StorageService {
  constructor(private readonly coordinator: DurableStateCoordinator,
    private readonly managed = () => managedImageTarget() !== "conventional",
    private readonly observe = observeStorageMode) {}
  async status(): Promise<PublicStorageState> {
    const managed = this.managed();
    const status = await this.coordinator.status();
    const active = await this.coordinator.readActiveState();
    return { managed, mode: managed ? this.observe() : "writable",
      ownerConfigured: active.state.linuxOwner !== null, operation: status.operation };
  }
  async request(): Promise<{ id: string; generation: string }> {
    if (!this.managed()) throw new StateCoordinatorError("INVALID_OPERATION", "This installation does not use managed protected storage");
    if (this.observe() !== "protected") throw new StateCoordinatorError("STATE_BUSY", "The device is already in writable maintenance");
    const active = await this.coordinator.readActiveState();
    if (active.state.linuxOwner === null) throw new StateCoordinatorError("INVALID_OPERATION", "Create a Linux owner before entering maintenance");
    return this.coordinator.requestMaintenance({ id: randomUUID(), expectedActiveGeneration: active.generation });
  }
}
