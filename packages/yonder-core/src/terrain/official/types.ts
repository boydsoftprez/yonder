// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28: versioned, wire-safe official terrain contracts.
import {z} from 'zod';

export const TerrainPolicySchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.literal('ardupilot-srtm1').default('ardupilot-srtm1'),
  quotaMiB: z.number().int().min(128).max(32768).default(2048),
}).strict();
export type TerrainPolicy = z.infer<typeof TerrainPolicySchema>;
export interface TerrainLocation {lat: number; lon: number}
export interface TerrainRequestKey {latE7: number; lonE7: number; spacingM: 30}
export const TileNameSchema = z.string().regex(/^(?:N(?:[0-8]\d)|S(?:0[1-9]|[1-8]\d|90))(?:E(?:0\d\d|1[0-7]\d)|W(?:00[1-9]|0[1-9]\d|1[0-7]\d|180))$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TileRecordSchema = z.object({
  tile: TileNameSchema, sha256: Hash, archiveSha256: Hash,
  nodataSamples: z.number().int().min(0).max(12967201).optional(),
  bytes: z.literal(25934402), sourceUrl: z.string().url(), retrievedAt: z.string().datetime(),
}).strict().refine(value => value.sourceUrl === `https://terrain.ardupilot.org/SRTM1/${value.tile}.hgt.zip`, 'Unexpected terrain source');
export type TileRecord = z.infer<typeof TileRecordSchema>;
const CoveragePoint = z.object({lat:z.number().finite().gt(-90).lt(90),lon:z.number().finite().min(-180).max(180)}).strict();
const CoverageBounds = z.object({south:z.number().finite().gt(-90).lt(90),north:z.number().finite().gt(-90).lt(90),
  west:z.number().finite().min(-180).max(180),east:z.number().finite().min(-180).max(180)}).strict();
const SavedCoverage = z.object({bufferM:z.number().min(50).max(10000),bounds:CoverageBounds.optional(),
  geometry:z.object({rectangles:z.array(CoverageBounds).max(4096),polylines:z.array(z.object({
    kind:z.enum(['route-leg','return-corridor','loiter-extent']),points:z.array(CoveragePoint).max(4096),crossesAntimeridian:z.boolean(),
  }).strict()).max(4096)}).strict(),
}).strict();
export const AreaRecordSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(80), pinned: z.boolean(),
  revision: z.string().min(1).max(256), createdAt: z.string().datetime(),
  kind: z.enum(['manual', 'mission']),
  objects: z.array(z.object({tile: TileNameSchema, sha256: Hash}).strict()).min(1).max(32),
  coverage: SavedCoverage.optional(),
  contextKey: z.string().max(256).nullable().optional(),
  complete: z.boolean(), reasons: z.array(z.string().max(256)).max(64),
}).strict();
export type PreparedArea = z.infer<typeof AreaRecordSchema>;
export const TerrainIndexSchema = z.object({
  schemaVersion: z.literal(1),
  objects: z.array(TileRecordSchema).max(4096),
  areas: z.array(AreaRecordSchema).max(32),
}).strict().superRefine((index, context) => {
  const ids = index.objects.map(object => `${object.tile}.${object.sha256}`);
  if (new Set(ids).size !== ids.length || new Set(index.areas.map(area => area.id)).size !== index.areas.length) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate terrain index identity'});
  }
  for (const area of index.areas) {
    if (new Set(area.objects.map(object => object.tile)).size !== area.objects.length
      || area.objects.some(object => !ids.includes(`${object.tile}.${object.sha256}`))) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Area references missing or duplicate terrain objects'});
    }
  }
});
export type TerrainIndex = z.infer<typeof TerrainIndexSchema>;
export type TerrainSample = {available: false; reason: string} | {
  available: true; heightM: number; provider: 'ardupilot-srtm1'; generation: string;
  spacingM: 30; datum: 'MSL'; datumEvidence: string;
};
