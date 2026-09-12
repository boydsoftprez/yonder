// SPDX-License-Identifier: GPL-3.0-or-later
import type { StateCoordinator } from "../state/types.js";

/** Called only after this process has rendered the selected durable generation. */
export async function finishRecoveryHandoff(input: {
  coordinator: StateCoordinator;
  runtimeGeneration: string;
  resetSessions: () => Promise<void>;
}): Promise<boolean> {
  const status = await input.coordinator.status();
  if (status.operation?.phase !== "committed-awaiting-runtime-handoff") return false;
  await input.resetSessions();
  await input.coordinator.acknowledgeRuntimeHandoff({ operationId: status.operation.id,
    generation: status.activeGeneration, runtimeGeneration: input.runtimeGeneration });
  return true;
}
