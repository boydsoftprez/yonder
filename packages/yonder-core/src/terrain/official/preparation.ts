// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27: operator-selected, generation-bound preparation, independent of browsers.
import {randomUUID, createHash} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {previewCoverage, type CoverageInput, type CoveragePreview} from './coverage.js';
import {acquireOfficialTile} from './provider.js';
import {AreaRecordSchema, TileRecordSchema, type TerrainPolicy} from './types.js';
import type {OfficialTerrainStore} from './store.js';

export interface PreparationContext {
  generation: string | null; connected: boolean; armed: boolean | null;
  missionRevision: string | null; homeRevision: string | null; rallyRevision: string | null;
}
export interface TerrainPreview {
  id: string; createdAt: number; expiresAt: number; coverage: CoveragePreview;
  sourceSelection: Record<string, string | null>;
  input: CoverageInput; refreshSource: boolean; contextKey: string; policyKey: string;
}
export interface TerrainJob {
  id: string; previewId: string; name: string; state: 'preparing' | 'paused' | 'complete' | 'partial' | 'cancelled' | 'failed' | 'interrupted';
  total: number; completed: number; reason: string | null; areaId: string | null; updatedAt: number;
}
export interface PreparationOptions {
  store: OfficialTerrainStore;
  context: () => PreparationContext;
  policy: () => TerrainPolicy;
  acquire?: typeof acquireOfficialTile;
  now?: () => number;
  persist?: (job: TerrainJob) => Promise<void>;
  previousJob?: TerrainJob | null;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class TerrainPreparationService {
  private previews = new Map<string, TerrainPreview>();
  private job: TerrainJob | null = null;
  private abort: AbortController | null = null;
  private work: Promise<void> | null = null;
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: PreparationOptions) {
    this.now = options.now ?? Date.now;
    if (options.previousJob) this.job = {...options.previousJob,
      state: ['preparing', 'paused'].includes(options.previousJob.state) ? 'interrupted' : options.previousJob.state,
      reason: ['preparing', 'paused'].includes(options.previousJob.state) ? 'Preparation interrupted by service restart; preview again' : options.previousJob.reason};
  }
  private contextKey(input: CoverageInput): string {
    const context = this.options.context();
    return digest(input.kind === 'manual' ? {generation: context.generation} : {
      generation: context.generation, missionRevision: context.missionRevision,
      homeRevision: context.homeRevision, rallyRevision: context.rallyRevision});
  }
  private allowed(preview?: TerrainPreview): string | null {
    if (this.closed) return 'Terrain preparation service closed';
    const context = this.options.context();
    if (!this.options.policy().enabled) return 'Enable the terrain service through configuration first';
    if (!context.connected || context.armed !== false || !context.generation) return 'Fresh disarmed controller required';
    if (preview && (preview.contextKey !== this.contextKey(preview.input)
      || preview.policyKey !== digest(this.options.policy()))) return 'Context changed; preview the area again';
    return null;
  }
  async preview(input: CoverageInput, refreshSource = false): Promise<TerrainPreview & {storage: Awaited<ReturnType<OfficialTerrainStore['status']>>}> {
    const reason = this.allowed(); if (reason) throw new Error(reason);
    const coverage = previewCoverage(input), now = this.now();
    for (const [key, value] of this.previews) if (value.expiresAt < now) this.previews.delete(key);
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
    const preview: TerrainPreview = {id: randomUUID(), createdAt: now, expiresAt: now + 10 * 60_000,
      coverage, sourceSelection: Object.fromEntries(coverage.tiles.map(tile => [tile, refreshSource ? null : this.options.store.records().reverse().find(record => record.tile === tile)?.sha256 ?? null])), input: structuredClone(input), refreshSource, contextKey: this.contextKey(input), policyKey: digest(this.options.policy())};
    this.previews.set(preview.id, preview);
    return {...structuredClone(preview), storage: await this.options.store.status()};
  }
  prepare(previewId: string, operator: string): TerrainJob {
    if (!operator) throw new Error('Authenticated operator required');
    const preview = this.previews.get(previewId);
    if (!preview || preview.expiresAt < this.now()) throw new Error('Preview expired; preview the area again');
    const reason = this.allowed(preview); if (reason) throw new Error(reason);
    if (this.work) {
      if (this.job?.previewId !== previewId) throw new Error('Another terrain preparation is active');
      return structuredClone(this.job!);
    }
    if (this.job?.previewId === previewId && ['complete', 'partial'].includes(this.job.state)) return structuredClone(this.job);
    if (!preview.coverage.complete) throw new Error(`Coverage unresolved: ${preview.coverage.reasons.join('; ')}`);
    if (!preview.refreshSource && preview.coverage.tiles.some(tile =>
      (this.options.store.records().reverse().find(record => record.tile === tile)?.sha256 ?? null) !== preview.sourceSelection[tile])) {
      throw new Error('Terrain source generation changed; preview the area again');
    }
    this.job = {id: randomUUID(), previewId, name: preview.input.name, state: 'preparing', total: preview.coverage.tiles.length,
      completed: 0, reason: null, areaId: null, updatedAt: this.now()};
    const abort = new AbortController(); this.abort = abort;
    this.work = Promise.resolve().then(() => this.run(preview, abort)).finally(() => { this.work = null; this.abort = null; });
    return structuredClone(this.job);
  }
  private async save(): Promise<void> {
    if (this.job) { if (this.job.reason) this.job.reason = this.job.reason.slice(0, 1024); this.job.updatedAt = this.now(); await this.options.persist?.(structuredClone(this.job)); }
  }
  private async run(preview: TerrainPreview, abort: AbortController): Promise<void> {
    const timer = setInterval(() => {
      const reason = this.allowed(preview);
      if (reason) abort.abort(new Error(reason));
    }, 200);
    timer.unref?.();
    let stagedPath: string | null = null;
    const guard = () => { abort.signal.throwIfAborted(); const reason = this.allowed(preview); if (reason) throw new Error(reason); };
    try {
      await this.save();
      const objects: {tile: string; sha256: string}[] = [];
      const validityReasons: string[] = [];
      for (const tile of preview.coverage.tiles) {
        abort.signal.throwIfAborted();
        const reason = this.allowed(preview); if (reason) throw new Error(reason);
        let record = preview.refreshSource ? undefined : this.options.store.records().find(record => record.tile === tile && record.sha256 === preview.sourceSelection[tile]);
        if (!record) {
          // One compressed archive plus one raw payload may coexist. Refuse
          // before transfer if that conservative peak cannot fit.
          await this.options.store.admit(64 * 1024 ** 2 + 25934402);
          const acquired = await (this.options.acquire ?? acquireOfficialTile)(tile, {
            stagingDirectory: this.options.store.stagingDirectory, signal: abort.signal,
            admit: bytes => this.options.store.admit(bytes),
          });
          stagedPath = acquired.path;
          abort.signal.throwIfAborted();
          const changed = this.allowed(preview); if (changed) throw new Error(changed);
          const {path, ...metadata} = acquired;
          record = await this.options.store.commitObject({...TileRecordSchema.parse(metadata), path}, guard);
          stagedPath = null;
        }
        objects.push({tile: record.tile, sha256: record.sha256});
        if (record.nodataSamples !== 0) validityReasons.push(`${tile}: missing source samples or unverified validity; selected-area coverage is partial`);
        this.job!.completed++;
        await this.save();
      }
      abort.signal.throwIfAborted();
      const changed = this.allowed(preview); if (changed) throw new Error(changed);
      const areaId = randomUUID();
      await this.options.store.saveArea(AreaRecordSchema.parse({id: areaId, name: preview.input.name, pinned: true,
        revision: preview.coverage.revision, contextKey: preview.contextKey, createdAt: new Date(this.now()).toISOString(), kind: preview.input.kind,
        coverage: {bufferM: preview.input.bufferM, geometry: preview.coverage.geometry, ...(preview.input.kind === 'manual' ? {bounds: preview.input.bounds} : {})},
        objects, complete: preview.coverage.complete && validityReasons.length === 0, reasons: [...preview.coverage.reasons, ...validityReasons]}), guard);
      this.job!.state = validityReasons.length ? 'partial' : 'complete'; this.job!.reason = validityReasons.length ? validityReasons.join('; ') : null; this.job!.areaId = areaId;
    } catch (error) {
      if (this.job?.state !== 'cancelled') {
        this.job!.state = abort.signal.aborted ? 'paused' : 'failed';
        this.job!.reason = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearInterval(timer);
      if (stagedPath) await unlink(stagedPath).catch(() => {});
      await this.save().catch(error => { if (this.job) { this.job.state = 'failed'; this.job.reason = `Job persistence failed: ${String(error)}`; } });
    }
  }
  async cancel(jobId: string, operator: string): Promise<void> {
    if (!operator) throw new Error('Authenticated operator required');
    if (!this.job || this.job.id !== jobId) throw new Error('Unknown terrain job');
    if (['complete', 'partial', 'cancelled'].includes(this.job.state)) return;
    this.job.state = 'cancelled'; this.job.reason = 'Cancelled by operator';
    this.abort?.abort(new Error('Cancelled by operator')); await this.work; await this.save();
  }
  snapshot(): TerrainJob | null { return structuredClone(this.job); }
  async settled(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.closed = true; this.abort?.abort(new Error('Service stopped')); await this.work; }
}
