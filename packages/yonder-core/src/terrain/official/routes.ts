// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-02/27/28: called only behind the authenticated same-origin cockpit proxy.
import {z} from 'zod';
import type {TerrainRuntime} from './runtime.js';
import {TerrainPolicySchema, type TerrainPolicy} from './types.js';
export interface TerrainPolicyControl {
  get(): unknown;
  apply(policy: TerrainPolicy, expectedRevision: string): Promise<unknown>;
  confirm(id: string): unknown;
  revert(id: string): Promise<unknown>;
}

const Operator = {sessionId: z.string().min(1).max(256)};
const Point = z.object({lat: z.number().finite().gt(-90).lt(90), lon: z.number().finite().min(-180).max(180)}).strict();
const Bounds = z.object({south: z.number().finite().gt(-90).lt(90), north: z.number().finite().gt(-90).lt(90),
  west: z.number().finite().min(-180).max(180), east: z.number().finite().min(-180).max(180)}).strict();
const Preview = z.discriminatedUnion('kind', [
  z.object({...Operator, kind: z.literal('manual'), name: z.string().trim().min(1).max(80), refreshSource: z.boolean().optional(), bufferM: z.number().min(50).max(10000), bounds: Bounds}).strict(),
  z.object({...Operator, kind: z.literal('mission'), name: z.string().trim().min(1).max(80), refreshSource: z.boolean().optional(), bufferM: z.number().min(50).max(10000)}).strict(),
]);

export async function officialTerrainRoute(runtime: TerrainRuntime | undefined, method: string, path: string, body: unknown, policyControl?: TerrainPolicyControl) {
  if (!path.startsWith('/cockpit/terrain-service')) return null;
  const known = ['/cockpit/terrain-service', '/cockpit/terrain-service/policy', '/cockpit/terrain-service/policy/apply', '/cockpit/terrain-service/policy/confirm', '/cockpit/terrain-service/policy/revert', ...['preview', 'prepare', 'cancel', 'pin', 'remove', 'refresh-controller', 'samples'].map(action => `/cockpit/terrain-service/${action}`)];
  if (!known.includes(path)) return {status: 404, body: {error: 'Unknown terrain route'}};
  if ((['/cockpit/terrain-service', '/cockpit/terrain-service/policy'].includes(path) ? 'GET' : 'POST') !== method) return {status: 405, body: {error: 'Method not allowed'}};
  try {
    if (path.includes('/policy')) {
      if (!policyControl) return {status:503,body:{error:'Terrain policy control unavailable'}};
      if (method === 'GET') return {status:200,body:policyControl.get()};
      if (path.endsWith('/apply')) {
        const input=z.object({...Operator,policy:TerrainPolicySchema,expectedRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(body);
        return {status:200,body:await policyControl.apply(input.policy,input.expectedRevision)};
      }
      const input=z.object({...Operator,id:z.string().min(1).max(128)}).strict().parse(body);
      return {status:200,body:path.endsWith('/confirm')?policyControl.confirm(input.id):await policyControl.revert(input.id)};
    }
    if (!runtime) return {status: 503, body: {error: 'Terrain runtime unavailable; configure the aircraft link'}};
    if (path === '/cockpit/terrain-service') return {status: 200, body: await runtime.status()};
    let result: unknown = {ok: true};
    switch (path.split('/').at(-1)) {
      case 'preview': { const {sessionId: _, ...input} = Preview.parse(body); result = await runtime.preview(input); break; }
      case 'prepare': { const input = z.object({...Operator, previewId: z.string().uuid()}).strict().parse(body);
        result = runtime.prepare(input.previewId, input.sessionId); break; }
      case 'cancel': { const input = z.object({...Operator, jobId: z.string().uuid()}).strict().parse(body);
        await runtime.cancel(input.jobId, input.sessionId); break; }
      case 'pin': { const input = z.object({...Operator, areaId: z.string().uuid(), pinned: z.boolean()}).strict().parse(body);
        await runtime.setPinned(input.areaId, input.pinned, input.sessionId); break; }
      case 'remove': { const input = z.object({...Operator, areaId: z.string().uuid()}).strict().parse(body);
        await runtime.remove(input.areaId, input.sessionId); break; }
      case 'refresh-controller': { const input = z.object({...Operator, vehicleGeneration: z.string().min(1).max(256)}).strict().parse(body);
        runtime.refreshController(input.sessionId, input.vehicleGeneration); break; }
      case 'samples': { const input = z.object({...Operator, points: z.array(Point).min(1).max(128)}).strict().parse(body);
        result = await runtime.samples(input.points); break; }
    }
    return {status: 200, body: result};
  } catch (error) {
    return {status: error instanceof z.ZodError ? 400 : 409,
      body: {error: error instanceof z.ZodError ? 'Invalid terrain request' : error instanceof Error ? error.message : 'Terrain operation unavailable'}};
  }
}
