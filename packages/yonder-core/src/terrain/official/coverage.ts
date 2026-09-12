// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28: pure, bounded official-terrain coverage previewing.
import {createHash} from 'node:crypto';
import type {MissionItem} from '../../mav/types.js';

export interface CoverageBounds {south:number; north:number; west:number; east:number}
export interface CoverageLocation {lat:number; lon:number}
export interface ManualCoverageInput {kind:'manual'; name:string; bounds:CoverageBounds; bufferM:number}
export interface MissionCoverageInput {
  kind:'mission'; name:string; bufferM:number;
  mission:{revision:string; items:readonly MissionItem[]};
  home:CoverageLocation|null;
  /** null is unknown; an empty points array is a known, empty rally list. */
  rally:{revision:string; points:readonly CoverageLocation[]}|null;
}
export type CoverageInput=ManualCoverageInput|MissionCoverageInput;

export interface CoverageRectangle extends CoverageBounds {}
export interface CoveragePolyline {
  kind:'route-leg'|'return-corridor'|'loiter-extent';
  points:readonly CoverageLocation[];
  crossesAntimeridian:boolean;
}
export interface CoverageGeometry {
  rectangles:readonly CoverageRectangle[];
  polylines:readonly CoveragePolyline[];
}
export interface CoveragePreview {
  kind:CoverageInput['kind'];
  name:string;
  provider:typeof OFFICIAL_TERRAIN_PROVIDER;
  tiles:readonly string[];
  geometry:CoverageGeometry;
  revision:string;
  complete:boolean;
  /** null for a manual selection, whose completeness only describes its explicit bounds. */
  missionComplete:boolean|null;
  reasons:readonly string[];
  /** Peak stored raw objects plus one bounded ZIP staging archive (downloads are serial). */
  estimatedBytes:number;
}

export const RAW_HGT_TILE_BYTES=25_934_402;
export const MAX_ZIP_STAGING_BYTES=64*1024*1024;
export const MAX_COVERAGE_TILES=32;
export const OFFICIAL_TERRAIN_PROVIDER=Object.freeze({
  id:'ardupilot-srtm1',
  source:'Official ArduPilot terrain service (JAXA ALOS 30 m)',
  spacingM:30,
  rawTileBytes:RAW_HGT_TILE_BYTES,
  worstCaseZipStagingBytes:MAX_ZIP_STAGING_BYTES,
});

const MIN_BUFFER_M=50;
const MAX_BUFFER_M=10_000;
const MAX_MISSION_ITEMS=500;
const MAX_RALLY_POINTS=500;
const MAX_GEOMETRY_WORK=4_096;
const METRES_PER_LATITUDE_DEGREE=111_320;
const EARTH_RADIUS_M=6_371_008.8;
const MAX_GEODESIC_SEGMENT_RADIANS=Math.PI/360;
const POSITION_COMMANDS=new Set([16,17,18,19,21,22,31,84,85]);
const LOITER_COMMANDS=new Set([17,18,19,31]);
const LAND_COMMANDS=new Set([21,85]);
const UNRESOLVED_NAVIGATION_COMMANDS=new Map<number,string>([
  [20,'Return-to-launch geometry is unresolved'],
  [30,'Continue-and-change-altitude geometry is unresolved'],
  [82,'Spline waypoint geometry is unsupported'],
  [189,'Landing-start geometry is unresolved'],
  [191,'Go-around geometry is unresolved'],
]);

/**
 * Builds a conservative degree-tile preview. It performs no filesystem, network,
 * controller, or mission mutation work; callers bind this revision before preparing.
 */
export function previewCoverage(input:CoverageInput):CoveragePreview {
  validateInput(input);
  const collector=new GeometryCollector(input.bufferM);
  const reasons=new Set<string>();
  let missionComplete:boolean|null;

  if(input.kind==='manual') {
    collector.rectangle(input.bounds.south,input.bounds.north,input.bounds.west,manualEast(input.bounds));
    missionComplete=null;
  } else {
    missionComplete=collectMissionCoverage(input,collector,reasons);
  }

  const geometry=collector.preview();
  const tiles=collector.tiles();
  const complete=input.kind==='manual'||missionComplete===true;
  const canonical={
    input:canonicalInput(input),
    tiles,
    geometry,
    provider:OFFICIAL_TERRAIN_PROVIDER.id,
  };
  return Object.freeze({
    kind:input.kind,
    name:input.name,
    provider:OFFICIAL_TERRAIN_PROVIDER,
    tiles:Object.freeze(tiles),
    geometry,
    revision:createHash('sha256').update(stableJson(canonical)).digest('hex'),
    complete,
    missionComplete,
    reasons:Object.freeze([...reasons].sort()),
    estimatedBytes:tiles.length*RAW_HGT_TILE_BYTES+MAX_ZIP_STAGING_BYTES,
  });
}

function collectMissionCoverage(input:MissionCoverageInput,collector:GeometryCollector,reasons:Set<string>):boolean {
  const route:CoverageLocation[]=[];
  const loiters:{location:CoverageLocation; radius:number}[]=[];
  for(const item of input.mission.items) {
    if(item.command===177||item.command===601) {
      reasons.add(item.command===601?'Mission contains a jump tag command; its route cannot be resolved safely':'Mission contains a jump; its route cannot be resolved safely');
      continue;
    }
    const unresolved=UNRESOLVED_NAVIGATION_COMMANDS.get(item.command);
    if(unresolved!==undefined) {
      reasons.add(unresolved);
      continue;
    }
    if(!POSITION_COMMANDS.has(item.command)) {
      if(Number.isInteger(item.command)&&item.command>=16&&item.command<=95) reasons.add(`Mission navigation command ${item.command} is unsupported`);
      continue;
    }
    const location=missionLocation(item,reasons);
    if(location===null) continue;
    if(LAND_COMMANDS.has(item.command)) reasons.add('Landing geometry is unsupported');
    if(route.length>0) collector.corridor(route[route.length-1],location,'route-leg');
    else if(input.home!==null) collector.corridor(input.home,location,'route-leg');
    route.push(location);
    if(LOITER_COMMANDS.has(item.command)) {
      const declaredRadius=item.params[2];
      const radius=typeof declaredRadius==='number'?Math.abs(declaredRadius):Number.NaN;
      if(!Number.isFinite(radius)||radius===0) {
        reasons.add(`Mission loiter at sequence ${item.seq} has no declared non-zero radius`);
      } else if(radius>MAX_BUFFER_M*10) {
        reasons.add(`Mission loiter at sequence ${item.seq} exceeds the bounded preview radius`);
      } else {
        collector.loiter(location,Math.abs(radius));
        loiters.push({location,radius});
      }
    }
  }
  if(route.length===0) reasons.add('Mission has no supported geographic route items');
  if(input.home===null) reasons.add('Mission home is unavailable; return coverage is unresolved');
  else collectReturns(input.home);

  if(input.rally===null) {
    reasons.add('Mission rally state is unknown; return coverage is unresolved');
  } else {
    for(const [index,rally] of input.rally.points.entries()) {
      if(!validLocation(rally)) {
        reasons.add(`Rally point ${index+1} has invalid coordinates`);
        continue;
      }
      if(input.home!==null) collector.corridor(input.home,rally,'return-corridor');
      collectReturns(rally);
    }
  }
  return reasons.size===0;

  function collectReturns(target:CoverageLocation):void {
    const path=input.home?[input.home,...route]:route;
    for(const location of path) collector.corridor(location,target,'return-corridor');
    for(let index=1;index<path.length;index++) collector.returnFan(path[index-1],path[index],target);
    for(const loiter of loiters) collector.returnFan(loiter.location,loiter.location,target,loiter.radius);
  }
}

function missionLocation(item:MissionItem,reasons:Set<string>):CoverageLocation|null {
  if(!finite(item.x)||!finite(item.y)||!validLocation({lat:item.x,lon:item.y})) {
    reasons.add(`Mission sequence ${item.seq} has invalid geographic coordinates`);
    return null;
  }
  if(![0,3,5,6,10,11].includes(item.frame)) {
    reasons.add(`Mission sequence ${item.seq} uses a non-global frame`);
    return null;
  }
  return {lat:item.x,lon:item.y};
}

class GeometryCollector {
  private readonly rectangles:CoverageRectangle[]=[];
  private readonly polylines:CoveragePolyline[]=[];
  private readonly selectedTiles=new Set<string>();
  private work=0;
  constructor(private readonly bufferM:number) {}

  rectangle(south:number,north:number,west:number,east:number,additionalBufferM=0):void {
    const totalBuffer=this.bufferM+additionalBufferM;
    const latitudeMargin=totalBuffer/METRES_PER_LATITUDE_DEGREE;
    const bufferedSouth=south-latitudeMargin,bufferedNorth=north+latitudeMargin;
    if(bufferedSouth<=-90||bufferedNorth>=90) throw new RangeError('Coverage geometry reaches an unsupported pole');
    const highestAbsoluteLatitude=Math.max(Math.abs(bufferedSouth),Math.abs(bufferedNorth));
    const longitudeMargin=totalBuffer/(METRES_PER_LATITUDE_DEGREE*Math.max(Math.cos(highestAbsoluteLatitude*Math.PI/180),0.01));
    this.addInterval(bufferedSouth,bufferedNorth,west-longitudeMargin,east+longitudeMargin);
  }

  corridor(from:CoverageLocation,to:CoverageLocation,kind:CoveragePolyline['kind']):void {
    const sampled=greatCircle(from,to);
    let crossesAntimeridian=false;
    for(let index=1;index<sampled.points.length;index++) if(Math.abs(sampled.points[index].lon-sampled.points[index-1].lon)>180) crossesAntimeridian=true;
    this.polyline(kind,sampled.points,crossesAntimeridian);
    for(let index=1;index<sampled.points.length;index++) {
      const start=sampled.points[index-1],end=sampled.points[index],endLongitude=unwrapNear(end.lon,start.lon);
      const highestAbsoluteLatitude=Math.max(Math.abs(start.lat),Math.abs(end.lat));
      const conservativeArcMargin=EARTH_RADIUS_M*sampled.segmentRadians*sampled.segmentRadians
        /(8*Math.max(Math.cos(highestAbsoluteLatitude*Math.PI/180),0.01));
      this.rectangle(Math.min(start.lat,end.lat),Math.max(start.lat,end.lat),Math.min(start.lon,endLongitude),Math.max(start.lon,endLongitude),conservativeArcMargin);
    }
  }

  /** Conservative envelope of all direct returns from an entire geodesic leg. */
  returnFan(from:CoverageLocation,to:CoverageLocation,target:CoverageLocation,extraRadiusM=0):void {
    const edges=[greatCircle(from,to),greatCircle(to,target),greatCircle(target,from)];
    const points=edges.flatMap(edge=>edge.points);
    const latitudes=points.map(point=>point.lat),longitudes=points.map(point=>unwrapNear(point.lon,from.lon));
    const south=Math.min(...latitudes),north=Math.max(...latitudes),west=Math.min(...longitudes),east=Math.max(...longitudes);
    // A local spherical triangle is bounded by its edges. Refuse a wrap-ambiguous
    // triangle instead of presenting a world-spanning or pole-enclosing fan.
    if(east-west>=180) throw new RangeError('Return fan is not bounded within one hemisphere');
    const maxSegment=Math.max(...edges.map(edge=>edge.segmentRadians));
    const margin=EARTH_RADIUS_M*maxSegment*maxSegment/(8*Math.max(Math.cos(Math.max(Math.abs(south),Math.abs(north))*Math.PI/180),0.01));
    this.rectangle(south,north,west,east,margin+extraRadiusM);
  }

  loiter(location:CoverageLocation,radiusM:number):void {
    this.polyline('loiter-extent',[location],false);
    const extent=this.bufferM+radiusM;
    const latitudeMargin=extent/METRES_PER_LATITUDE_DEGREE;
    const south=location.lat-latitudeMargin,north=location.lat+latitudeMargin;
    const highestAbsoluteLatitude=Math.max(Math.abs(south),Math.abs(north));
    const longitudeMargin=extent/(METRES_PER_LATITUDE_DEGREE*Math.max(Math.cos(highestAbsoluteLatitude*Math.PI/180),0.01));
    this.addInterval(south,north,location.lon-longitudeMargin,location.lon+longitudeMargin);
  }

  preview():CoverageGeometry {
    return Object.freeze({
      rectangles:Object.freeze(this.rectangles.map(rectangle=>Object.freeze({...rectangle}))),
      polylines:Object.freeze(this.polylines.map(polyline=>Object.freeze({
        ...polyline,points:Object.freeze(polyline.points.map(point=>Object.freeze({...point}))),
      }))),
    });
  }

  tiles():string[] {return [...this.selectedTiles].sort();}

  private polyline(kind:CoveragePolyline['kind'],points:CoverageLocation[],crossesAntimeridian:boolean):void {
    this.consumeWork();
    this.polylines.push({kind,points,crossesAntimeridian});
  }

  private addInterval(south:number,north:number,west:number,east:number):void {
    if(!finite(south)||!finite(north)||!finite(west)||!finite(east)||south>=north||east<west) throw new RangeError('Coverage geometry is invalid');
    if(east-west>=360) throw new RangeError('Coverage geometry would span the world');
    const normalizedWest=normalizeLongitude(west);
    const normalizedEast=normalizedWest+(east-west);
    if(normalizedEast<=180) this.addRectangle(south,north,normalizedWest,normalizedEast);
    else {
      this.addRectangle(south,north,normalizedWest,180);
      this.addRectangle(south,north,-180,normalizedEast-360);
    }
  }

  private addRectangle(south:number,north:number,west:number,east:number):void {
    if(south<=-90||north>=90||west<-180||east>180||south>=north||west>=east) throw new RangeError('Coverage rectangle is outside supported geography');
    this.consumeWork();
    this.rectangles.push({south,north,west,east});
    const latitudeTiles=Math.ceil(north)-Math.floor(south);
    const longitudeTiles=Math.ceil(east)-Math.floor(west);
    if(latitudeTiles*longitudeTiles>MAX_COVERAGE_TILES) throw new RangeError(`Coverage needs more than ${MAX_COVERAGE_TILES} HGT tiles`);
    for(let latitude=Math.floor(south);latitude<Math.ceil(north);latitude++) {
      for(let longitude=Math.floor(west);longitude<Math.ceil(east);longitude++) {
        this.consumeWork();
        this.selectedTiles.add(tileName(latitude,longitude));
        if(this.selectedTiles.size>MAX_COVERAGE_TILES) throw new RangeError(`Coverage needs more than ${MAX_COVERAGE_TILES} HGT tiles`);
      }
    }
  }

  private consumeWork():void {
    this.work++;
    if(this.work>MAX_GEOMETRY_WORK) throw new RangeError('Coverage geometry exceeds the preview work limit');
  }
}

function greatCircle(from:CoverageLocation,to:CoverageLocation):{points:CoverageLocation[];segmentRadians:number} {
  const fromLat=from.lat*Math.PI/180,fromLon=from.lon*Math.PI/180,toLat=to.lat*Math.PI/180,toLon=to.lon*Math.PI/180;
  const a=[Math.cos(fromLat)*Math.cos(fromLon),Math.cos(fromLat)*Math.sin(fromLon),Math.sin(fromLat)];
  const b=[Math.cos(toLat)*Math.cos(toLon),Math.cos(toLat)*Math.sin(toLon),Math.sin(toLat)];
  const angle=Math.acos(Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2])));
  if(Math.PI-angle<1e-7) throw new RangeError('Coverage great-circle leg is antipodal and has no unique bounded route');
  const segments=Math.max(1,Math.ceil(angle/MAX_GEODESIC_SEGMENT_RADIANS));
  const points:CoverageLocation[]=[from];
  if(angle>1e-12) {
    const denominator=Math.sin(angle);
    for(let index=1;index<segments;index++) {
      const fraction=index/segments,left=Math.sin((1-fraction)*angle)/denominator,right=Math.sin(fraction*angle)/denominator;
      const x=left*a[0]+right*b[0],y=left*a[1]+right*b[1],z=left*a[2]+right*b[2];
      points.push({lat:Math.atan2(z,Math.hypot(x,y))*180/Math.PI,lon:normalizeLongitude(Math.atan2(y,x)*180/Math.PI)});
    }
  }
  points.push(to);
  return {points,segmentRadians:angle/segments};
}

function validateInput(input:CoverageInput):void {
  if(typeof input!=='object'||input===null||(input.kind!=='manual'&&input.kind!=='mission')) throw new TypeError('Coverage input kind must be manual or mission');
  if(typeof input.name!=='string'||input.name.trim().length===0||input.name.length>80) throw new RangeError('Coverage name must contain at most 80 characters');
  if(!finite(input.bufferM)||input.bufferM<MIN_BUFFER_M||input.bufferM>MAX_BUFFER_M) throw new RangeError(`Coverage buffer must be from ${MIN_BUFFER_M} to ${MAX_BUFFER_M} metres`);
  if(input.kind==='manual') {
    const {south,north,west,east}=input.bounds??{} as CoverageBounds;
    if(!finite(south)||!finite(north)||!finite(west)||!finite(east)||south>=north||south<=-90||north>=90||west<-180||west>180||east<-180||east>180||west===east) throw new RangeError('Manual bounds are invalid or unsupported');
    return;
  }
  if(!input.mission||typeof input.mission.revision!=='string'||input.mission.revision.length===0||!Array.isArray(input.mission.items)||input.mission.items.length>MAX_MISSION_ITEMS) throw new RangeError(`Mission must contain at most ${MAX_MISSION_ITEMS} items and a revision`);
  if(input.home!==null&&!validLocation(input.home)) throw new RangeError('Mission home coordinates are invalid');
  if(input.rally!==null&&(typeof input.rally.revision!=='string'||input.rally.revision.length===0||!Array.isArray(input.rally.points)||input.rally.points.length>MAX_RALLY_POINTS)) throw new RangeError(`Rally must contain at most ${MAX_RALLY_POINTS} points and a revision`);
}

function manualEast(bounds:CoverageBounds):number {return bounds.west>bounds.east?bounds.east+360:bounds.east;}
function validLocation(value:CoverageLocation):boolean {return finite(value.lat)&&finite(value.lon)&&value.lat>-90&&value.lat<90&&value.lon>=-180&&value.lon<=180;}
function finite(value:unknown):value is number {return typeof value==='number'&&Number.isFinite(value);}
function unwrapNear(longitude:number,reference:number):number {
  let candidate=longitude;
  while(candidate-reference>180) candidate-=360;
  while(candidate-reference<=-180) candidate+=360;
  return candidate;
}
function normalizeLongitude(longitude:number):number {
  let normalized=longitude;
  while(normalized>180) normalized-=360;
  while(normalized<-180) normalized+=360;
  return normalized;
}
function tileName(latitude:number,longitude:number):string {
  const lat=latitude<0?`S${Math.abs(latitude).toString().padStart(2,'0')}`:`N${latitude.toString().padStart(2,'0')}`;
  const lon=longitude<0?`W${Math.abs(longitude).toString().padStart(3,'0')}`:`E${longitude.toString().padStart(3,'0')}`;
  return `${lat}${lon}`;
}
function canonicalInput(input:CoverageInput):unknown {
  if(input.kind==='manual') return {kind:input.kind,name:input.name,bufferM:input.bufferM,bounds:input.bounds};
  return {kind:input.kind,name:input.name,bufferM:input.bufferM,mission:input.mission,home:input.home,rally:input.rally};
}
function stableJson(value:unknown):string {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
