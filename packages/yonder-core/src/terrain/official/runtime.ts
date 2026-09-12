// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28, R-CFG-03: one daemon-owned terrain runtime, fault-isolated from networking.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import type {Config} from '../../schema/config.js';
import type {Clock, Renderer} from '../../apply/types.js';
import type {VehicleService} from '../../mav/vehicle.js';
import {decodeDatagram} from '../../mav/protocol.js';
import {OfficialTerrainStore, type OfficialStoreOptions} from './store.js';
import {TerrainResponder} from './responder.js';
import {TerrainCompatibility} from './compatibility.js';
import {TerrainControllerRefresh} from './refresh.js';
import {TerrainPreparationService, type PreparationContext, type TerrainJob} from './preparation.js';
import {TerrainPolicySchema, type TerrainLocation} from './types.js';
import {readTerrainMetadata, writeTerrainMetadata} from './storage.js';
import type {CoverageInput} from './coverage.js';
import type {acquireOfficialTile} from './provider.js';

export interface TerrainRuntimeOptions {
  vehicle: Pick<VehicleService, 'snapshot'>;
  send: (bytes: Uint8Array) => Promise<void>;
  routerGeneration: () => string | null;
  serialBaud: () => number;
  clock: Clock;
  root?: string;
  probe?: OfficialStoreOptions['probe'];
  acquire?: typeof acquireOfficialTile;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const JobSchema = z.object({id: z.string().uuid(), previewId: z.string().uuid(), name: z.string().max(80),
  state: z.enum(['preparing', 'paused', 'complete', 'partial', 'cancelled', 'failed', 'interrupted']), total: z.number().int().min(0).max(32),
  completed: z.number().int().min(0).max(32), reason: z.string().max(1024).nullable(), areaId: z.string().uuid().nullable(), updatedAt: z.number().finite()}).strict();

export class TerrainRuntime implements Renderer {
  readonly name = 'terrain';
  private policy = TerrainPolicySchema.parse({});
  private reserveBytes = 1024 ** 3;
  private store: OfficialTerrainStore | null = null;
  private preparation: TerrainPreparationService | null = null;
  private opening: Promise<void> | null = null;
  private failure: string | null = null;
  private closed = false;
  private root: string;
  private compatibility = new TerrainCompatibility();
  private refresh: TerrainControllerRefresh;
  private responder: TerrainResponder;
  private boot = 0;
  constructor(private options: TerrainRuntimeOptions) {
    this.root = options.root ?? '/var/lib/yonder/terrain';
    this.refresh = new TerrainControllerRefresh({vehicle: () => options.vehicle.snapshot({details: false}), send: options.send, clock: options.clock});
    this.responder = new TerrainResponder({
      vehicle: () => { const snapshot = options.vehicle.snapshot({details: false}); return {...snapshot, busy: snapshot.busy || this.refresh.busy}; },
      store: {readSubgrid: (key, bit, signal) => this.store?.readSubgrid(key, bit, signal)
        ?? Promise.resolve({available: false, reason: this.failure ?? 'terrain-storage-not-ready'})},
      compatibility: this.compatibility, send: options.send, clock: options.clock,
      routerGeneration: options.routerGeneration, serialBaud: options.serialBaud, policy: () => this.policy,
    });
  }
  async render(config: Config): Promise<void> {
    this.policy = {...config.terrain}; this.reserveBytes = config.storage.reserve_mb * 1024 ** 2;
    this.store?.configure(this.policy.quotaMiB * 1024 ** 2, this.reserveBytes);
    if (!this.policy.enabled) {
      await this.preparation?.close(); this.preparation = null;
      return;
    }
    // Storage work cannot delay network apply or cause rollback/recovery failure.
    if (!this.preparation && !this.opening && !this.closed) {
      this.opening = this.initialize().catch(error => { this.failure = error instanceof Error ? error.message : String(error); })
        .finally(() => { this.opening = null; });
    }
  }
  private async initialize(): Promise<void> {
    const store = this.store ?? await OfficialTerrainStore.open({root: this.root, quotaBytes: this.policy.quotaMiB * 1024 ** 2,
      reserveBytes: this.reserveBytes, probe: this.options.probe});
    if (this.closed) { await store.close(); return; }
    this.store = store; store.configure(this.policy.quotaMiB * 1024 ** 2, this.reserveBytes);
    let previousJob: TerrainJob | null = null;
    try { previousJob = JobSchema.parse(await readTerrainMetadata(join(this.root, 'job.json'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failure = 'Previous preparation record unavailable'; }
    if (!this.policy.enabled) return;
    this.preparation = new TerrainPreparationService({store, context: () => this.context(), policy: () => this.policy,
      now: () => this.options.clock.now(), acquire: this.options.acquire, previousJob,
      persist: async job => { await store.admit(Buffer.byteLength(JSON.stringify(job) + '\n')); await writeTerrainMetadata(join(this.root, 'job.json'), job); }});
    this.failure = null;
  }
  private context(): PreparationContext {
    const vehicle = this.options.vehicle.snapshot(), rally = this.refresh.rally();
    return {generation: vehicle.identity?.generation ?? null, connected: vehicle.connected,
      armed: vehicle.connected ? vehicle.telemetry.armed : null,
      missionRevision: vehicle.mission.synchronization === 'verified' ? vehicle.mission.revision : null,
      homeRevision: vehicle.telemetry.homePosition ? hash(vehicle.telemetry.homePosition) : null,
      rallyRevision: rally?.revision ?? null};
  }
  receive(datagram: Uint8Array): void {
    if (this.closed) return;
    try {
      this.responder.receive(datagram);
      const boot = this.compatibility.snapshot(this.options.vehicle.snapshot({details: false})).reboot;
      if (boot !== this.boot) { this.boot = boot; this.refresh.reset(); }
      for (const frame of decodeDatagram(datagram)) this.refresh.receive(frame);
    } catch (error) { this.failure = `Terrain observation failed: ${String(error)}`; }
  }
  async status() {
    const context = this.context();
    let storage: Awaited<ReturnType<OfficialTerrainStore['status']>> | null = null;
    try { storage = await this.store?.status() ?? null; }
    catch (error) { this.failure = `Terrain storage unavailable: ${String(error)}`; }
    const missionKey = hash({generation: context.generation, missionRevision: context.missionRevision,
      homeRevision: context.homeRevision, rallyRevision: context.rallyRevision});
    return {schemaVersion: 1, at: this.options.clock.now(), policy: this.policy,
      storage, loading: this.opening !== null, failure: this.failure,
      coverage: {areas: (storage?.areas ?? []).map(area => ({...area, stale: area.kind === 'mission' && area.contextKey !== missionKey})),
        job: this.preparation?.snapshot() ?? null}, service: this.responder.snapshot(), controllerRefresh: this.refresh.snapshot(),
      preparationAllowed: this.policy.enabled && context.connected && context.armed === false && !!this.preparation,
      limits: {maxTiles: 32, maxAreas: 32, bufferMinM: 50, bufferMaxM: 10000},
      source: {provider: 'ardupilot-srtm1', dataset: 'Official ArduPilot ALOS-derived SRTM1', spacingM: 30,
        datum: 'MSL', ownership: 'Operator-managed single responder; exclusivity is not enforced'},
    };
  }
  async preview(body: {kind: 'manual' | 'mission'; name: string; bufferM: number; refreshSource?: boolean; bounds?: {south: number; north: number; west: number; east: number}}) {
    await this.opening;
    if (!this.preparation) throw new Error(this.failure ?? 'Enable terrain service and verify persistent storage first');
    let input: CoverageInput;
    if (body.kind === 'manual') {
      if (!body.bounds) throw new Error('Manual map bounds required');
      input = {kind: 'manual', name: body.name, bufferM: body.bufferM, bounds: body.bounds};
    } else {
      const vehicle = this.options.vehicle.snapshot();
      if (vehicle.mission.synchronization !== 'verified' || !vehicle.mission.revision) throw new Error('Explicitly download and verify the current mission first');
      input = {kind: 'mission', name: body.name, bufferM: body.bufferM,
        mission: {revision: vehicle.mission.revision, items: vehicle.mission.items},
        home: vehicle.telemetry.homePosition, rally: this.refresh.rally()};
    }
    return this.preparation.preview(input, body.refreshSource ?? false);
  }
  prepare(previewId: string, operator: string) {
    if (!this.preparation) throw new Error(this.failure ?? 'Terrain preparation unavailable');
    return this.preparation.prepare(previewId, operator);
  }
  async cancel(jobId: string, operator: string): Promise<void> { await this.preparation?.cancel(jobId, operator); }
  async setPinned(areaId: string, pinned: boolean, operator: string): Promise<void> {
    if (!operator || !this.store) throw new Error('Authenticated terrain store required'); await this.store.setPinned(areaId, pinned);
  }
  async remove(areaId: string, operator: string): Promise<void> {
    if (!operator || !this.store) throw new Error('Authenticated terrain store required'); await this.store.removeArea(areaId);
  }
  refreshController(operator: string, generation: string): void { this.refresh.start(operator, generation); }
  async samples(points: TerrainLocation[]) {
    if (points.length > 128) throw new Error('Terrain sample batch exceeds 128 points');
    const samples = [];
    for (const point of points) samples.push(await this.store?.sampleAt(point) ?? {available: false, reason: 'terrain-storage-not-ready'});
    return {samples};
  }
  async ready(): Promise<void> { await this.opening; }
  async close(): Promise<void> {
    this.closed = true; this.responder.close(); this.refresh.close();
    await this.opening; await this.preparation?.close(); await this.store?.close();
  }
}
