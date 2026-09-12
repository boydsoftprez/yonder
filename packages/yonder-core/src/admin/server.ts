// SPDX-License-Identifier: GPL-3.0-or-later
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  AdminProtocolError,
  decodeAdminRequest,
  encodeAdminMessage,
  MAX_ADMIN_FRAME_BYTES,
  OWNER_ADMIN_ERROR_MESSAGES,
  RECOVERY_ADMIN_ERROR_MESSAGES,
  decodeRecoveryBase64,
  type AdminReply,
  type AdminRequest,
  type OwnerAdminErrorCode,
  type RecoveryAdminErrorCode,
} from "./protocol.js";
import { DurableStateCoordinator, StateCoordinatorError } from "../state/coordinator.js";
import type { StateCoordinator, StateSnapshot, StateTransaction } from "../state/types.js";
import { OwnerValidationError } from "../owner-access/model.js";
import { LinuxOwnerError } from "../owner-access/linux.js";
import { OwnerAccessError, OwnerAccessService, type OwnerNativeBackend } from "../owner-access/service.js";
import { RecoveryArchiveError } from "../recovery/schema.js";
import { RecoveryImportError, type RestorePreview } from "../recovery/import.js";
import type { RecoveryService } from "../recovery/service.js";
import { ZeroTierRecoveryError } from "../recovery/zerotier.js";

export type RecoveryBackend = Pick<RecoveryService, "export" | "preview" | "commit" | "cancel">;
export type RecoveryBackendFactory = (coordinator: StateCoordinator) => RecoveryBackend;

export interface AdminServerOptions {
  storageBackend?: Pick<import("./storage-service.js").StorageService, "status" | "request">;
  coordinator: DurableStateCoordinator;
  socketPath?: string;
  fd?: number;
  /** Trusted native account backend. Owner RPCs fail closed when absent. */
  ownerBackend?: OwnerNativeBackend;
  /** Trusted recovery service factory. Recovery RPCs fail closed when absent. */
  recoveryBackend?: RecoveryBackendFactory;
}

interface ConnectionState {
  buffer: string;
  transaction?: StateTransaction;
  snapshot?: { id: string; release(): Promise<void> };
  chain: Promise<void>;
  closing: boolean;
  queued: number;
}

const MAX_QUEUED_REQUESTS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class OwnerUnavailableError extends Error {
  readonly code = "OWNER_UNAVAILABLE" as const;
  constructor() { super(OWNER_ADMIN_ERROR_MESSAGES.OWNER_UNAVAILABLE); }
}

class RecoveryUnavailableError extends Error {
  readonly code = "RECOVERY_UNAVAILABLE" as const;
  constructor() { super(RECOVERY_ADMIN_ERROR_MESSAGES.RECOVERY_UNAVAILABLE); }
}

function ownsTransaction(state: ConnectionState, id: string): StateTransaction {
  if (!state.transaction || state.transaction.id !== id) {
    throw new StateCoordinatorError("OPERATION_UNKNOWN", "this connection does not own the state operation");
  }
  return state.transaction;
}

function safeFailure(id: string, error: unknown): AdminReply {
  let ownerCode: OwnerAdminErrorCode | undefined;
  let operationId: string | undefined;
  if (error instanceof OwnerUnavailableError) ownerCode = error.code;
  else if (error instanceof OwnerAccessError) {
    ownerCode = `OWNER_${error.code}` as OwnerAdminErrorCode;
    if (error.operationId && UUID.test(error.operationId)) operationId = error.operationId;
  } else if (error instanceof OwnerValidationError) {
    ownerCode = `OWNER_INVALID_${error.code}` as OwnerAdminErrorCode;
  } else if (error instanceof LinuxOwnerError) {
    ownerCode = `OWNER_${error.code}` as OwnerAdminErrorCode;
  }
  if (ownerCode && ownerCode in OWNER_ADMIN_ERROR_MESSAGES) {
    return {
      id,
      ok: false,
      error: {
        code: ownerCode,
        message: OWNER_ADMIN_ERROR_MESSAGES[ownerCode],
        ...(operationId ? { operationId } : {}),
      },
    };
  }
  let recoveryCode: RecoveryAdminErrorCode | undefined;
  if (error instanceof RecoveryUnavailableError) recoveryCode = error.code;
  else if (error instanceof RecoveryImportError) recoveryCode = error.code;
  else if (error instanceof RecoveryArchiveError) recoveryCode = error.code;
  else if (error instanceof ZeroTierRecoveryError) recoveryCode = error.code;
  if (recoveryCode && recoveryCode in RECOVERY_ADMIN_ERROR_MESSAGES) {
    const operationId = error instanceof RecoveryImportError && error.operationId && UUID.test(error.operationId)
      ? error.operationId : undefined;
    return { id, ok: false, error: { code: recoveryCode,
      message: RECOVERY_ADMIN_ERROR_MESSAGES[recoveryCode], ...(operationId ? { operationId } : {}) } };
  }
  if (error instanceof StateCoordinatorError || error instanceof AdminProtocolError) {
    return { id, ok: false, error: { code: error.code, message: error.message } };
  }
  return { id, ok: false, error: { code: "INTERNAL", message: "admin operation failed" } };
}

function connectionUnavailable(): StateCoordinatorError {
  return new StateCoordinatorError("STATE_UNAVAILABLE", "admin helper connection closed");
}

/**
 * Give one owner service only this connection's transaction authority. The
 * transaction is registered immediately after begin, before native account
 * checks or password hashing can yield, so close recovery always owns it.
 */
function boundCoordinator(state: ConnectionState, coordinator: DurableStateCoordinator): StateCoordinator {
  const requireLive = (id?: string): void => {
    if (state.closing) throw connectionUnavailable();
    if (id !== undefined && state.transaction?.id !== id) {
      throw new StateCoordinatorError("OPERATION_UNKNOWN", "this connection does not own the state operation");
    }
  };
  return {
    status: () => coordinator.status(),
    readActiveState: () => { requireLive(); return coordinator.readActiveState(); },
    acknowledgeRuntimeHandoff: (input) => {
      requireLive();
      return coordinator.acknowledgeRuntimeHandoff(input);
    },
    recover: () => coordinator.recover(),
    async begin(input) {
      requireLive();
      const transaction = await coordinator.begin(input);
      state.transaction = transaction;
      requireLive(transaction.id);
      const terminal = async <T>(operation: () => Promise<T>): Promise<T> => {
        const result = await operation();
        if (state.transaction?.id === transaction.id) state.transaction = undefined;
        return result;
      };
      return {
        id: transaction.id,
        previous: transaction.previous,
        async stage(next) {
          requireLive(transaction.id);
          const result = await transaction.stage(next);
          requireLive(transaction.id);
          return result;
        },
        async activate() {
          requireLive(transaction.id);
          const result = await transaction.activate();
          requireLive(transaction.id);
          return result;
        },
        async holdForConfirmation() {
          requireLive(transaction.id);
          await transaction.holdForConfirmation();
          requireLive(transaction.id);
        },
        commit: () => {
          requireLive(transaction.id);
          return terminal(() => transaction.commit());
        },
        commitForRestart: (runtimeGeneration) => {
          requireLive(transaction.id);
          // The authoritative operation intentionally remains registered and
          // busy until a different core runtime acknowledges the generation.
          return transaction.commitForRestart(runtimeGeneration);
        },
        // Rollback remains available after close so OwnerAccessService can
        // immediately undo a transaction interrupted during native work.
        rollback: (reasonCode) => terminal(() => transaction.rollback(reasonCode)),
      };
    },
    async beginSnapshot(input) {
      requireLive();
      const lease = await coordinator.beginSnapshot(input);
      state.snapshot = { id: input.id, release: lease.release };
      requireLive();
      let released = false;
      return {
        snapshot: lease.snapshot,
        release: async () => {
          if (released) return;
          released = true;
          await lease.release();
          if (state.snapshot?.id === input.id) state.snapshot = undefined;
        },
      };
    },
  };
}

async function ownerCall<T>(
  state: ConnectionState,
  coordinator: DurableStateCoordinator,
  operation: () => Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof OwnerAccessError && error.code === "OUTCOME_UNKNOWN") {
      // The journal's commit decision is authoritative. Finish its idempotent
      // housekeeping now so an uncertain reply never leaves the device busy.
      await recoverConnection(state, coordinator);
    }
    throw error;
  }
}

async function dispatch(
  request: AdminRequest,
  state: ConnectionState,
  coordinator: DurableStateCoordinator,
  owner: OwnerAccessService | undefined,
  recovery: RecoveryBackend | undefined,
  storage: AdminServerOptions["storageBackend"],
): Promise<unknown> {
  const params = request.params as any;
  switch (request.method) {
    case "storage.status":
      if (!storage) throw new StateCoordinatorError("STATE_UNAVAILABLE", "Storage management is unavailable");
      return storage.status();
    case "storage.maintenance.request":
      if (!storage) throw new StateCoordinatorError("STATE_UNAVAILABLE", "Storage management is unavailable");
      return storage.request();
    case "state.status": return coordinator.status();
    case "state.active": return coordinator.readActiveState();
    case "state.begin": {
      const transaction = await coordinator.begin(params);
      state.transaction = transaction;
      return { id: transaction.id, previous: transaction.previous };
    }
    case "state.stage": return ownsTransaction(state, params.id).stage(params.state);
    case "state.activate": return ownsTransaction(state, params.id).activate();
    case "state.hold": await ownsTransaction(state, params.id).holdForConfirmation(); return {};
    case "state.commit": {
      const transaction = state.transaction;
      const result = transaction && transaction.id === params.id
        ? await transaction.commit()
        : await coordinator.resolveOperation(params.id, "committed");
      if (state.transaction?.id === params.id) state.transaction = undefined;
      return result;
    }
    case "state.commit.restart": {
      return ownsTransaction(state, params.id).commitForRestart(params.runtimeGeneration);
    }
    case "state.rollback": {
      const transaction = state.transaction;
      const result = transaction && transaction.id === params.id
        ? await transaction.rollback(params.reasonCode)
        : await coordinator.resolveOperation(params.id, "rolled-back");
      if (state.transaction?.id === params.id) state.transaction = undefined;
      return result;
    }
    case "state.snapshot.begin": {
      const lease = await coordinator.beginSnapshot({ id: params.id });
      state.snapshot = { id: params.id, release: lease.release };
      return lease.snapshot;
    }
    case "state.snapshot.release": {
      const snapshot = state.snapshot;
      if (!snapshot || snapshot.id !== params.id) {
        throw new StateCoordinatorError("OPERATION_UNKNOWN", "this snapshot lease is not active");
      }
      await snapshot.release();
      state.snapshot = undefined;
      return {};
    }
    case "state.recover": return coordinator.recover();
    case "state.runtime.acknowledge": return coordinator.acknowledgeRuntimeHandoff(params);
    case "owner.state": {
      if (!owner) throw new OwnerUnavailableError();
      return ownerCall(state, coordinator, () => owner.state());
    }
    case "owner.create": {
      if (!owner) throw new OwnerUnavailableError();
      return ownerCall(state, coordinator, () => owner.create(params));
    }
    case "owner.password": {
      if (!owner) throw new OwnerUnavailableError();
      return ownerCall(state, coordinator, () => owner.changePassword(params));
    }
    case "owner.ssh": {
      if (!owner) throw new OwnerUnavailableError();
      return ownerCall(state, coordinator, () => owner.configureSsh(params));
    }
    case "recovery.export": {
      if (!recovery) throw new RecoveryUnavailableError();
      return { archiveBase64: (await recovery.export()).toString("base64") };
    }
    case "recovery.preview": {
      if (!recovery) throw new RecoveryUnavailableError();
      return recovery.preview({ bytes: decodeRecoveryBase64(params.archiveBase64), sessionId: params.sessionId }) as Promise<RestorePreview>;
    }
    case "recovery.commit": {
      if (!recovery) throw new RecoveryUnavailableError();
      return recovery.commit(params);
    }
    case "recovery.cancel": {
      if (!recovery) throw new RecoveryUnavailableError();
      await recovery.cancel(params);
      return {};
    }
  }
}

async function recoverConnection(state: ConnectionState, coordinator: DurableStateCoordinator): Promise<void> {
  const snapshot = state.snapshot;
  state.snapshot = undefined;
  try { await snapshot?.release(); } catch { /* lease timeout remains a bounded fallback */ }
  const transaction = state.transaction;
  state.transaction = undefined;
  if (transaction) {
    // Recovery errors leave the authoritative operation journal in place.
    // A later startup/recover call retries it; disconnect never clears it.
    try { await coordinator.recoverDisconnected(transaction.id); } catch { /* journal retained */ }
  }
}

function attach(socket: Socket, options: AdminServerOptions): void {
  const { coordinator } = options;
  const state: ConnectionState = { buffer: "", chain: Promise.resolve(), closing: false, queued: 0 };
  const owner = options.ownerBackend
    ? new OwnerAccessService(boundCoordinator(state, coordinator), options.ownerBackend)
    : undefined;
  const recovery = options.recoveryBackend?.(boundCoordinator(state, coordinator));
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer) > MAX_ADMIN_FRAME_BYTES && !state.buffer.includes("\n")) {
      state.closing = true;
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = state.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      state.queued += 1;
      if (state.queued > MAX_QUEUED_REQUESTS) {
        state.closing = true;
        socket.destroy();
        break;
      }
      state.chain = state.chain.then(async () => {
        if (state.closing) return;
        let request: AdminRequest;
        try { request = decodeAdminRequest(line); } catch {
          state.closing = true;
          socket.destroy();
          return;
        }
        try {
          const result = await dispatch(request, state, coordinator, owner, recovery, options.storageBackend);
          socket.write(encodeAdminMessage({ id: request.id, ok: true, result }, request.method));
        } catch (error) {
          socket.write(encodeAdminMessage(safeFailure(request.id, error), request.method));
        }
      }).finally(() => { state.queued -= 1; });
    }
  });
  socket.on("close", () => {
    state.closing = true;
    void state.chain.finally(() => recoverConnection(state, coordinator));
  });
  socket.on("error", () => { /* close performs bounded recovery */ });
}

export function createAdminServer(options: AdminServerOptions): Server {
  const server = createServer((socket) => attach(socket, options));
  server.on("listening", () => {
    if (options.socketPath) chmodSync(options.socketPath, 0o600);
  });
  if (options.fd !== undefined) {
    server.listen({ fd: options.fd });
  } else if (options.socketPath) {
    if (existsSync(options.socketPath)) {
      const info = lstatSync(options.socketPath);
      if (!info.isSocket()) throw new Error("admin socket path is occupied");
      unlinkSync(options.socketPath);
    }
    server.listen(options.socketPath);
  } else {
    throw new Error("admin server requires a socket path or inherited descriptor");
  }
  return server;
}
