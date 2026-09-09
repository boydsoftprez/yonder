// SPDX-License-Identifier: GPL-3.0-or-later
import type { NodeMessage } from './red.js';
type Value = Record<string, any>;
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Complete hydration snapshots, never a second configuration or command writer. */
export class CameraWorkspace {
  private report: Value | null = null;
  private pending: Value | null = null;
  private result: Value | null = null;
  private problems: unknown[] = [];
  private readFailure = false;
  receive(message: NodeMessage): Value | null {
    const body = message.payload;
    const status = object(message.yonder) ? message.yonder : null;
    switch (message.workspaceKind) {
      case 'report':
        if (!object(body) || !object(body.camera) || typeof body.camera.id !== 'string') {
          if (status?.state !== 'rejected') return null;
          if (typeof message.camera === 'string' && this.report?.camera.id !== message.camera) {
            this.report = null; this.problems = [];
          }
          this.result = structuredClone(status); this.readFailure = true; break;
        }
        if (this.report?.camera.id !== body.camera.id) { this.result = null; this.problems = []; }
        if (this.readFailure) this.result = null;
        this.readFailure = false;
        this.report = structuredClone(body); break;
      case 'pending':
        if (!object(body) || typeof body.pending !== 'boolean') return null;
        this.pending = structuredClone({ ...body, expiresAt: status?.expiresAt ?? null, movesRadio: status?.movesRadio === true,
          state: status?.state ?? 'idle', message: status?.message ?? '' });
        break;
      case 'result':
        this.readFailure = false;
        if (!status && typeof body === 'string') { this.result = { state: 'rejected', message: body, at: Date.now() }; break; }
        if (!status || !['pending', 'confirmed', 'rejected'].includes(status.state)) return null;
        if (typeof message.camera === 'string' && this.report && message.camera !== this.report.camera.id) return null;
        if (Array.isArray(message.problems)) this.problems = structuredClone(message.problems);
        else if (status.state !== 'rejected') this.problems = [];
        this.result = structuredClone(status); break;
      default: return null;
    }
    return structuredClone({ ...this.report, problems: this.problems, problemsFor: this.report?.camera.id,
      workspace: { pending: this.pending, result: this.result } });
  }
}
