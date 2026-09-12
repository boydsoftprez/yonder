// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { ConfigSchema, type Config } from "../schema/config.js";

export const MAX_DURABLE_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_STANDARD_CONTROL_BYTES = 64 * 1024;

export const StateKindSchema = z.enum([
  "bootstrap",
  "config-apply",
  "owner-access",
  "restore",
  "maintenance",
]);
export type StateKind = z.infer<typeof StateKindSchema>;

// A future protected-root maintenance transition uses this same operation
// guard and journal. Its one-shot reboot flag is an explicit, versioned field
// on that operation's journal record; selecting a config/secret generation
// cannot make a boot-mode flag durable, and the flag must not be invented as
// application state here.

export type SecretPatch = Readonly<Record<string, string | null>>;

export const OwnerAccessRecordSchema = z.object({
  username: z.string().min(1).max(64),
  passwordHash: z.string().min(1).max(4096),
  authorizedKeys: z.array(z.string().min(1).max(16 * 1024)).max(64),
  sshEnabled: z.boolean(),
  sshPasswordAuthentication: z.boolean(),
  sudo: z.literal(true),
}).strict();

export interface OwnerAccessRecord {
  username: string;
  passwordHash: string;
  authorizedKeys: string[];
  sshEnabled: boolean;
  sshPasswordAuthentication: boolean;
  sudo: true;
}

export const ZeroTierStateSchema = z.object({
  identitySecret: z.string().min(1).max(64 * 1024),
  identityPublic: z.string().min(1).max(64 * 1024),
  memberships: z.array(z.object({ networkId: z.string().regex(/^[0-9a-f]{16}$/) }).strict()).max(64),
}).strict();

export interface DurableState {
  config: Config;
  secrets: Readonly<Record<string, string>>;
  linuxOwner: OwnerAccessRecord | null;
  zeroTier: null | {
    identitySecret: string;
    identityPublic: string;
    memberships: { networkId: string }[];
  };
}

export const DurableStateSchema: z.ZodType<DurableState, z.ZodTypeDef, unknown> = z.object({
  config: ConfigSchema,
  secrets: z.record(z.string().max(256), z.string().max(256 * 1024)),
  linuxOwner: OwnerAccessRecordSchema.nullable(),
  zeroTier: ZeroTierStateSchema.nullable(),
}).strict();

export interface StateSnapshot {
  generation: string;
  state: DurableState;
}

export type ProjectedStateSection = "linuxOwner" | "zeroTier";
export type StateProjectionContext = "activation" | "rollback" | "recovery";

/** Trusted implementation registered when the root helper starts. */
export interface StateProjector {
  readonly name: string;
  readonly sections: readonly ProjectedStateSection[];
  apply(input: {
    operationId: string;
    previous: DurableState;
    next: DurableState;
    context: StateProjectionContext;
  }): Promise<void>;
  verify(input: {
    operationId: string;
    expected: DurableState;
  }): Promise<void>;
}

export type StateOperationPhase =
  | "staging"
  | "activating"
  | "awaiting-confirmation"
  | "committing"
  | "rolling-back"
  | "recovering"
  | "awaiting-maintenance-reboot"
  | "entered-maintenance"
  | "committed-awaiting-runtime-handoff";

export interface StateTransaction {
  id: string;
  previous: StateSnapshot;
  stage(next: DurableState): Promise<{ generation: string }>;
  activate(): Promise<{ generation: string }>;
  holdForConfirmation(): Promise<void>;
  commit(): Promise<{ generation: string }>;
  commitForRestart(currentRuntimeGeneration: string): Promise<{ generation: string }>;
  rollback(reasonCode: string): Promise<{ generation: string }>;
}

export interface StateCoordinator {
  status(): Promise<{
    activeGeneration: string;
    operation: null | { id: string; kind: StateKind; phase: StateOperationPhase };
  }>;
  /** Detached active state for startup reconciliation; does not reserve the writer lock. */
  readActiveState(): Promise<StateSnapshot>;
  acknowledgeRuntimeHandoff(input: {
    operationId: string;
    generation: string;
    runtimeGeneration: string;
  }): Promise<{ generation: string }>;
  begin(input: {
    id: string;
    kind: StateKind;
    expectedActiveGeneration?: string;
  }): Promise<StateTransaction>;
  beginSnapshot(input: { id: string }): Promise<{
    snapshot: StateSnapshot;
    release(): Promise<void>;
  }>;
  recover(): Promise<{
    selectedGeneration: string;
    action: "none" | "discarded-staged" | "rolled-back" | "kept-committed";
  }>;
}
