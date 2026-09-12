// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { StateCoordinator } from "../state/types.js";
import { finishRecoveryHandoff } from "./recovery-runtime.js";
describe("restored runtime handoff", () => {
  it("revokes sessions before acknowledging the exact loaded generation", async () => {
    const calls: string[] = [];
    const acknowledge = vi.fn(async () => { calls.push("ack"); return { generation: "generation" }; });
    const coordinator = { status: async () => ({ activeGeneration: "generation", operation: { id: "operation", kind: "restore", phase: "committed-awaiting-runtime-handoff" } }),
      acknowledgeRuntimeHandoff: acknowledge } as unknown as StateCoordinator;
    expect(await finishRecoveryHandoff({ coordinator, runtimeGeneration: "new-runtime",
      resetSessions: async () => { calls.push("revoke"); } })).toBe(true);
    expect(calls).toEqual(["revoke", "ack"]);
    expect(acknowledge).toHaveBeenCalledWith({ operationId: "operation", generation: "generation", runtimeGeneration: "new-runtime" });
    acknowledge.mockClear();
    await expect(finishRecoveryHandoff({ coordinator, runtimeGeneration: "new-runtime", resetSessions: async () => { throw Error("unavailable"); } })).rejects.toThrow();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("does not reset sessions or release a maintenance operation", async () => {
    const coordinator = { status: async () => ({ activeGeneration: "generation", operation: { kind: "maintenance", phase: "entered-maintenance" } }) } as unknown as StateCoordinator;
    const resetSessions = vi.fn(async () => {});
    expect(await finishRecoveryHandoff({ coordinator, runtimeGeneration: "new-runtime", resetSessions })).toBe(false);
    expect(resetSessions).not.toHaveBeenCalled();
  });
});
