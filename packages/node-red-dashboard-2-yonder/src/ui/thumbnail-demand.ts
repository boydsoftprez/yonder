// SPDX-License-Identifier: GPL-3.0-or-later
import { expireCameraSession } from './camera-session.js';
type Demand = { id: string; want: 'video' | 'stills' | 'off' };
export interface ThumbnailState { camera: string; viewer: string; at: number; overlay: Record<string, unknown>; [key: string]: unknown }
type Body = { want: Demand['want']; stills: boolean };
/** Bounded display demand only. No capture, photo, recording or motion command. */
export class ThumbnailDemand {
  private desired = new Map<string, Body>();
  private known = new Set<string>();
  private pending = new Set<string>();
  private closed = false;
  private blocked = false;
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly onState?: (state: ThumbnailState) => void) {}
  set(rows: Demand[]): void {
    if (this.closed) return;
    this.desired = new Map(rows.slice(0, 8).filter(row => /^[a-z0-9][a-z0-9-]{0,31}$/.test(row.id)).map(row => [row.id, { want: row.want, stills: true }]));
    this.refresh();
  }
  refresh(): void {
    if (this.blocked) return;
    for (const id of new Set([...this.known, ...this.desired.keys()])) {
      if (!this.pending.has(id)) void this.send(id, this.desired.get(id) ?? { want: 'off', stills: false });
    }
  }
  close(): void { this.closed = true; this.desired.clear(); this.refresh(); }
  private async send(id: string, body: Body): Promise<void> {
    this.pending.add(id); if (body.stills) this.known.add(id);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1500);
    try { const response = await this.fetcher(`/video/${id}/report`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (response?.ok && body.stills && !this.closed && this.onState && typeof response.json === 'function') {
        const state = await response.json();
        const wanted = this.desired.get(id);
        if (!this.closed && !this.blocked && wanted?.stills && wanted.want === body.want
            && state?.camera === id && typeof state.viewer === 'string' && Number.isFinite(state.at)
            && state.overlay && typeof state.overlay === 'object' && !Array.isArray(state.overlay)) this.onState(state);
      }
      if (response?.status === 401) { this.closed = true; this.blocked = true; this.desired.clear(); this.known.clear(); expireCameraSession(); }
    }
    catch { /* The next display tick may renew; there is no retry loop. */ }
    finally {
      clearTimeout(timer); this.pending.delete(id);
      if (!body.stills) this.known.delete(id);
      const next = this.desired.get(id) ?? { want: 'off' as const, stills: false };
      if (!this.blocked && (next.want !== body.want || next.stills !== body.stills)) void this.send(id, next);
    }
  }
}
