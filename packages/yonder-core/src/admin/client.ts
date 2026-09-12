// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  encodeAdminMessage,
  MAX_ADMIN_FRAME_BYTES,
  OWNER_ADMIN_ERROR_MESSAGES,
  RECOVERY_ADMIN_ERROR_MESSAGES,
  decodeRecoveryBase64,
  responseFrameLimit,
  type AdminMethod,
  type AdminReply,
  type OwnerAdminErrorCode,
  type RecoveryAdminErrorCode,
} from "./protocol.js";
import { StateCoordinatorError, type StateCoordinatorErrorCode } from "../state/coordinator.js";
import type { DurableState, StateCoordinator, StateKind, StateSnapshot, StateTransaction } from "../state/types.js";
import type { PublicOwnerState } from "../owner-access/service.js";
import type { RestorePreview } from "../recovery/import.js";
import type { PublicStorageState } from "./storage-service.js";

export interface CreateOwnerInput {
  username: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ChangeOwnerPasswordInput {
  newPassword: string;
  confirmPassword: string;
}

export interface ConfigureOwnerSshInput {
  enabled: boolean;
  passwordAuthentication: boolean;
  authorizedKeys?: string[];
}

export class OwnerAdminError extends Error {
  constructor(readonly code: OwnerAdminErrorCode, readonly operationId?: string) {
    super(OWNER_ADMIN_ERROR_MESSAGES[code]);
    this.name = "OwnerAdminError";
  }
}

export class RecoveryAdminError extends Error {
  constructor(readonly code: RecoveryAdminErrorCode, readonly operationId?: string) {
    super(RECOVERY_ADMIN_ERROR_MESSAGES[code]);
    this.name = "RecoveryAdminError";
  }
}

interface Pending {
  socket: Socket;
  timer: NodeJS.Timeout;
  method: AdminMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class RemoteTransaction implements StateTransaction {
  constructor(
    private readonly client: AdminClient,
    readonly id: string,
    readonly previous: StateSnapshot,
  ) {}
  stage(state: DurableState): Promise<{ generation: string }> { return this.client.call("state.stage", { id: this.id, state }); }
  activate(): Promise<{ generation: string }> { return this.client.call("state.activate", { id: this.id }); }
  async holdForConfirmation(): Promise<void> { await this.client.call("state.hold", { id: this.id }); }
  commit(): Promise<{ generation: string }> { return this.client.call("state.commit", { id: this.id }); }
  commitForRestart(runtimeGeneration: string): Promise<{ generation: string }> {
    return this.client.call("state.commit.restart", { id: this.id, runtimeGeneration });
  }
  rollback(reasonCode: string): Promise<{ generation: string }> {
    return this.client.call("state.rollback", { id: this.id, reasonCode });
  }
}

export class AdminClient implements StateCoordinator {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly socketPath = "/run/yonder-admin/control.sock",
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60_000) {
      throw new StateCoordinatorError("INVALID_OPERATION", "admin helper timeout is invalid");
    }
  }

  readActiveState(): Promise<StateSnapshot> { return this.call("state.active", {}); }

  async status(): Promise<Awaited<ReturnType<StateCoordinator["status"]>>> {
    return this.call("state.status", {});
  }

  async begin(input: { id: string; kind: StateKind; expectedActiveGeneration?: string }): Promise<StateTransaction> {
    const result = await this.call<{ id: string; previous: StateSnapshot }>("state.begin", input);
    return new RemoteTransaction(this, result.id, result.previous);
  }

  async beginSnapshot(input: { id: string }): Promise<{ snapshot: StateSnapshot; release(): Promise<void> }> {
    const snapshot = await this.call<StateSnapshot>("state.snapshot.begin", input);
    let released = false;
    return {
      snapshot,
      release: async () => {
        if (released) return;
        released = true;
        await this.call("state.snapshot.release", input);
      },
    };
  }

  recover(): Promise<Awaited<ReturnType<StateCoordinator["recover"]>>> {
    return this.call("state.recover", {});
  }

  acknowledgeRuntimeHandoff(input: { operationId: string; generation: string; runtimeGeneration: string }): Promise<{ generation: string }> {
    return this.call("state.runtime.acknowledge", input);
  }

  ownerState(): Promise<PublicOwnerState> {
    return this.call("owner.state", {});
  }

  storageState(): Promise<PublicStorageState> { return this.call("storage.status", {}); }
  requestMaintenance(): Promise<{ id: string; generation: string }> { return this.call("storage.maintenance.request", {}); }

  createOwner(input: CreateOwnerInput): Promise<PublicOwnerState> {
    return this.call("owner.create", { ...input });
  }

  changeOwnerPassword(input: ChangeOwnerPasswordInput): Promise<PublicOwnerState> {
    return this.call("owner.password", { ...input });
  }

  configureOwnerSsh(input: ConfigureOwnerSshInput): Promise<PublicOwnerState> {
    return this.call("owner.ssh", { ...input });
  }

  async exportRecovery(): Promise<Buffer> {
    const result = await this.call<{ archiveBase64: string }>("recovery.export", {});
    if (!result || typeof result.archiveBase64 !== "string" || Object.keys(result).length !== 1) {
      throw new RecoveryAdminError("ARCHIVE_INVALID");
    }
    return decodeRecoveryBase64(result.archiveBase64);
  }

  previewRecovery(input: { bytes: Uint8Array; sessionId: string }): Promise<RestorePreview> {
    return this.call("recovery.preview", {
      archiveBase64: Buffer.from(input.bytes).toString("base64"),
      sessionId: input.sessionId,
    });
  }

  commitRecovery(input: {
    restoreId: string;
    sessionId: string;
    destinationGeneration: string;
    runtimeGeneration: string;
    confirm: boolean;
  }): Promise<{ operationId: string; generation: string }> {
    return this.call("recovery.commit", { ...input });
  }

  async cancelRecovery(input: { restoreId: string; sessionId: string }): Promise<void> {
    await this.call("recovery.cancel", { ...input });
  }

  async call<T = any>(method: AdminMethod, params: Record<string, unknown>): Promise<T> {
    await this.connect();
    const id = randomUUID();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new StateCoordinatorError("STATE_UNAVAILABLE", "admin helper connection failed");
    }
    const message = encodeAdminMessage({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(), this.timeoutMs);
      timer.unref();
      this.pending.set(id, { socket, timer, method, resolve: (value) => resolve(value as T), reject });
      socket.write(message, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new StateCoordinatorError("STATE_UNAVAILABLE", "admin helper connection failed"));
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let opened = false;
      const timer = setTimeout(() => socket.destroy(), this.timeoutMs);
      timer.unref();
      socket.setEncoding("utf8");
      socket.once("connect", () => { opened = true; clearTimeout(timer); this.socket = socket; resolve(); });
      socket.on("data", (chunk: string) => this.receive(socket, chunk));
      socket.on("close", () => {
        clearTimeout(timer);
        if (!opened) reject(new Error("connection closed"));
        this.failPending(socket);
      });
      socket.on("error", (error) => {
        if (!this.socket) { clearTimeout(timer); reject(error); }
      });
    }).catch(() => {
      throw new StateCoordinatorError("STATE_UNAVAILABLE", "admin helper is unavailable");
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private receive(socket: Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_ADMIN_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.socket?.destroy();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_ADMIN_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let reply: AdminReply;
      try { reply = JSON.parse(line) as AdminReply; } catch { this.socket?.destroy(); return; }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      if (Buffer.byteLength(line) > responseFrameLimit(pending.method)) {
        socket.destroy();
        return;
      }
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.result);
      else if (Object.hasOwn(OWNER_ADMIN_ERROR_MESSAGES, reply.error.code)) {
        pending.reject(new OwnerAdminError(
          reply.error.code as OwnerAdminErrorCode,
          reply.error.operationId,
        ));
      } else if (Object.hasOwn(RECOVERY_ADMIN_ERROR_MESSAGES, reply.error.code)) {
        pending.reject(new RecoveryAdminError(
          reply.error.code as RecoveryAdminErrorCode,
          reply.error.operationId,
        ));
      } else {
        pending.reject(new StateCoordinatorError(reply.error.code as StateCoordinatorErrorCode, reply.error.message));
      }
    }
  }

  private failPending(socket: Socket): void {
    if (this.socket === socket) {
      this.socket = undefined;
      this.buffer = "";
    }
    const error = new StateCoordinatorError("STATE_UNAVAILABLE", "admin helper response was lost");
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
