// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { OwnerAccessRecord, StateCoordinator, StateTransaction } from "../state/types.js";
import { validateOwnerPassword, validateOwnerPublicKey, validateOwnerRecord, validateOwnerUsername } from "./model.js";

export interface PublicOwnerState {
  configured: boolean;
  username: string | null;
  sshEnabled: boolean;
  sshPasswordAuthentication: boolean;
  authorizedKeyFingerprints: string[];
}

export class OwnerAccessError extends Error {
  constructor(readonly code: "ALREADY_CONFIGURED" | "NOT_CONFIGURED" | "PASSWORD_MISMATCH" | "OUTCOME_UNKNOWN",
    readonly operationId?: string) {
    super(code === "OUTCOME_UNKNOWN" ? "Linux access outcome needs recovery; check device state before retrying"
      : code === "ALREADY_CONFIGURED" ? "A Linux owner is already configured"
        : code === "NOT_CONFIGURED" ? "Create a Linux owner first" : "The Linux passwords do not match");
    this.name = "OwnerAccessError";
  }
}

/** Trusted local backend. Called only under the root helper's shared transaction. */
export interface OwnerNativeBackend {
  preflightCreate(username: string): Promise<void>;
  hashPassword(password: string): Promise<string>;
}

export function publicOwnerState(owner: OwnerAccessRecord | null): PublicOwnerState {
  return {
    configured: owner !== null, username: owner?.username ?? null,
    sshEnabled: owner?.sshEnabled ?? false,
    sshPasswordAuthentication: owner?.sshPasswordAuthentication ?? false,
    authorizedKeyFingerprints: owner?.authorizedKeys.map(key => validateOwnerPublicKey(key).fingerprint) ?? [],
  };
}

/** Root helper service; web authentication is checked by core before its RPC. */
export class OwnerAccessService {
  constructor(private readonly coordinator: StateCoordinator, private readonly native: OwnerNativeBackend) {}

  async state(): Promise<PublicOwnerState> {
    const snapshot = await this.coordinator.readActiveState();
    return publicOwnerState(snapshot.state.linuxOwner);
  }

  async create(input: { username: unknown; newPassword: unknown; confirmPassword: unknown }): Promise<PublicOwnerState> {
    const username = validateOwnerUsername(input.username);
    const password = this.passwordPair(input);
    return this.change(async previous => {
      if (previous) throw new OwnerAccessError("ALREADY_CONFIGURED");
      await this.native.preflightCreate(username);
      return { username, passwordHash: await this.native.hashPassword(password), authorizedKeys: [],
        sshEnabled: false, sshPasswordAuthentication: false, sudo: true };
    });
  }

  async changePassword(input: { newPassword: unknown; confirmPassword: unknown }): Promise<PublicOwnerState> {
    const password = this.passwordPair(input);
    return this.change(async previous => {
      if (!previous) throw new OwnerAccessError("NOT_CONFIGURED");
      return { ...previous, passwordHash: await this.native.hashPassword(password) };
    });
  }

  async configureSsh(input: { enabled: unknown; passwordAuthentication: unknown; authorizedKeys?: unknown }): Promise<PublicOwnerState> {
    return this.change(async previous => {
      if (!previous) throw new OwnerAccessError("NOT_CONFIGURED");
      // Validate the whole record before writing; do not coerce booleans or keys.
      return validateOwnerRecord({ ...previous, sshEnabled: input.enabled,
        sshPasswordAuthentication: input.passwordAuthentication, authorizedKeys: input.authorizedKeys === undefined ? previous.authorizedKeys : input.authorizedKeys });
    });
  }

  private passwordPair(input: { newPassword: unknown; confirmPassword: unknown }): string {
    const password = validateOwnerPassword(input.newPassword);
    if (password !== input.confirmPassword) throw new OwnerAccessError("PASSWORD_MISMATCH");
    return password;
  }

  private async change(build: (previous: OwnerAccessRecord | null) => Promise<OwnerAccessRecord>): Promise<PublicOwnerState> {
    const id = randomUUID();
    const tx = await this.coordinator.begin({ id, kind: "owner-access" });
    let owner: OwnerAccessRecord;
    try {
      owner = validateOwnerRecord(await build(tx.previous.state.linuxOwner));
      await tx.stage({ ...tx.previous.state, linuxOwner: owner });
      await tx.activate();
    } catch (error) {
      await this.rollbackOrUnknown(tx);
      throw error;
    }
    try {
      await tx.commit();
    } catch {
      // A failed reply may follow the durable commit decision. Resolve the SAME
      // operation once; never rerun account creation or silently call it failed.
      try { await tx.commit(); }
      catch { throw new OwnerAccessError("OUTCOME_UNKNOWN", id); }
    }
    return publicOwnerState(owner);
  }

  private async rollbackOrUnknown(tx: StateTransaction): Promise<void> {
    try { await tx.rollback("owner-operation-failed"); }
    catch { throw new OwnerAccessError("OUTCOME_UNKNOWN", tx.id); }
  }
}
