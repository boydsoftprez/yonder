// SPDX-License-Identifier: GPL-3.0-or-later
import type {HgtWindow} from './hgt.js';
import type {TerrainRequestKey} from './types.js';

export type {TerrainRequestKey} from './types.js';

export interface TerrainLocationE7 {
  latE7: number;
  lonE7: number;
}

export interface HgtSourceWindow {
  readonly tile: string;
  readonly rowStart: number;
  readonly columnStart: number;
  readonly rows: 2;
  readonly columns: 2;
  readonly xFraction: number;
  readonly yFraction: number;
}

export interface GridSampleStencil {
  /** h00, h10, h01, h11 from AP_Terrain::height_amsl. */
  readonly locations: readonly [
    Readonly<TerrainLocationE7>, Readonly<TerrainLocationE7>,
    Readonly<TerrainLocationE7>, Readonly<TerrainLocationE7>,
  ];
  /** Bilinear weights parallel to locations. */
  readonly weights: readonly [number, number, number, number];
}

interface RequestGridOrigin {
  latitudeDegrees: number;
  longitudeDegrees: number;
  gridIndexNorth: number;
  gridIndexEast: number;
}

const E7_PER_DEGREE = 10_000_000;
const HGT_INTERVALS = 3600;
const GRID_SPACING_M = 30;
const BLOCK_STRIDE_NORTH = 24;
const BLOCK_STRIDE_EAST = 28;
const SUBGRID_SIZE = 4;
const SUBGRIDS_EAST = 8;
const MAX_BIT = 55;
const ORIGIN_TOLERANCE_M = 0.02;
const LOCATION_SCALING_FACTOR = Math.fround(0.011131884502145034);
const LOCATION_SCALING_FACTOR_INV = Math.fround(89.83204953368922);

/**
 * Returns the requested 4x4 sample coordinates in MAVLink data order:
 * north-major, then east within each row. The incoming origin is only used to
 * recover and validate the controller's degree/grid identity; samples are
 * regenerated from that canonical identity to avoid accumulating origin drift.
 */
export function subgridLocations(
  key: TerrainRequestKey,
  bit: number,
): readonly Readonly<TerrainLocationE7>[] {
  validateRequestKey(key);
  if (!Number.isSafeInteger(bit) || bit < 0 || bit > MAX_BIT) {
    throw new RangeError(`terrain request bit must be an integer from 0 to ${MAX_BIT}`);
  }

  const origin = recoverRequestGridOrigin(key);
  const subgridNorth = Math.floor(bit / SUBGRIDS_EAST) * SUBGRID_SIZE;
  const subgridEast = (bit % SUBGRIDS_EAST) * SUBGRID_SIZE;
  const points: Readonly<TerrainLocationE7>[] = [];

  for (let north = 0; north < SUBGRID_SIZE; north += 1) {
    for (let east = 0; east < SUBGRID_SIZE; east += 1) {
      const globalNorth = origin.gridIndexNorth * BLOCK_STRIDE_NORTH + subgridNorth + north;
      const globalEast = origin.gridIndexEast * BLOCK_STRIDE_EAST + subgridEast + east;
      const location = addGeneratorOffset(
        origin.latitudeDegrees * E7_PER_DEGREE,
        origin.longitudeDegrees * E7_PER_DEGREE,
        globalNorth * GRID_SPACING_M,
        globalEast * GRID_SPACING_M,
      );
      const point = {latE7: location.latE7, lonE7: wrapLongitude(location.lonE7)};
      validateLocation(point);
      points.push(Object.freeze(point));
    }
  }

  return Object.freeze(points);
}

/**
 * Returns the four generated integer-grid samples and AP_Terrain bilinear
 * weights used for a point-height result. Raw HGT interpolation happens at
 * each returned location before its height is truncated to the generated grid.
 */
export function gridSampleStencil(location: TerrainLocationE7): Readonly<GridSampleStencil> {
  validateLocation(location);
  const longitudeE7 = wrapLongitude(location.lonE7);
  const latitudeDegrees = Math.floor(location.latE7 / E7_PER_DEGREE);
  const longitudeDegrees = Math.floor(longitudeE7 / E7_PER_DEGREE);
  const referenceLatE7 = latitudeDegrees * E7_PER_DEGREE;
  const referenceLonE7 = longitudeDegrees * E7_PER_DEGREE;
  const northOffsetM = Math.fround((location.latE7 - referenceLatE7) * LOCATION_SCALING_FACTOR);
  const eastOffsetM = Math.fround(
    Math.fround(longitudeDifference(longitudeE7, referenceLonE7) * LOCATION_SCALING_FACTOR)
      * controllerLongitudeScale(Math.trunc((location.latE7 + referenceLatE7) / 2)),
  );
  const globalNorth = Math.floor(northOffsetM / GRID_SPACING_M);
  const globalEast = Math.floor(eastOffsetM / GRID_SPACING_M);
  const northFraction = Math.fround(
    Math.fround(northOffsetM - Math.fround(globalNorth * GRID_SPACING_M)) / GRID_SPACING_M,
  );
  const eastFraction = Math.fround(
    Math.fround(eastOffsetM - Math.fround(globalEast * GRID_SPACING_M)) / GRID_SPACING_M,
  );

  const gridLocation = (north: number, east: number): Readonly<TerrainLocationE7> => {
    const generated = addGeneratorOffset(
      referenceLatE7,
      referenceLonE7,
      (globalNorth + north) * GRID_SPACING_M,
      (globalEast + east) * GRID_SPACING_M,
    );
    const point = Object.freeze({latE7: generated.latE7, lonE7: wrapLongitude(generated.lonE7)});
    validateLocation(point);
    return point;
  };
  const locations = Object.freeze([
    gridLocation(0, 0),
    gridLocation(1, 0),
    gridLocation(0, 1),
    gridLocation(1, 1),
  ] as const);
  const inverseNorth = Math.fround(1 - northFraction);
  const inverseEast = Math.fround(1 - eastFraction);
  const weights = Object.freeze([
    Math.fround(inverseNorth * inverseEast),
    Math.fround(northFraction * inverseEast),
    Math.fround(inverseNorth * eastFraction),
    Math.fround(northFraction * eastFraction),
  ] as const);

  return Object.freeze({locations, weights});
}

/** Maps one E7 coordinate to the canonical HGT tile and its four contributors. */
export function sourceWindowFor(location: TerrainLocationE7): Readonly<HgtSourceWindow> {
  validateLocation(location);
  const longitudeE7 = wrapLongitude(location.lonE7);
  const latitude = location.latE7 * 1.0e-7;
  const longitude = longitudeE7 * 1.0e-7;
  const latitudeDegrees = Math.floor(latitude);
  const longitudeDegrees = Math.floor(longitude);
  const x = (longitude - longitudeDegrees) * HGT_INTERVALS;
  const y = (latitude - latitudeDegrees) * HGT_INTERVALS;
  const xInteger = Math.floor(x);
  const yInteger = Math.floor(y);

  return Object.freeze({
    tile: tileName(latitudeDegrees, longitudeDegrees),
    rowStart: HGT_INTERVALS - yInteger - 1,
    columnStart: xInteger,
    rows: 2,
    columns: 2,
    xFraction: x - xInteger,
    yFraction: y - yInteger,
  });
}

/** Bilinearly interpolates raw HGT contributors without generated-grid rounding. */
export function interpolateHgt(location: TerrainLocationE7, window: HgtWindow): number | null {
  const source = sourceWindowFor(location);
  const identity = window?.identity;
  if (identity === undefined
    || identity.tile !== source.tile
    || identity.rowStart > source.rowStart
    || identity.columnStart > source.columnStart
    || identity.rowStart + identity.rows < source.rowStart + source.rows
    || identity.columnStart + identity.columns < source.columnStart + source.columns) {
    throw new RangeError('HGT source window does not cover the requested location');
  }

  const northWest = window.sample(source.rowStart, source.columnStart);
  const northEast = window.sample(source.rowStart, source.columnStart + 1);
  const southWest = window.sample(source.rowStart + 1, source.columnStart);
  const southEast = window.sample(source.rowStart + 1, source.columnStart + 1);
  if (northWest === null || northEast === null || southWest === null || southEast === null) {
    return null;
  }

  const south = southEast * source.xFraction + southWest * (1 - source.xFraction);
  const north = northEast * source.xFraction + northWest * (1 - source.xFraction);
  return north * source.yFraction + south * (1 - source.yFraction);
}

function recoverRequestGridOrigin(key: TerrainRequestKey): RequestGridOrigin {
  const baseLatitude = Math.floor(key.latE7 / E7_PER_DEGREE);
  const baseLongitude = Math.floor(wrapLongitude(key.lonE7) / E7_PER_DEGREE);
  const matches: Array<RequestGridOrigin & {distanceM: number}> = [];

  for (let latitudeDegrees = baseLatitude - 1; latitudeDegrees <= baseLatitude + 1; latitudeDegrees += 1) {
    if (latitudeDegrees < -90 || latitudeDegrees > 89) continue;
    for (let longitudeOffset = -1; longitudeOffset <= 1; longitudeOffset += 1) {
      const longitudeDegrees = wrapDegreeLongitude(baseLongitude + longitudeOffset);
      const referenceLatE7 = latitudeDegrees * E7_PER_DEGREE;
      const referenceLonE7 = longitudeDegrees * E7_PER_DEGREE;
      const northBlocks = approximateBlockIndex(
        (key.latE7 - referenceLatE7) * LOCATION_SCALING_FACTOR,
        BLOCK_STRIDE_NORTH * GRID_SPACING_M,
      );
      const eastDistance = longitudeDifference(key.lonE7, referenceLonE7)
        * LOCATION_SCALING_FACTOR
        * longitudeScale((key.latE7 + referenceLatE7) * 0.5e-7);
      const eastBlocks = approximateBlockIndex(
        eastDistance,
        BLOCK_STRIDE_EAST * GRID_SPACING_M,
      );

      for (let gridIndexNorth = Math.max(0, northBlocks - 1); gridIndexNorth <= northBlocks + 1; gridIndexNorth += 1) {
        for (let gridIndexEast = Math.max(0, eastBlocks - 1); gridIndexEast <= eastBlocks + 1; gridIndexEast += 1) {
          const generated = addGeneratorOffset(
            referenceLatE7,
            referenceLonE7,
            gridIndexNorth * BLOCK_STRIDE_NORTH * GRID_SPACING_M,
            gridIndexEast * BLOCK_STRIDE_EAST * GRID_SPACING_M,
          );
          if (generated.latE7 < referenceLatE7
            || generated.latE7 >= referenceLatE7 + E7_PER_DEGREE
            || generated.lonE7 < referenceLonE7
            || generated.lonE7 >= referenceLonE7 + E7_PER_DEGREE) {
            continue;
          }
          const distanceM = locationDistanceM(key, generated);
          if (distanceM <= ORIGIN_TOLERANCE_M) {
            matches.push({
              latitudeDegrees,
              longitudeDegrees,
              gridIndexNorth,
              gridIndexEast,
              distanceM,
            });
          }
        }
      }
    }
  }

  matches.sort((left, right) => left.distanceM - right.distanceM);
  const match = matches[0];
  if (match === undefined) {
    throw new RangeError('terrain request origin is not on the supported 30 metre controller grid');
  }
  const {distanceM: _distanceM, ...origin} = match;
  return origin;
}

function approximateBlockIndex(distanceM: number, strideM: number): number {
  return Math.max(0, Math.round(distanceM / strideM));
}

/** Port of pinned terraingen terrain_gen.py add_offset(format="4.1"). */
function addGeneratorOffset(
  latitudeE7: number,
  longitudeE7: number,
  northM: number,
  eastM: number,
): TerrainLocationE7 {
  const latitudeDelta = Math.trunc(northM * LOCATION_SCALING_FACTOR_INV);
  const midpointDegrees = (latitudeE7 + latitudeDelta * 0.5) * 1.0e-7;
  const longitudeDelta = Math.trunc(
    eastM * LOCATION_SCALING_FACTOR_INV / longitudeScale(midpointDegrees),
  );
  return {latE7: latitudeE7 + latitudeDelta, lonE7: longitudeE7 + longitudeDelta};
}

function longitudeScale(latitudeDegrees: number): number {
  const radians = Math.fround(latitudeDegrees * (Math.PI / 180));
  return Math.max(Math.fround(Math.cos(radians)), 0.01);
}

function controllerLongitudeScale(latitudeE7: number): number {
  const radians = Math.fround(latitudeE7 * (1.0e-7 * Math.PI / 180));
  return Math.max(Math.fround(Math.cos(radians)), 0.01);
}

function locationDistanceM(left: TerrainLocationE7, right: TerrainLocationE7): number {
  const north = (left.latE7 - right.latE7) * LOCATION_SCALING_FACTOR;
  const east = longitudeDifference(left.lonE7, right.lonE7)
    * LOCATION_SCALING_FACTOR
    * longitudeScale((left.latE7 + right.latE7) * 0.5e-7);
  return Math.hypot(north, east);
}

function longitudeDifference(leftE7: number, rightE7: number): number {
  let difference = wrapLongitude(leftE7) - wrapLongitude(rightE7);
  if (difference > 180 * E7_PER_DEGREE) difference -= 360 * E7_PER_DEGREE;
  if (difference < -180 * E7_PER_DEGREE) difference += 360 * E7_PER_DEGREE;
  return difference;
}

function wrapLongitude(longitudeE7: number): number {
  if (longitudeE7 > 180 * E7_PER_DEGREE) return longitudeE7 - 360 * E7_PER_DEGREE;
  if (longitudeE7 < -180 * E7_PER_DEGREE) return longitudeE7 + 360 * E7_PER_DEGREE;
  return longitudeE7 === 180 * E7_PER_DEGREE ? -180 * E7_PER_DEGREE : longitudeE7;
}

function wrapDegreeLongitude(longitudeDegrees: number): number {
  if (longitudeDegrees > 179) return longitudeDegrees - 360;
  if (longitudeDegrees < -180) return longitudeDegrees + 360;
  return longitudeDegrees;
}

function tileName(latitudeDegrees: number, longitudeDegrees: number): string {
  const latitudeDirection = latitudeDegrees < 0 ? 'S' : 'N';
  const longitudeDirection = longitudeDegrees < 0 ? 'W' : 'E';
  return `${latitudeDirection}${Math.abs(latitudeDegrees).toString().padStart(2, '0')}`
    + `${longitudeDirection}${Math.abs(longitudeDegrees).toString().padStart(3, '0')}`;
}

function validateRequestKey(key: TerrainRequestKey): void {
  if (typeof key !== 'object' || key === null) {
    throw new TypeError('terrain request key must be an object');
  }
  validateLocation(key);
  if (key.spacingM !== GRID_SPACING_M) {
    throw new RangeError(`terrain request spacing must be ${GRID_SPACING_M} metres`);
  }
}

function validateLocation(location: TerrainLocationE7): void {
  if (typeof location !== 'object' || location === null) {
    throw new TypeError('terrain location must be an object');
  }
  if (!Number.isSafeInteger(location.latE7) || !Number.isSafeInteger(location.lonE7)) {
    throw new RangeError('terrain latitude and longitude must be integer E7 coordinates');
  }
  if (location.latE7 <= -90 * E7_PER_DEGREE || location.latE7 >= 90 * E7_PER_DEGREE) {
    throw new RangeError('terrain sampling at either pole is unsupported');
  }
  if (location.lonE7 < -180 * E7_PER_DEGREE || location.lonE7 > 180 * E7_PER_DEGREE) {
    throw new RangeError('terrain longitude must be between -180 and 180 degrees');
  }
}
