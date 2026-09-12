// SPDX-License-Identifier: GPL-3.0-or-later
import {describe,expect,it} from 'vitest';
import {previewSvgGeometry,terrainStatusView,terrainStorageView,validateManualBounds} from './official-terrain-state.mjs';

describe('official terrain presentation state',()=>{
  it('keeps Yonder coverage, service transmission and controller loading separate',()=>{
    const view=terrainStatusView({policy:{enabled:true},coverage:{areas:[{complete:true,stale:false}]},service:{enabled:true,compatible:true,sent:8,missing:0,controller:{fresh:true,report:{pending:2,loaded:3,spacing:30}}}});
    expect(view.coverage.label).toBe('1 prepared area');
    expect(view.service.label).toBe('Serving · 8 blocks sent');
    expect(view.controller.label).toContain('2 pending · 3 loaded');
  });
  it('surfaces disabled, stale, capacity and persistence facts honestly',()=>{
    const status={policy:{enabled:false},coverage:{areas:[{complete:true,stale:true}]},storage:{usedBytes:1024,quotaBytes:2048,storage:{freeBytes:4096,persistent:false}},service:{controller:{report:null}}};
    expect(terrainStatusView(status).coverage.label).toMatch(/stale/);
    expect(terrainStatusView(status).service.label).toMatch(/Disabled/);
    expect(terrainStorageView(status)).toEqual({label:'1 KiB used of 2 KiB quota',detail:'4 KiB filesystem free · persistence unverified'});
  });
  it('never presents nodata-partial preparation as complete coverage',()=>{
    const view=terrainStatusView({policy:{enabled:true},coverage:{job:{state:'partial',reason:'official source tile contains nodata samples'},areas:[]},service:{enabled:true,controller:{report:null}}});
    expect(view.coverage).toEqual({tone:'warning',label:'Partial coverage · official source tile contains nodata samples'});
  });
  it('labels missing capability evidence as requiring refresh rather than observed incompatibility',()=>{
    const view=terrainStatusView({policy:{enabled:true},coverage:{areas:[]},service:{enabled:true,compatible:false,compatibility:{reasons:['refresh-terrain-capability','refresh-terrain-parameters']},controller:{report:null}}});
    expect(view.service).toEqual({tone:'warning',label:'Controller terrain compatibility not yet observed · refresh required'});
  });
  it('validates editable manual bounds and projects dateline geometry',()=>{
    expect(validateManualBounds({south:10,north:11,west:179,east:-179})).toEqual({south:10,north:11,west:179,east:-179});
    expect(()=>validateManualBounds({south:11,north:10,west:0,east:1})).toThrow(/South/);
    const geometry=previewSvgGeometry({rectangles:[{south:10,north:11,west:179,east:-179}],polylines:[{kind:'route-leg',points:[{lat:10,lon:179},{lat:11,lon:-179}]}]});
    expect(geometry.rectangles).toHaveLength(1);expect(geometry.polylines[0].points).not.toContain('NaN');
  });
});
