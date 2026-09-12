// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodeHgtWindow, type HgtWindowIdentity} from './hgt.js';
import {gridSampleStencil, interpolateHgt, sourceWindowFor, subgridLocations} from './grid.js';
import type {TerrainRequestKey} from './types.js';

interface ExpectedManifest {
  request: {originE7: {lat: number; lon: number}; spacingM: 30};
  realWindows: Array<{
    file: string; coversSubgridBit: number; originalRowStart: number;
    originalColumnStart: number; rows: number; columns: number;
  }>;
  expected: {subgrids: Array<{
    bit: number; heightsM: number[];
    points: Array<{locationE7: {lat: number; lon: number}}>;
  }>};
}

interface CoordinateReference {
  pointSample: {
    location: {latE7: number; lonE7: number};
    rawHgtSampleM: number;
    gridLocations: Array<{latE7: number; lonE7: number}>;
    generatedIntegerHeightsM: number[];
    controllerReportedHeightM: number;
  };
  cases: Array<{
    id: string;
    requestOrigin: {latE7: number; lonE7: number};
    bit?: number;
    points?: Array<{latE7: number; lonE7: number}>;
  }>;
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

const expected = JSON.parse(
  readFileSync(new URL('./fixtures/expected.json', import.meta.url), 'utf8'),
) as ExpectedManifest;
const coordinateReference = JSON.parse(
  readFileSync(new URL('./fixtures/coordinate-reference.json', import.meta.url), 'utf8'),
) as CoordinateReference;
const requestKey: TerrainRequestKey = {
  latE7: expected.request.originE7.lat,
  lonE7: expected.request.originE7.lon,
  spacingM: expected.request.spacingM,
};

function decodedWindow(bit: number, filename?: string) {
  const metadata = expected.realWindows.find(entry => entry.coversSubgridBit === bit);
  if (metadata === undefined) throw new Error(`missing fixture metadata for bit ${bit}`);
  const identity: HgtWindowIdentity = {
    tile: 'N35W084',
    schemaVersion: 1,
    rowStart: metadata.originalRowStart,
    columnStart: metadata.originalColumnStart,
    rows: metadata.rows,
    columns: metadata.columns,
  };
  return decodeHgtWindow(fixture(filename ?? metadata.file), identity);
}

describe('official terrain request grid', () => {
  it.each([0, 55])('maps real reference bit %i to its 16 north-major source locations', bit => {
    const subgrid = expected.expected.subgrids.find(entry => entry.bit === bit);
    if (subgrid === undefined) throw new Error(`missing expected subgrid ${bit}`);

    expect(subgridLocations(requestKey, bit)).toEqual(
      subgrid.points.map(point => ({latE7: point.locationE7.lat, lonE7: point.locationE7.lon})),
    );
  });

  it.each([0, 55])('interpolates and truncates real reference bit %i to the expected heights', bit => {
    const subgrid = expected.expected.subgrids.find(entry => entry.bit === bit);
    if (subgrid === undefined) throw new Error(`missing expected subgrid ${bit}`);
    const window = decodedWindow(bit);

    const heights = subgridLocations(requestKey, bit).map(location => {
      const source = sourceWindowFor(location);
      expect(source.tile).toBe('N35W084');
      return Math.trunc(interpolateHgt(location, window) as number);
    });
    expect(heights).toEqual(subgrid.heightsM);
  });

  it.each(coordinateReference.cases.filter(entry => entry.points !== undefined))(
    'matches the pinned $id boundary mapping', reference => {
      const key: TerrainRequestKey = {...reference.requestOrigin, spacingM: 30};
      expect(subgridLocations(key, reference.bit as number)).toEqual(reference.points);
    },
  );

  it('selects the source tile independently for every boundary sample', () => {
    const crossing = coordinateReference.cases.find(entry => entry.id === 'southern-western-crossing');
    if (crossing?.points === undefined) throw new Error('missing southern/western reference');
    expect(crossing.points.map(sourceWindowFor).map(window => window.tile))
      .toEqual(Array.from({length: 16}, () => 'S35W083'));

    expect(sourceWindowFor({latE7: -350000001, lonE7: -830000001})).toMatchObject({
      tile: 'S36W084', rowStart: 0, columnStart: 3599, rows: 2, columns: 2,
    });
    expect(sourceWindowFor({latE7: -350000000, lonE7: -830000000})).toEqual({
      tile: 'S35W083', rowStart: 3599, columnStart: 0, rows: 2, columns: 2,
      xFraction: 0, yFraction: 0,
    });
  });

  it('wraps generated points and source lookup across the antimeridian', () => {
    const crossing = coordinateReference.cases.find(entry => entry.id === 'antimeridian-crossing');
    if (crossing?.points === undefined) throw new Error('missing antimeridian reference');
    const points = subgridLocations({...crossing.requestOrigin, spacingM: 30}, crossing.bit as number);

    expect(points).toEqual(crossing.points);
    expect(points.map(sourceWindowFor).map(window => window.tile))
      .toEqual(Array.from({length: 16}, () => 'N00W180'));
    expect(sourceWindowFor({latE7: 0, lonE7: 1800000000}).tile).toBe('N00W180');
  });

  it('builds the four-point generated-grid stencil used by controller height interpolation', () => {
    const reference = coordinateReference.pointSample;
    const stencil = gridSampleStencil(reference.location);

    expect(stencil.locations).toEqual(reference.gridLocations);
    expect(stencil.weights).toHaveLength(4);
    expect(stencil.weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 7);
    const generatedGridHeight = reference.generatedIntegerHeightsM.reduce(
      (sum, height, index) => sum + height * stencil.weights[index]!,
      0,
    );
    expect(generatedGridHeight).toBeCloseTo(reference.controllerReportedHeightM, 3);
    expect(generatedGridHeight).not.toBe(reference.rawHgtSampleM);
  });

  it('keeps point-sample stencils canonical across signed degree boundaries and the antimeridian', () => {
    expect(gridSampleStencil({latE7: -350000000, lonE7: -830000000}).locations[0]).toEqual({
      latE7: -350000000, lonE7: -830000000,
    });
    const dateline = gridSampleStencil({latE7: 1000, lonE7: 1799999999});
    expect(dateline.locations).toHaveLength(4);
    expect(dateline.locations.some(location => location.lonE7 < 0)).toBe(true);
    expect(new Set(dateline.locations.map(location => sourceWindowFor(location).tile)))
      .toEqual(new Set(['N00E179', 'N00W180']));
  });

  it('rejects a request whose requested subgrid would cross a pole', () => {
    expect(() => subgridLocations({latE7: 899960577, lonE7: 0, spacingM: 30}, 48)).toThrow(/pole/i);
  });

  it('uses a bounded original-index 2x2 window and unrounded bilinear interpolation', () => {
    const location = {latE7: 356985340, lonE7: -833616470};
    expect(sourceWindowFor(location)).toEqual({
      tile: 'N35W084', rowStart: 1085, columnStart: 2298, rows: 2, columns: 2,
      xFraction: 0.07080000003315945, yFraction: 0.7223999999823718,
    });
    expect(interpolateHgt(location, decodedWindow(0))).toBeCloseTo(780.3880000000881, 9);
  });

  it('withholds interpolation when any contributing HGT sample is nodata', () => {
    const window = decodedWindow(0, 'N35W084-bit0-nodata-synthetic.hgt');
    const values = subgridLocations(requestKey, 0).map(location => interpolateHgt(location, window));

    expect(values).toContain(null);
    expect(values.every(value => value !== null)).toBe(false);
  });

  it('rejects a source window with the wrong tile or original indexes', () => {
    const location = {latE7: 356985340, lonE7: -833616470};
    const wrongIdentity = decodeHgtWindow(new Uint8Array(8), {
      tile: 'N35W084', schemaVersion: 1, rowStart: 0, columnStart: 0, rows: 2, columns: 2,
    });
    expect(() => interpolateHgt(location, wrongIdentity)).toThrow(/source window/i);
  });

  it.each([
    [{latE7: 356985350, lonE7: -833616470, spacingM: 30}, 0, /origin/i],
    [{latE7: 356985340.5, lonE7: -833616470, spacingM: 30}, 0, /integer/i],
    [{latE7: 356985340, lonE7: -833616470, spacingM: 100}, 0, /spacing/i],
    [{latE7: 900000000, lonE7: 0, spacingM: 30}, 0, /pole/i],
    [{latE7: 0, lonE7: 1800000001, spacingM: 30}, 0, /longitude/i],
    [requestKey, -1, /bit/i],
    [requestKey, 56, /bit/i],
    [requestKey, 0.5, /bit/i],
  ])('rejects malformed request key %#', (key, bit, pattern) => {
    expect(() => subgridLocations(key as TerrainRequestKey, bit as number)).toThrow(pattern as RegExp);
  });
});
