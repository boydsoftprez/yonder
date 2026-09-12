// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from "node:fs";
import { ZeroTierStateAdapter, bootstrapWithZeroTier, reconcileZeroTierBootstrap } from "../recovery/zerotier.js";
import { LinuxOwnerProjector } from "../owner-access/linux.js";
import { pathToFileURL } from "node:url";
import { DurableStateCoordinator } from "../state/coordinator.js";
import { assertManagedStateMount, loadConventionalState } from "../state/recover.js";
import { createAdminServer } from "./server.js";
import { Journal } from "../apply/journal.js";
import { MANAGED_MARKERS, managedImageTarget, observeStorageMode } from "./storage-mode.js";
import { RecoveryService } from "../recovery/service.js";
import { RecoveryImportStore } from "../recovery/import.js";
import { destinationReconciler } from "./recovery-destination.js";
import { VERSION } from "../index.js";
import { StorageService } from "./storage-service.js";

const STATE_ROOT = "/var/lib/yonder-state";
const TRANSACTIONS_ROOT = `${STATE_ROOT}/transactions`;
// This lives in the immutable image root rather than on the state mount. If
// the mount is missing, a marker inside it would disappear with it and could
// incorrectly turn a managed device into a conventional first bootstrap.
const CONFIG_PATH = "/etc/yonder/config.yaml";
const SECRETS_PATH = "/etc/yonder/secrets.yaml";
const LEGACY_APPLY_JOURNAL = "/var/lib/yonder/apply.json";

export async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("the admin helper must run as root");
  const factoryImage = managedImageTarget() !== "conventional";
  // Explicit private bench images retain their separately authorized access.
  // Release finalization removes this marker and every bench credential.
  const owner = existsSync("/etc/yonder/bench-image") ? undefined : new LinuxOwnerProjector({ enforceUnowned: factoryImage });
  const zeroTier = new ZeroTierStateAdapter();
  const legacyJournal = new Journal(LEGACY_APPLY_JOURNAL);
  const legacy = legacyJournal.read();
  let importedLegacy = false;
  const coordinator = new DurableStateCoordinator({
    root: TRANSACTIONS_ROOT,
    observeStorageMode,
    configPath: CONFIG_PATH,
    secretsPath: SECRETS_PATH,
    bootstrap: bootstrapWithZeroTier(async () => {
      if (legacy === null) {
        return loadConventionalState({ configPath: CONFIG_PATH, secretsPath: SECRETS_PATH });
      }
      importedLegacy = true;
      // Old journals never captured secrets. Restoring the known-old config
      // with the current secret set is the only honest migration; a credential
      // overwritten by an old join cannot be reconstructed.
      return loadConventionalState({
        configPath: CONFIG_PATH,
        secretsPath: SECRETS_PATH,
        rollbackConfig: legacy.previous,
      });
    }, zeroTier),
    projectors: owner ? [owner, zeroTier] : [zeroTier],
    assertStorage: () => {
      observeStorageMode();
      for (const markerPath of MANAGED_MARKERS) assertManagedStateMount({
        stateRoot: STATE_ROOT, markerPath, mountInfoPath: "/proc/self/mountinfo",
      });
    },
  });
  await coordinator.recover();
  await reconcileZeroTierBootstrap(coordinator, zeroTier);
  if (legacy !== null) {
    legacyJournal.clear();
    if (importedLegacy) {
      process.stderr.write(
        "yonder-admin: imported a legacy config-only rollback; an overwritten network credential may require AP recovery and rejoin\n",
      );
    }
  }
  const source = { version: VERSION, board: managedImageTarget(), configSchemaVersion: 1 as const };
  const imports = new RecoveryImportStore();
  const reconcile = destinationReconciler();
  createAdminServer({ coordinator, fd: 3, ownerBackend: owner,
    storageBackend: new StorageService(coordinator),
    recoveryBackend: (connectionCoordinator) => new RecoveryService({
      coordinator: connectionCoordinator, zeroTier, imports, source, currentVersion: VERSION,
      reconcileDestination: async (input) => {
        if (input.incoming.linuxOwner !== null && !owner) throw new Error("native owner projection unavailable");
        await owner?.preflightRestore(input.incoming.linuxOwner, input.destination.linuxOwner);
        return reconcile(input);
      },
    }),
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch(() => {
    // Inputs may include credentials and parser errors can quote source lines.
    // The service exposes only this fixed diagnostic and leaves details local to
    // an explicitly invoked recovery tool.
    process.stderr.write("yonder-admin: durable state initialization failed\n");
    process.exitCode = 1;
  });
}
