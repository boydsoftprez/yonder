// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {MAX_HGT_WINDOW_BYTES, decodeHgtWindow, type HgtWindowIdentity} from './hgt.js';

const bit0Identity: HgtWindowIdentity = {
  tile: 'N35W084', schemaVersion: 1, rowStart: 1082, columnStart: 2298, rows: 5, columns: 5,
};

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

function identity(overrides: Partial<HgtWindowIdentity> = {}): HgtWindowIdentity {
  return {...bit0Identity, ...overrides};
}

describe('decodeHgtWindow', () => {
  it('decodes fixture bytes as signed big-endian samples at original tile coordinates', () => {
    const window = decodeHgtWindow(fixture('N35W084-bit0-source-window.hgt'), bit0Identity);

    expect(window.identity).toEqual(bit0Identity);
    expect(window.sample(1082, 2298)).toBe(765);
    expect(window.sample(1082, 2300)).toBe(747);
    expect(window.sample(1086, 2298)).toBe(784);
    expect(window.sample(1086, 2302)).toBe(784);
  });

  it('keeps HGT nodata separate from valid negative and zero elevations', () => {
    const window = decodeHgtWindow(fixture('synthetic-interpolation-cases.hgt'), identity({
      rowStart: 0, columnStart: 0, rows: 2, columns: 8,
    }));

    expect(window.sample(0, 0)).toBeNull();
    expect(window.sample(0, 2)).toBe(-1);
    expect(window.sample(0, 4)).toBe(-12);
    expect(window.sample(0, 6)).toBe(0);
  });

  it('copies a nonzero-offset input and freezes independent metadata', () => {
    const pooled = new Uint8Array([0xff, 0xff, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff]);
    const bytes = pooled.subarray(2, 6);
    const expected = identity({rowStart: 4, columnStart: 6, rows: 1, columns: 2});
    const window = decodeHgtWindow(bytes, expected);
    bytes[0] = 0x7f;
    bytes[1] = 0xff;
    expected.rowStart = 99;

    expect(window.sample(4, 6)).toBe(1);
    expect(window.sample(4, 7)).toBe(-1);
    expect(window.identity.rowStart).toBe(4);
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.identity)).toBe(true);
  });

  it('rejects source windows whose byte count does not exactly match their dimensions', () => {
    expect(() => decodeHgtWindow(new Uint8Array(49), bit0Identity)).toThrow(/byte length/i);
    expect(() => decodeHgtWindow(new Uint8Array(51), bit0Identity)).toThrow(/byte length/i);
  });

  it('rejects a window that exceeds the explicit decoded-window allocation limit', () => {
    expect(() => decodeHgtWindow(
      new Uint8Array(MAX_HGT_WINDOW_BYTES + 1), identity({rowStart: 0, columnStart: 0, rows: 1, columns: 1}),
    )).toThrow(/maximum/i);
    expect(() => decodeHgtWindow(
      new Uint8Array(), identity({rowStart: 0, columnStart: 0, rows: 3601, columns: 3601}),
    )).toThrow(/maximum/i);
  });

  it.each([
    ['unsupported schema version', identity({schemaVersion: 2 as 1})],
    ['noncanonical tile spelling', identity({tile: 'N35W84'})],
    ['southern zero alias', identity({tile: 'S00W084'})],
    ['western zero alias', identity({tile: 'N35W000'})],
    ['out-of-range tile latitude', identity({tile: 'N90W084'})],
    ['fractional origin', identity({rowStart: 1.5})],
    ['zero rows', identity({rows: 0})],
    ['origin plus dimensions outside the tile', identity({rowStart: 3600, rows: 2, columns: 1})],
  ])('rejects %s', (_reason, expected) => {
    expect(() => decodeHgtWindow(fixture('N35W084-bit0-source-window.hgt'), expected)).toThrow();
  });

  it('throws when a caller asks for a sample outside this bounded window', () => {
    const window = decodeHgtWindow(fixture('N35W084-bit0-source-window.hgt'), bit0Identity);

    expect(() => window.sample(1081, 2298)).toThrow(/outside/i);
    expect(() => window.sample(1082, 2303)).toThrow(/outside/i);
    expect(() => window.sample(1082.5, 2298)).toThrow(/outside/i);
    expect(() => window.sample(Number.NaN, 2298)).toThrow(/outside/i);
  });
});
