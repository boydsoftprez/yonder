// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { fsyncDir, unlinkDurable, writeFileDurable } from "../fs/durable.js";
import {
  DurableStateSchema,
  MAX_DURABLE_STATE_BYTES,
  StateKindSchema,
  type DurableState,
  type StateKind,
  type StateOperationPhase,
} from "./types.js";

export type CoordinatorBoundary =
  | "bootstrap.tree"
  | "bootstrap.published"
  | "operation.begin"
  | "generation.published"
  | "operation.staged"
  | "operation.activating"
  | "selection.activated"
  | "projection.config"
  | "projection.secrets"
  | `projection.${string}`
  | "operation.awaiting-confirmation"
  | "operation.committing"
  | "operation.committed"
  | "receipt.committed"
  | "receipt.runtime-handoff-acknowledged"
  | "operation.rolling-back"
  | "selection.rolled-back"
  | "receipt.rolled-back"
  | "operation.cleared";

export type BoundaryHook = (boundary: CoordinatorBoundary) => void;

export interface OperationRecord {
  schemaVersion: 1;
  id: string;
  kind: StateKind;
  phase: StateOperationPhase;
  previousGeneration: string;
  nextGeneration?: string;
  decision?: "commit";
  maintenance?: { schemaVersion: 1; mode: "writable-next-boot" };
  runtimeHandoff?: { schemaVersion: 1; initiatingRuntimeGeneration: string };
  startedAt: number;
}

export interface OperationReceipt {
  id: string;
  kind: StateKind;
  outcome: "committed" | "rolled-back";
  generation: string;
  previousGeneration: string;
  reasonCode?: string;
  runtimeHandoff?: {
    schemaVersion: 1;
    initiatingRuntimeGeneration: string;
    acknowledgedRuntimeGeneration?: string;
  };
  completedAt: number;
}

const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_RE = GENERATION_RE;
const ROOT_MARKER = { schemaVersion: 1, kind: "yonder-durable-state" } as const;
const MAX_RECEIPTS = 64;
const MAX_ABANDONED = 16;
const MAX_OPERATION_BYTES = 512;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ownedByProcess(info: { uid: number; gid: number }): boolean {
  return info.uid === (process.geteuid?.() ?? info.uid) && info.gid === (process.getegid?.() ?? info.gid);
}

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("yonder-state-generation"),
  generation: z.string().regex(GENERATION_RE),
  stateBytes: z.number().int().positive().max(MAX_DURABLE_STATE_BYTES),
  stateSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const ActiveSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.string().regex(GENERATION_RE),
}).strict();

const MutationOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(OPERATION_RE),
  kind: StateKindSchema.exclude(["maintenance"]),
  phase: z.enum(["staging", "activating", "awaiting-confirmation", "committing", "rolling-back", "recovering"]),
  previousGeneration: z.string().regex(GENERATION_RE),
  nextGeneration: z.string().regex(GENERATION_RE).optional(),
  decision: z.literal("commit").optional(),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const RestartHandoffOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(OPERATION_RE),
  kind: z.literal("restore"),
  phase: z.literal("committed-awaiting-runtime-handoff"),
  previousGeneration: z.string().regex(GENERATION_RE),
  nextGeneration: z.string().regex(GENERATION_RE),
  decision: z.literal("commit"),
  runtimeHandoff: z.object({
    schemaVersion: z.literal(1),
    initiatingRuntimeGeneration: z.string().regex(OPERATION_RE),
  }).strict(),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const MaintenanceOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(OPERATION_RE),
  kind: z.literal("maintenance"),
  phase: z.enum(["awaiting-maintenance-reboot", "entered-maintenance"]),
  previousGeneration: z.string().regex(GENERATION_RE),
  maintenance: z.object({ schemaVersion: z.literal(1), mode: z.literal("writable-next-boot") }).strict(),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const OperationSchema = z.union([
  MutationOperationSchema,
  RestartHandoffOperationSchema,
  MaintenanceOperationSchema,
]) as z.ZodType<OperationRecord>;

const ReceiptSchema = z.object({
  id: z.string().regex(OPERATION_RE),
  kind: StateKindSchema,
  outcome: z.enum(["committed", "rolled-back"]),
  generation: z.string().regex(GENERATION_RE),
  previousGeneration: z.string().regex(GENERATION_RE),
  reasonCode: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
  runtimeHandoff: z.object({
    schemaVersion: z.literal(1),
    initiatingRuntimeGeneration: z.string().regex(OPERATION_RE),
    acknowledgedRuntimeGeneration: z.string().regex(OPERATION_RE).optional(),
  }).strict().optional(),
  completedAt: z.number().finite(),
}).strict().superRefine((receipt, context) => {
  if (!receipt.runtimeHandoff) return;
  if (receipt.kind !== "restore" || receipt.outcome !== "committed" || receipt.reasonCode !== undefined
    || receipt.runtimeHandoff.acknowledgedRuntimeGeneration
      === receipt.runtimeHandoff.initiatingRuntimeGeneration) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid runtime handoff receipt" });
  }
}) as z.ZodType<OperationReceipt>;

const ReceiptsSchema = z.object({
  schemaVersion: z.literal(1),
  receipts: z.array(ReceiptSchema).max(MAX_RECEIPTS),
}).strict();

export class StateDiskError extends Error {
  constructor(readonly code: "STATE_UNAVAILABLE" | "STATE_TOO_LARGE", message: string) {
    super(message);
    this.name = "StateDiskError";
  }
}

function unavailable(): StateDiskError {
  return new StateDiskError(
    "STATE_UNAVAILABLE",
    "durable state is unavailable; use recovery diagnostics or reflash this device",
  );
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function safeJson(path: string, maximum = MAX_DURABLE_STATE_BYTES): unknown {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || !ownedByProcess(info) || (info.mode & 0o777) !== PRIVATE_FILE_MODE
      || info.size > maximum) {
      throw unavailable();
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof StateDiskError) throw error;
    throw unavailable();
  }
}

function durableJson(path: string, value: unknown): void {
  writeFileDurable(path, `${JSON.stringify(value)}\n`, 0o600);
}

function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(info)
    || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw unavailable();
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  fsyncDir(dirname(path));
}

function serializedState(input: DurableState): { state: DurableState; bytes: Buffer } {
  let unvalidated: Buffer;
  try {
    unvalidated = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
  } catch {
    throw new StateDiskError("STATE_UNAVAILABLE", "durable state is not valid");
  }
  if (unvalidated.byteLength > MAX_DURABLE_STATE_BYTES) {
    throw new StateDiskError("STATE_TOO_LARGE", "durable state exceeds the 4 MiB limit");
  }
  const parsed = DurableStateSchema.safeParse(input);
  if (!parsed.success) throw new StateDiskError("STATE_UNAVAILABLE", "durable state is not valid");
  const bytes = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
  if (bytes.byteLength > MAX_DURABLE_STATE_BYTES) {
    throw new StateDiskError("STATE_TOO_LARGE", "durable state exceeds the 4 MiB limit");
  }
  return { state: parsed.data, bytes };
}

export class StateJournal {
  readonly root: string;
  private readonly hook: BoundaryHook;

  constructor(root: string, hook: BoundaryHook = () => {}) {
    this.root = root;
    this.hook = hook;
  }

  boundary(name: CoordinatorBoundary): void {
    this.hook(name);
  }

  needsInitialization(): boolean {
    try {
      if (!existsSync(this.root)) return true;
      const info = lstatSync(this.root);
      if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(info)) throw unavailable();
      if (readdirSync(this.root).length === 0) return true;
      this.assertOwnedRoot();
      return false;
    } catch (error) {
      if (error instanceof StateDiskError) throw error;
      throw unavailable();
    }
  }

  ensureInitialized(initial: DurableState): { generation: string; created: boolean } {
    const parent = dirname(this.root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.cleanupAbandonedBootstraps(parent);
    if (existsSync(this.root)) {
      const rootInfo = lstatSync(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !ownedByProcess(rootInfo)) throw unavailable();
      const entries = readdirSync(this.root);
      if (entries.length === 0) {
        chmodSync(this.root, PRIVATE_DIRECTORY_MODE);
        rmdirSync(this.root);
        fsyncDir(parent);
      } else {
        this.assertOwnedRoot();
        return { generation: this.readActiveGeneration(), created: false };
      }
    }

    const generation = randomUUID();
    const prefix = `.${basename(this.root)}-bootstrap-`;
    const temporary = join(parent, `${prefix}${randomUUID()}`);
    createPrivateDirectory(temporary);
    const generations = join(temporary, "generations");
    createPrivateDirectory(generations);
    this.writeGenerationAt(generations, generation, initial);
    durableJson(join(temporary, "ownership.json"), ROOT_MARKER);
    durableJson(join(temporary, "active.json"), { schemaVersion: 1, generation });
    durableJson(join(temporary, "receipts.json"), { schemaVersion: 1, receipts: [] });
    fsyncDir(temporary);
    this.boundary("bootstrap.tree");
    renameSync(temporary, this.root);
    fsyncDir(parent);
    this.boundary("bootstrap.published");
    return { generation, created: true };
  }

  assertOwnedRoot(): void {
    try {
      assertPrivateDirectory(this.root);
      const marker = safeJson(join(this.root, "ownership.json"));
      if (JSON.stringify(marker) !== JSON.stringify(ROOT_MARKER)) throw unavailable();
      assertPrivateDirectory(this.generationsPath());
      ReceiptsSchema.parse(safeJson(join(this.root, "receipts.json")));
    } catch (error) {
      if (error instanceof StateDiskError) throw error;
      throw unavailable();
    }
  }

  newGeneration(state: DurableState): string {
    this.assertOwnedRoot();
    const generation = randomUUID();
    this.writeGenerationAt(this.generationsPath(), generation, state);
    this.boundary("generation.published");
    return generation;
  }

  readGeneration(generation: string): DurableState {
    if (!GENERATION_RE.test(generation)) throw unavailable();
    const directory = join(this.generationsPath(), generation);
    try {
      assertPrivateDirectory(directory);
      const statePath = join(directory, "state.json");
      const manifest = ManifestSchema.parse(safeJson(join(directory, "manifest.json")));
      if (manifest.generation !== generation) throw unavailable();
      const info = lstatSync(statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || !ownedByProcess(info) || (info.mode & 0o777) !== PRIVATE_FILE_MODE
        || info.size !== manifest.stateBytes || info.size > MAX_DURABLE_STATE_BYTES) {
        throw unavailable();
      }
      const bytes = readFileSync(statePath);
      const wanted = Buffer.from(manifest.stateSha256, "hex");
      const actual = sha256(bytes);
      if (wanted.length !== actual.length || !timingSafeEqual(wanted, actual)) throw unavailable();
      const parsed = DurableStateSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success) throw unavailable();
      return parsed.data;
    } catch (error) {
      if (error instanceof StateDiskError) throw error;
      throw unavailable();
    }
  }

  readActiveGeneration(): string {
    this.assertOwnedRoot();
    try {
      const active = ActiveSchema.parse(safeJson(join(this.root, "active.json")));
      this.readGeneration(active.generation);
      return active.generation;
    } catch (error) {
      if (error instanceof StateDiskError) throw error;
      throw unavailable();
    }
  }

  writeActiveGeneration(generation: string): void {
    this.readGeneration(generation);
    durableJson(join(this.root, "active.json"), { schemaVersion: 1, generation });
  }

  readOperation(): OperationRecord | null {
    const path = join(this.root, "operation.json");
    if (!existsSync(path)) return null;
    try {
      return OperationSchema.parse(safeJson(path, MAX_OPERATION_BYTES));
    } catch {
      throw unavailable();
    }
  }

  writeOperation(record: OperationRecord): void {
    const parsed = OperationSchema.safeParse(record);
    if (!parsed.success) throw unavailable();
    if (Buffer.byteLength(`${JSON.stringify(parsed.data)}\n`) > MAX_OPERATION_BYTES) throw unavailable();
    durableJson(join(this.root, "operation.json"), parsed.data);
  }

  clearOperation(): void {
    unlinkDurable(join(this.root, "operation.json"));
    // A retry after unlink succeeded but unlinkDurable's directory fsync
    // failed observes ENOENT. Flush again so that retry can still establish a
    // durable absence before the coordinator reports completion.
    fsyncDir(this.root);
  }

  readReceipt(id: string): OperationReceipt | null {
    if (!OPERATION_RE.test(id)) return null;
    return this.readReceipts().find((receipt) => receipt.id === id) ?? null;
  }

  writeReceipt(receipt: OperationReceipt): void {
    const parsed = ReceiptSchema.safeParse(receipt);
    if (!parsed.success) throw unavailable();
    const without = this.readReceipts().filter(({ id }) => id !== receipt.id);
    const receipts = [...without, parsed.data].slice(-MAX_RECEIPTS);
    durableJson(join(this.root, "receipts.json"), { schemaVersion: 1, receipts });
  }

  cleanupGenerations(keep: ReadonlySet<string>): void {
    const directory = this.generationsPath();
    let changed = false;
    let abandonedCount = 0;
    const entries = readdirSync(directory);
    if (entries.length > 128) throw unavailable();
    for (const name of entries) {
      const path = join(directory, name);
      if (name.startsWith(".generation-") && name.endsWith(".tmp")) {
        abandonedCount += 1;
        if (abandonedCount > MAX_ABANDONED) throw unavailable();
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(info)) throw unavailable();
        rmSync(path, { recursive: true, force: true });
        changed = true;
      } else if (GENERATION_RE.test(name) && !keep.has(name)) {
        assertPrivateDirectory(path);
        rmSync(path, { recursive: true, force: true });
        changed = true;
      } else if (!GENERATION_RE.test(name)) {
        throw unavailable();
      }
    }
    if (changed) fsyncDir(directory);
  }

  private generationsPath(): string {
    return join(this.root, "generations");
  }

  private writeGenerationAt(generations: string, generation: string, input: DurableState): void {
    const { bytes } = serializedState(input);
    const temporary = join(generations, `.generation-${generation}.tmp`);
    const destination = join(generations, generation);
    createPrivateDirectory(temporary);
    writeFileDurable(join(temporary, "state.json"), bytes.toString("utf8"), 0o600);
    durableJson(join(temporary, "manifest.json"), {
      schemaVersion: 1,
      kind: "yonder-state-generation",
      generation,
      stateBytes: bytes.byteLength,
      stateSha256: sha256(bytes).toString("hex"),
    });
    fsyncDir(temporary);
    renameSync(temporary, destination);
    fsyncDir(generations);
  }

  private readReceipts(): OperationReceipt[] {
    try {
      return ReceiptsSchema.parse(safeJson(join(this.root, "receipts.json"))).receipts;
    } catch (error) {
      if (error instanceof StateDiskError) throw error;
      throw unavailable();
    }
  }

  private cleanupAbandonedBootstraps(parent: string): void {
    const prefix = `.${basename(this.root)}-bootstrap-`;
    const abandoned = readdirSync(parent).filter((name) => name.startsWith(prefix));
    if (abandoned.length > MAX_ABANDONED) throw unavailable();
    for (const name of abandoned) {
      const path = join(parent, name);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !ownedByProcess(info)
        || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw unavailable();
      rmSync(path, { recursive: true, force: true });
    }
    if (abandoned.length > 0) fsyncDir(parent);
  }
}
