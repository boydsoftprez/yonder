// SPDX-License-Identifier: GPL-3.0-or-later
/** R-FLT-08/09: terrain elevations are always metres in an explicit reference. */
export type HeightDatum = 'NAVD88' | 'EGM96' | 'WGS84_ELLIPSOID' | 'UNKNOWN';
export interface TerrainSource {
  id: string; url: string; sha256: string; bytes: number; attribution: string;
  surveyStart: string; surveyEnd: string; horizontalCrs: string; verticalDatum: string; units: string;
}
export interface TerrainTileDescriptor {
  id: string; file: string; sha256: string; bytes: number; decodedBytes: number;
  level: number; columns: number; rows: number; spacingM: number;
  /** Coordinate of the north-west sample centre; subsequent rows move south. */
  originEastingM: number; originNorthingM: number;
  groundCoverage: number; surfaceCoverage: number;
  minGroundM: number | null; maxSurfaceM: number | null;
}
export interface TerrainManifest {
  schemaVersion: 1; id: string; title: string; createdAt: string;
  horizontalCrs: { kind: 'UTM'; datum: 'WGS84'; zone: number; hemisphere: 'north' | 'south' };
  verticalDatum: HeightDatum;
  verticalTransform: { verified: boolean; description: string; grids: string[] };
  surfaceDescription: string; sourceResolutionM: number;
  sources: TerrainSource[]; tiles: TerrainTileDescriptor[];
  /** Explicit limitations are part of the display, not a claim of full coverage. */
  limitations: string[];
}
export interface TerrainTile {
  descriptor: TerrainTileDescriptor; groundM: Float32Array; surfaceM: Float32Array;
}
export interface TerrainSample { groundM: number | null; surfaceM: number | null }
export interface CameraCalibration {
  id: string; cameraId: string; profileId: string; validated: boolean;
  width: number; height: number; fx: number; fy: number; cx: number; cy: number;
  distortion: { model: 'brown-conrady'; k1: number; k2: number; p1: number; p2: number; k3: number };
  /** Rotation from body forward/right/down coordinates into camera right/down/forward. */
  bodyToCamera: [number, number, number, number, number, number, number, number, number];
  cameraOffsetBodyM: [number, number, number];
  /** Board image transform, applied exactly once after optical projection. */
  mirrorX: boolean; rotation: 0 | 90 | 180 | 270;
  residualPx: number; maxResidualPx: number;
  timingVerified: boolean; maxTimeErrorMs: number;
}
export interface RegistrationContext {
  cameraId: string; profileId: string; nowMs: number; frameCaptureMs: number | null;
  poseTimeMs: number | null; timeErrorMs: number | null;
  telemetryMaxAgeMs: number; frameMaxAgeMs: number;
  poseBracketed: boolean; terrainDatum: HeightDatum; aircraftDatum: HeightDatum;
  verticalTransformVerified: boolean; terrainCovered: boolean;
}
export interface RegistrationValidity { ready: boolean; reason: string }
