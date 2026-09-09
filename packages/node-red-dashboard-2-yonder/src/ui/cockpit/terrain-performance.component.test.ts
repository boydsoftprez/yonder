// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi,afterEach} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import TerrainVision from './TerrainVision.vue';
const mocks=vi.hoisted(()=>({pack:vi.fn(),build:vi.fn()}));
vi.mock('./terrain-pack-client.mjs',()=>({loadTerrainPack:mocks.pack}));
vi.mock('./terrain-state.mjs',async original=>({...await original(),buildTerrainMesh:mocks.build}));
const mesh={positions:new Float32Array(9),normals:new Float32Array(9),uv:new Float32Array(6),indices:new Uint16Array([0,1,2]),chunks:[],x:0,y:0};
const telemetry={ready:true,fixType:3,latitude:35.9611,longitude:-83.366,altitudeDatum:'EGM96',gpsAltitudeM:400,trackDeg:0};
const flight={live:true,attitudeValid:true,heading:0,pitch:0,roll:0,vsi:0,groundspeed:40};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()});
function setup(){
 vi.useFakeTimers();let id=0;const frames=new Map<number,FrameRequestCallback>();
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{frames.set(++id,fn);return id});
 vi.stubGlobal('cancelAnimationFrame',(n:number)=>frames.delete(n));
 const clear=vi.fn(),upload=vi.fn(),deleteTexture=vi.fn();
 const gl=new Proxy({clear,deleteTexture,bufferData:upload,isContextLost:()=>false,getShaderParameter:()=>true,getProgramParameter:()=>true,getExtension:()=>({}),getAttribLocation:()=>0},{get:(target,key)=>key in target?target[key]:typeof key==='string'&&key===key.toUpperCase()?1:vi.fn(()=>({}))});
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(((kind:string)=>kind==='webgl'?gl:{drawImage(){},getImageData:()=>({data:new Uint8Array(256*256*4)})}) as any);
 vi.stubGlobal('createImageBitmap',async()=>({width:256,height:256,close(){}}));
 const step=async(time:number)=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(time));await flushPromises();await vi.advanceTimersByTimeAsync(1);await flushPromises()};
 return {clear,upload,step,deleteTexture};
}
it('draws smooth terrain at display cadence and does not reupload an unchanged prepared region',async()=>{
 const {clear,upload,step}=setup();
 mocks.pack.mockResolvedValue({meshes:[mesh],origin:{lat:35.96,lon:-83.36},groundSampler:()=>300,sampleBoth:()=>({groundM:300,surfaceM:300,covered:true,datum:'EGM96'}),manifest:{verticalDatum:'EGM96',verticalTransform:{verified:true},sources:[]},spacingM:1,farSpacingM:4});
 const w=mount(TerrainVision,{props:{flight,telemetry,enabled:true,dataProvider:{revision:1,subscribe:()=>()=>{}},imageryEnabled:false}});
 await step(0);clear.mockClear();const uploads=upload.mock.calls.length;
 for(let i=1;i<=120;i++)await step(i*1000/120);
 expect(clear.mock.calls.length).toBeGreaterThanOrEqual(58);expect(clear.mock.calls.length).toBeLessThanOrEqual(61);
 await w.setProps({telemetry:{...telemetry,latitude:35.9621}});await step(1017);
 expect(upload.mock.calls.length).toBe(uploads);
 w.unmount();
});
it('keeps Terrarium geometry while checking for prepared coverage across 100 m movement cells',async()=>{
 const {step,upload}=setup();mocks.pack.mockResolvedValue(null);mocks.build.mockReturnValue(mesh);mocks.build.mockClear();
 const provider={revision:1,subscribe:()=>()=>{},tile:async()=>new Blob()};
 const w=mount(TerrainVision,{props:{flight,telemetry,enabled:true,dataProvider:provider,imageryEnabled:false}});
 for(let i=0;i<12;i++)await step(i*17);
 expect(mocks.build).toHaveBeenCalledTimes(9);const uploads=upload.mock.calls.length;
 await w.setProps({telemetry:{...telemetry,latitude:35.9621}});
 for(let i=12;i<24;i++)await step(i*17);
 expect(mocks.build).toHaveBeenCalledTimes(9);expect(upload.mock.calls.length).toBe(uploads);
 // A new elevation tile really does need new geometry.
 await w.setProps({telemetry:{...telemetry,latitude:36.1}});
 for(let i=24;i<36;i++)await step(i*17);
 expect(mocks.build).toHaveBeenCalledTimes(18);
 w.unmount();
});

it('finishes pending imagery when a coverage probe reuses the installed elevation region',async()=>{
 const {step,upload}=setup();mocks.pack.mockResolvedValue(null);mocks.build.mockReturnValue(mesh);mocks.build.mockClear();
 let release:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const provider={revision:1,subscribe:()=>()=>{},tile:async(layer:string,_z:number,_x:number,_y:number,{signal}:any)=>{if(layer==='imagery')await gate;if(signal.aborted)throw new DOMException('Aborted','AbortError');return new Blob()}};
 const w=mount(TerrainVision,{props:{flight,telemetry,enabled:true,dataProvider:provider,imageryEnabled:true}});
 for(let i=0;i<14;i++)await step(i*17);
 expect(mocks.build).toHaveBeenCalledTimes(9);expect(w.attributes('data-terrain-imagery')).toBe('loading');const uploads=upload.mock.calls.length;
 await w.setProps({telemetry:{...telemetry,latitude:35.9621}});await step(250);
 release!();await flushPromises();for(let i=16;i<22;i++)await step(i*17);
 expect(upload.mock.calls.length).toBe(uploads);
 expect(w.attributes('data-terrain-imagery')).toBe('ready');expect(w.attributes('data-terrain-imagery-tiles')).toBe('9');
 w.unmount();
});

it('preserves the image atlas during geometry changes but clears it when the ground source changes',async()=>{
 const {step,deleteTexture}=setup();
 const candidate={meshes:[mesh],origin:{lat:35.96,lon:-83.36},groundSampler:()=>300,sampleBoth:()=>({groundM:300,surfaceM:300,covered:true,datum:'EGM96'}),manifest:{verticalDatum:'EGM96',verticalTransform:{verified:true},sources:[]},spacingM:1,farSpacingM:4};
 mocks.pack.mockResolvedValue(candidate);
 const provider={revision:1,subscribe:()=>()=>{},tile:async()=>new Blob()};
 const w=mount(TerrainVision,{props:{flight,telemetry,enabled:true,dataProvider:provider,imageryEnabled:true}});
 for(let i=0;i<12;i++)await step(i*17);
 expect(w.attributes('data-terrain-detail')).toBe('ready');const initial=deleteTexture.mock.calls.length;
 mocks.pack.mockResolvedValue({...candidate,meshes:[{...mesh}]});
 await w.setProps({telemetry:{...telemetry,latitude:35.9621}});await step(220);await step(240);
 expect(deleteTexture.mock.calls.length).toBe(initial);
 await w.setProps({dataProvider:{...provider,revision:2},imageryEnabled:false});
 expect(deleteTexture.mock.calls.length).toBeGreaterThan(initial);
 w.unmount();
});
