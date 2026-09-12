// SPDX-License-Identifier: GPL-3.0-or-later
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fsyncDir, unlinkDurable, writeFileDurable } from "../fs/durable.js";

const OperationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const TokenSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("yonder-maintenance-boot"),
  operationId: OperationId,
}).strict();

export type MaintenanceTokenState = "pending" | "consumed";

export class MaintenanceTokenError extends Error {
  constructor() {
    super("maintenance boot request is unavailable or corrupt");
    this.name = "MaintenanceTokenError";
  }
}

function assertPrivate(path: string, directory: boolean): void {
  const info = lstatSync(path);
  const uid = process.geteuid?.() ?? info.uid;
  const gid = process.getegid?.() ?? info.gid;
  if (info.isSymbolicLink() || (!directory && info.nlink !== 1)
    || (directory ? !info.isDirectory() : !info.isFile())
    || info.uid !== uid || info.gid !== gid
    || (info.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (!directory && info.size > 512)) throw new MaintenanceTokenError();
}

function readPrivateToken(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    const uid = process.geteuid?.() ?? info.uid;
    const gid = process.getegid?.() ?? info.gid;
    if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || info.gid !== gid
      || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 512) {
      throw new MaintenanceTokenError();
    }
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    // The extra byte makes growth between fstat and read fail closed while
    // keeping every allocation and read bounded to 513 bytes.
    if (offset !== info.size) throw new MaintenanceTokenError();
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof MaintenanceTokenError) throw error;
    throw new MaintenanceTokenError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class MaintenanceTokenStore {
  constructor(readonly root: string) {}

  publish(operationId: string): void {
    const token = TokenSchema.parse({ schemaVersion: 1, kind: "yonder-maintenance-boot", operationId });
    const parent = dirname(this.root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { mode: 0o700 });
      chmodSync(this.root, 0o700);
      fsyncDir(parent);
    } else {
      assertPrivate(this.root, true);
    }
    if (existsSync(this.pendingPath()) || existsSync(this.consumedPath())) throw new MaintenanceTokenError();
    writeFileDurable(this.pendingPath(), `${JSON.stringify(token)}\n`, 0o600);
  }

  read(): null | { state: MaintenanceTokenState; operationId: string } {
    if (!existsSync(this.root)) return null;
    assertPrivate(this.root, true);
    const entries = readdirSync(this.root);
    const interrupted = "pending.json.tmp";
    if (entries.includes(interrupted)) {
      // writeFileDurable publishes pending.json by rename. A power cut before
      // that rename leaves only its private temp file: discard it durably and
      // leave the journal unarmed so normal recovery rolls the request back.
      if (entries.length !== 1) throw new MaintenanceTokenError();
      assertPrivate(join(this.root, interrupted), false);
      unlinkDurable(join(this.root, interrupted));
      return null;
    }
    if (entries.some((entry) => entry !== "pending.json" && entry !== "consumed.json")) {
      throw new MaintenanceTokenError();
    }
    const present = (["pending", "consumed"] as const)
      .filter((state) => existsSync(this.path(state)));
    if (present.length === 0) return null;
    if (present.length !== 1) throw new MaintenanceTokenError();
    const state = present[0] as MaintenanceTokenState;
    const path = this.path(state);
    try {
      const raw = readPrivateToken(path);
      const token = TokenSchema.parse(JSON.parse(raw));
      if (raw !== `${JSON.stringify(token)}\n`) throw new MaintenanceTokenError();
      return { state, operationId: token.operationId };
    } catch {
      throw new MaintenanceTokenError();
    }
  }

  consume(operationId: string): void {
    const token = this.read();
    if (!token || token.state !== "pending" || token.operationId !== operationId) throw new MaintenanceTokenError();
    renameSync(this.pendingPath(), this.consumedPath());
    fsyncDir(this.root);
  }

  clear(operationId: string): void {
    const token = this.read();
    if (!token) return;
    if (token.operationId !== operationId) throw new MaintenanceTokenError();
    unlinkDurable(this.path(token.state));
  }

  private pendingPath(): string { return this.path("pending"); }
  private consumedPath(): string { return this.path("consumed"); }
  private path(state: MaintenanceTokenState): string { return join(this.root, `${state}.json`); }
}
