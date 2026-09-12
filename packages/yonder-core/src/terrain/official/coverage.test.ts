// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it} from 'vitest';
import {previewCoverage} from './coverage.js';
import type {MissionItem} from '../../mav/types.js';

const point = (seq:number, lat:number, lon:number, command=16, params:[number|null,number|null,number|null,number|null]=[null,null,null,null]):MissionItem => ({
  seq, command, frame:3, params, x:lat, y:lon, z:100, current:false, autocontinue:true,
});

function mission(items:MissionItem[], revision='mission-a') {
  return {kind:'mission' as const, name:'Ridge route', bufferM:100, mission:{revision,items}, home:{lat:35.1,lon:-84.9}, rally:{revision:'rally-a',points:[]}};
}

describe('previewCoverage',()=>{
  it('keeps an antimeridian manual area narrow and usable without a mission',()=>{
    const preview=previewCoverage({kind:'manual',name:'Dateline',bufferM:100,bounds:{south:10,north:10.1,west:179.8,east:-179.8}});
    expect(preview.tiles).toEqual(expect.arrayContaining(['N10E179','N10W180']));
    expect(preview.tiles.length).toBeLessThan(10);
    expect(preview.complete).toBe(true);
    expect(preview.missionComplete).toBeNull();
    expect(preview.reasons).toEqual([]);
    expect(preview.estimatedBytes).toBe(preview.tiles.length * 25_934_402 + 64 * 1024 * 1024);
  });

  it('covers a degree tile crossed midway through a continuous mission leg',()=>{
    const preview=previewCoverage(mission([point(0,35.1,-84.9),point(1,35.1,-83.1)]));
    expect(preview.complete).toBe(true);
    expect(preview.tiles).toContain('N35W084');
    expect(preview.geometry.polylines).toEqual(expect.arrayContaining([expect.objectContaining({kind:'route-leg'})]));
  });

  it('binds the preview revision to the selected mission revision',()=>{
    const first=previewCoverage(mission([point(0,35.1,-84.9)],'mission-a'));
    const changed=previewCoverage(mission([point(0,35.1,-84.9)],'mission-b'));
    expect(changed.revision).not.toBe(first.revision);
  });

  it('does not claim complete coverage for an unknown rally state or a jump',()=>{
    const input=mission([point(0,35.1,-84.9),point(1,35.1,-84.1),point(2,0,0,177)]);
    input.rally=null;
    const preview=previewCoverage(input);
    expect(preview.complete).toBe(false);
    expect(preview.reasons.join(' ')).toMatch(/rally.*unknown/i);
    expect(preview.reasons.join(' ')).toMatch(/jump/i);
  });

  it('includes return corridors from intermediate route points to home and every rally point',()=>{
    const input=mission([point(0,35.1,-84.9),point(1,35.3,-84.5),point(2,35.2,-84.1)]);
    input.rally={revision:'rally-a',points:[{lat:35.4,lon:-84.7}]};
    const preview=previewCoverage(input);
    const returns=preview.geometry.polylines.filter(line=>line.kind==='return-corridor');
    expect(returns).toEqual(expect.arrayContaining([
      expect.objectContaining({points:expect.arrayContaining([{lat:35.3,lon:-84.5},{lat:35.1,lon:-84.9}])}),
      expect.objectContaining({points:expect.arrayContaining([{lat:35.3,lon:-84.5},{lat:35.4,lon:-84.7}])}),
    ]));
  });

  it('treats a negative loiter radius as a valid counter-clockwise extent',()=>{
    const preview=previewCoverage(mission([point(0,35.1,-84.9,17,[null,null,-500,null])]));
    expect(preview.complete).toBe(true);
    expect(preview.reasons).toEqual([]);
    expect(preview.geometry.polylines).toEqual(expect.arrayContaining([expect.objectContaining({kind:'loiter-extent'})]));
  });

  it.each([92,601])('marks unsupported route-affecting command %s incomplete',command=>{
    const preview=previewCoverage(mission([point(0,35.1,-84.9),point(1,35.2,-84.8,command)]));
    expect(preview.complete).toBe(false);
    expect(preview.reasons.join(' ')).toMatch(/command|navigation|jump tag|unsupported/i);
  });

  it('flags a dateline-crossing route polyline without expanding to a world download',()=>{
    const input=mission([point(0,10.1,179.8),point(1,10.1,-179.8)]);
    input.home={lat:10.1,lon:179.8};
    const preview=previewCoverage(input);
    expect(preview.geometry.polylines.some(line=>line.kind==='route-leg'&&line.crossesAntimeridian)).toBe(true);
    expect(preview.tiles).toEqual(expect.arrayContaining(['N10E179','N10W180']));
    expect(preview.tiles.length).toBeLessThan(10);
  });

  it('uses the highest absolute latitude when conservatively buffering longitude',()=>{
    const preview=previewCoverage({kind:'manual',name:'High latitude',bufferM:10_000,bounds:{south:73,north:80,west:0.45,east:0.5}});
    expect(preview.tiles).toContain('N79W001');
    expect(preview.tiles.length).toBeLessThanOrEqual(32);
  });

  it('covers the poleward bow of a bounded high-latitude great-circle leg',()=>{
    const input=mission([point(0,79.98,-5),point(1,79.98,5)]);
    input.home={lat:79.98,lon:-5};
    const preview=previewCoverage(input);
    expect(preview.tiles.some(tile=>tile.startsWith('N80'))).toBe(true);
    expect(preview.tiles.length).toBeLessThanOrEqual(32);
  });
});

// Returns may begin between uploaded waypoints, not only at them.
it('covers the full return fan from a continuous leg',()=>{
  const preview=previewCoverage({...mission([point(0,35.1,-87.9),point(1,35.1,-80.1)]),
    bufferM:50,home:{lat:38.9,lon:-84}});
  expect(preview.complete).toBe(true);
  expect(preview.tiles).toContain('N36W085');
  expect(preview.tiles).toContain('N36W084');
});
