// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { StateCoordinator } from "../state/types.js";
import { encodeRecoveryArchive, type RecoverySource } from "./schema.js";
import type { ZeroTierStateAdapter } from "./zerotier.js";
import { refreshZeroTierState } from "./zerotier.js";

/** Snapshot and archive one authoritative generation under the shared lease. */
export async function exportRecoveryArchive(input: {
  coordinator: StateCoordinator;
  source: RecoverySource;
  zeroTier: Pick<ZeroTierStateAdapter, "capture">;
  now?: Date;
}): Promise<Buffer> {
  // Capture under the same unbounded operation guard used by every writer,
  // and durably reconcile any external root-side change before selecting the
  // immutable generation that goes into the archive.
  await refreshZeroTierState(input.coordinator, input.zeroTier);
  const lease = await input.coordinator.beginSnapshot({ id: randomUUID() });
  try {
    return encodeRecoveryArchive(lease.snapshot.state, input.source, input.now);
  } finally {
    await lease.release();
  }
}
