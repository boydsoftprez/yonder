// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import type {TerrainTile} from './types.js';
export interface TerrainMesh {positions:Float32Array;indices:Uint16Array|Uint32Array;heightsM:Float32Array;layer:'ground'|'surface'}
/** Native grid, rebased east/up/south metres. Unknown cells create holes, never flat invented ground. */
export function buildTerrainMesh(tile:TerrainTile,origin:{eastingM:number;northingM:number;heightM:number},layer:'ground'|'surface'='ground'):TerrainMesh {
 const t=tile.descriptor,count=t.columns*t.rows, heights=layer==='surface'?tile.surfaceM:tile.groundM;
 if(count>257*257 || heights.length!==count || ![origin.eastingM,origin.northingM,origin.heightM].every(Number.isFinite))throw new Error('Invalid terrain mesh input');
 const positions=new Float32Array(count*3),indices:number[]=[];
 for(let row=0;row<t.rows;row++)for(let col=0;col<t.columns;col++){
  const i=row*t.columns+col;
  positions[i*3]=t.originEastingM+col*t.spacingM-origin.eastingM;
  positions[i*3+1]=Number.isFinite(heights[i])?heights[i]-origin.heightM:0;
  positions[i*3+2]=origin.northingM-(t.originNorthingM-row*t.spacingM);
  if(row===t.rows-1 || col===t.columns-1)continue;
  const a=i,b=i+1,c=i+t.columns,d=c+1;
  if([a,b,c,d].every(j=>Number.isFinite(heights[j])))indices.push(a,c,b,b,c,d);
 }
 return {positions,indices:count>65535?new Uint32Array(indices):new Uint16Array(indices),heightsM:heights,layer};
}
