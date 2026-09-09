// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import type { TerrainTile, TerrainSample } from './types.js';
/** Bilinear interpolation only when every positively weighted sample is observed. */
export function sampleTerrain(tile: TerrainTile, east: number, north: number): TerrainSample {
  const t=tile.descriptor, x=(east-t.originEastingM)/t.spacingM, y=(t.originNorthingM-north)/t.spacingM;
  if (![x,y].every(Number.isFinite) || x<0 || y<0 || x>t.columns-1 || y>t.rows-1) return {groundM:null,surfaceM:null};
  const x0=Math.floor(x), y0=Math.floor(y), x1=Math.min(x0+1,t.columns-1), y1=Math.min(y0+1,t.rows-1), dx=x-x0,dy=y-y0;
  const samples:[[number,number],[number,number],[number,number],[number,number]]=[[y0*t.columns+x0,(1-dx)*(1-dy)],[y0*t.columns+x1,dx*(1-dy)],[y1*t.columns+x0,(1-dx)*dy],[y1*t.columns+x1,dx*dy]];
  const interpolate=(values:Float32Array) => {let value=0;for(const [i,w] of samples){if(w===0)continue;if(!Number.isFinite(values[i]))return null;value+=values[i]*w;}return value;};
  return {groundM:interpolate(tile.groundM),surfaceM:interpolate(tile.surfaceM)};
}
/** WGS84 transverse Mercator series; intended for the declared UTM zone, not polar latitudes. */
export function latLonToUtm(latitude: number, longitude: number, zone: number): {eastingM:number;northingM:number;hemisphere:'north'|'south'} {
  if (![latitude,longitude,zone].every(Number.isFinite) || latitude < -80 || latitude > 84 || longitude < -180 || longitude > 180 || !Number.isInteger(zone) || zone < 1 || zone > 60) throw new Error('Outside UTM coordinates');
  const rad=Math.PI/180, lon0=(zone*6-183)*rad, lat=latitude*rad, lon=longitude*rad;
  if(Math.abs(lon-lon0)>12*rad)throw new Error('Coordinate too far from UTM zone');
  const a=6378137,e2=0.0066943799901413165,ep2=e2/(1-e2),k=.9996;
  const n=a/Math.sqrt(1-e2*Math.sin(lat)**2),t=Math.tan(lat)**2,c=ep2*Math.cos(lat)**2,A=Math.cos(lat)*(lon-lon0);
  const M=a*((1-e2/4-3*e2**2/64-5*e2**3/256)*lat-(3*e2/8+3*e2**2/32+45*e2**3/1024)*Math.sin(2*lat)+(15*e2**2/256+45*e2**3/1024)*Math.sin(4*lat)-35*e2**3/3072*Math.sin(6*lat));
  const eastingM=500000+k*n*(A+(1-t+c)*A**3/6+(5-18*t+t*t+72*c-58*ep2)*A**5/120);
  const northingM=(latitude<0?10000000:0)+k*(M+n*Math.tan(lat)*(A*A/2+(5-t+9*c+4*c*c)*A**4/24+(61-58*t+t*t+600*c-330*ep2)*A**6/720));
  return {eastingM,northingM,hemisphere:latitude<0?'south':'north'};
}
