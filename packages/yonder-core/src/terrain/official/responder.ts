// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28: bounded, read-only TERRAIN_DATA responder.
import {common, minimal, MavLinkProtocolV2} from 'node-mavlink';
import type {Clock} from '../../apply/types.js';
import {decodeDatagram, type DecodedFrame} from '../../mav/protocol.js';
import type {VehicleSnapshot} from '../../mav/types.js';
import type {OfficialTerrainStore, SubgridResult} from './store.js';
import {TerrainCompatibility} from './compatibility.js';
import type {TerrainPolicy, TerrainRequestKey} from './types.js';

const FRESH_MS=3_000, REQUEST_MS=5_000, MAX_QUEUE=64, MAX_IDENTITIES=16;
const MAX_BIT=55, MAX_FRAMES_PER_SECOND=10, MIN_FRAME_INTERVAL_MS=100;
/** Dedicated local MAVLink identity; VehicleService uses component 191. */
export const TERRAIN_SOURCE_SYSTEM=254;
export const TERRAIN_SOURCE_COMPONENT=192;

export interface TerrainResponderOptions {
  vehicle:()=>VehicleSnapshot;
  store:Pick<OfficialTerrainStore,'readSubgrid'>;
  send:(bytes:Uint8Array)=>Promise<void>;
  clock:Clock;
  routerGeneration:()=>string|null;
  serialBaud:()=>number;
  policy:()=>TerrainPolicy;
  /** Runtime may share its compatibility observer with an explicit refresh route. */
  compatibility?:TerrainCompatibility;
}

interface PendingRequest {
  key:TerrainRequestKey; bit:number; expiresAt:number; vehicleGeneration:string; routerGeneration:string; reboot:number;
}
interface SeenIdentity {system:number; component:number; at:number}
interface TerrainReport {at:number; lat:number; lon:number; spacing:number; terrainHeight:number; currentHeight:number; pending:number; loaded:number}
interface Competition {system:number; component:number; at:number}

export interface TerrainResponderSnapshot {
  enabled:boolean;
  compatible:boolean;
  compatibility:ReturnType<TerrainCompatibility['snapshot']>;
  routerGeneration:string|null;
  ambiguity:boolean;
  identityOverflow:boolean;
  identities:readonly SeenIdentity[];
  queued:number;
  reading:boolean;
  sent:number;
  sentBytes:number;
  missing:number;
  dropped:number;
  controller:{report:TerrainReport|null; fresh:boolean};
  providerOwnership:{policy:'operator-managed'; exclusivityEnforced:false; directRouteVisibility:'unverified'; competition:readonly (Competition & {fresh:boolean})[]};
}

/**
 * The only automatic outbound MAVLink path in this module serializes TERRAIN_DATA.
 * It never requests parameters, fetches terrain, or creates vehicle commands.
 */
export class TerrainResponder {
  private readonly compatibility:TerrainCompatibility;
  private readonly queue:PendingRequest[]=[];
  private readonly known=new Map<string,SeenIdentity>();
  private readonly competition=new Map<string,Competition>();
  private readonly protocol=new MavLinkProtocolV2(TERRAIN_SOURCE_SYSTEM,TERRAIN_SOURCE_COMPONENT);
  private readonly sentAt:{at:number; bytes:number}[]=[];
  private report:TerrainReport|null=null;
  private timer:unknown=null;
  private inFlight:PendingRequest|null=null;
  private draining=false;
  private closed=false;
  private lastRouter:string|null|undefined=undefined;
  private lastVehicleGeneration:string|null|undefined=undefined;
  private identityOverflowUntil=0;
  private lastReboot=0;
  private wireSequence=0;
  private sent=0;
  private sentBytes=0;
  private missing=0;
  private dropped=0;

  constructor(private readonly options:TerrainResponderOptions) {this.compatibility=options.compatibility??new TerrainCompatibility();}

  receive(datagram:Uint8Array):void {
    if(this.closed) return;
    this.observeGeneration();
    const now=this.options.clock.now(), vehicle=this.options.vehicle();
    for(const frame of decodeDatagram(datagram)) this.receiveFrame(frame,vehicle,now);
    this.observeCompatibility(vehicle);
    this.kick();
  }

  snapshot():TerrainResponderSnapshot {
    const vehicle=this.options.vehicle();
    this.observeGeneration(); this.observeCompatibility(vehicle); this.prune(this.options.clock.now());
    const compatibility=this.compatibility.snapshot(vehicle), now=this.options.clock.now();
    const identities=[...this.known.values()].sort(compareIdentity);
    return Object.freeze({
      enabled:this.options.policy().enabled,
      compatible:compatibility.compatible,
      compatibility,
      routerGeneration:this.options.routerGeneration(),
      ambiguity:this.ambiguous(vehicle),
      identityOverflow:now<this.identityOverflowUntil,
      identities:Object.freeze(identities.map(identity=>Object.freeze({...identity}))),
      queued:this.queue.length,
      reading:this.draining,
      sent:this.sent,
      sentBytes:this.sentBytes,
      missing:this.missing,
      dropped:this.dropped,
      controller:{report:this.report===null?null:Object.freeze({...this.report}),fresh:this.report!==null&&now-this.report.at<FRESH_MS},
      providerOwnership:Object.freeze({policy:'operator-managed' as const,exclusivityEnforced:false as const,directRouteVisibility:'unverified' as const,
        competition:Object.freeze([...this.competition.values()].sort(compareIdentity).map(value=>Object.freeze({...value,fresh:now-value.at<FRESH_MS}))),
      }),
    });
  }

  close():void {
    this.closed=true; this.queue.splice(0); this.clearTimer();
  }

  private receiveFrame(frame:DecodedFrame,vehicle:VehicleSnapshot,now:number):void {
    this.compatibility.receive(frame,vehicle,now);
    if(frame.data instanceof minimal.Heartbeat && frame.data.autopilot!==8 && frame.data.type!==6) this.observeHeartbeat(frame,now);
    if(frame.data instanceof common.TerrainData
      && (frame.system!==TERRAIN_SOURCE_SYSTEM||frame.component!==TERRAIN_SOURCE_COMPONENT)) this.observeCompetition(frame,now);
    if(frame.data instanceof common.TerrainReport && this.selectedFrame(frame,vehicle)) {
      this.report={at:now,lat:frame.data.lat,lon:frame.data.lon,spacing:frame.data.spacing,
        terrainHeight:frame.data.terrainHeight,currentHeight:frame.data.currentHeight,pending:frame.data.pending,loaded:frame.data.loaded};
    }
    if(!(frame.data instanceof common.TerrainRequest)||!this.selectedFrame(frame,vehicle)) return;
    this.enqueue(frame.data,vehicle,now);
  }

  private observeHeartbeat(frame:DecodedFrame,now:number):void {
    const key=identityKey(frame.system,frame.component);
    this.known.set(key,{system:frame.system,component:frame.component,at:now});
    this.prune(now);
    if(this.known.size>MAX_IDENTITIES) this.identityOverflowUntil=now+FRESH_MS;
    while(this.known.size>MAX_IDENTITIES) {
      const oldest=[...this.known.entries()].sort((left,right)=>left[1].at-right[1].at)[0];
      this.known.delete(oldest[0]);
    }
  }

  private observeCompetition(frame:DecodedFrame,now:number):void {
    const key=identityKey(frame.system,frame.component);
    this.competition.set(key,{system:frame.system,component:frame.component,at:now});
    while(this.competition.size>MAX_IDENTITIES) {
      const oldest=[...this.competition.entries()].sort((left,right)=>left[1].at-right[1].at)[0];
      this.competition.delete(oldest[0]);
    }
  }

  private enqueue(request:common.TerrainRequest,vehicle:VehicleSnapshot,now:number):void {
    if(!this.admitted(vehicle,false)) return;
    if(!validRequest(request)) {this.dropped++;return;}
    const routerGeneration=this.options.routerGeneration()!, compatibility=this.compatibility.snapshot(vehicle);
    for(let bit=0;bit<=MAX_BIT;bit++) {
      if((request.mask&(1n<<BigInt(bit)))===0n) continue;
      const pending:PendingRequest={key:{latE7:request.lat,lonE7:request.lon,spacingM:30},bit,expiresAt:now+REQUEST_MS,
        vehicleGeneration:vehicle.identity!.generation,routerGeneration,reboot:compatibility.reboot};
      const duplicate=(this.inFlight!==null&&sameRequest(this.inFlight,pending))||this.queue.some(value=>sameRequest(value,pending));
      if(duplicate) continue;
      if(this.queue.length>=MAX_QUEUE) {this.dropped++;break;}
      this.queue.push(pending);
    }
  }

  private selectedFrame(frame:DecodedFrame,vehicle:VehicleSnapshot):boolean {
    return vehicle.connected&&frame.system===vehicle.identity?.system&&frame.component===vehicle.identity.component;
  }

  private kick(delay=0):void {
    if(this.closed||this.draining) return;
    if(delay>0) {this.schedule(delay);return;}
    void this.drain().catch(()=>{this.dropped++;});
  }

  private async drain():Promise<void> {
    if(this.closed||this.draining) return;
    this.draining=true;
    try {
      const now=this.options.clock.now(); this.observeGeneration(); this.prune(now); this.expire(now);
      const vehicle=this.options.vehicle();
      if(this.queue.length===0) return;
      if(!this.admitted(vehicle,true)) {
        if(this.admitted(vehicle,false)) this.schedule(MIN_FRAME_INTERVAL_MS);
        else this.clearQueue();
        return;
      }
      const wait=this.pacingDelay(now);
      if(wait>0) {this.schedule(wait);return;}
      const pending=this.queue.shift()!;
      if(!this.current(pending,vehicle)) {this.dropped++;return;}
      this.inFlight=pending;
      try {
        let result:SubgridResult;
        try {result=await this.options.store.readSubgrid(pending.key,pending.bit);} catch {this.dropped++;return;}
        const after=this.options.vehicle();
        if(!this.current(pending,after)||!this.admitted(after,true)) {this.dropped++;return;}
        if(!result.available) {this.missing++;return;}
        if(!validHeights(result.heights)) {this.missing++;return;}
        const sentAt=this.options.clock.now(), deferred=this.pacingDelay(sentAt);
        if(deferred>0) {this.queue.unshift(pending);this.schedule(deferred);return;}
        const data=Object.assign(new common.TerrainData(),{lat:pending.key.latE7,lon:pending.key.lonE7,gridSpacing:30,gridbit:pending.bit,data:result.heights});
        const bytes=this.protocol.serialize(data,this.wireSequence++%256);
        const byteDelay=this.pacingDelay(sentAt,bytes.byteLength);
        if(byteDelay>0) {this.queue.unshift(pending);this.schedule(byteDelay);return;}
        if(bytes.byteLength>byteBudget(this.options.serialBaud())) {this.dropped++;return;}
        if(!this.current(pending,this.options.vehicle())||!this.admitted(this.options.vehicle(),true)) {this.dropped++;return;}
        try {
          await this.options.send(bytes);
          this.sent++;this.sentBytes+=bytes.byteLength;this.sentAt.push({at:sentAt,bytes:bytes.byteLength});
        } catch {this.dropped++;}
      } finally {if(this.inFlight===pending)this.inFlight=null;}
    } finally {
      this.draining=false;
      if(!this.closed&&this.queue.length>0&&this.timer===null) this.kick(MIN_FRAME_INTERVAL_MS);
    }
  }

  private admitted(vehicle:VehicleSnapshot,requireIdle:boolean):boolean {
    this.prune(this.options.clock.now());
    const identity=vehicle.connected?vehicle.identity:null;
    if(!identity||!this.options.policy().enabled||this.options.routerGeneration()===null||this.ambiguous(vehicle)) return false;
    if(requireIdle&&vehicle.busy) return false;
    return this.compatibility.snapshot(vehicle).compatible;
  }

  private current(pending:PendingRequest,vehicle:VehicleSnapshot):boolean {
    const compatibility=this.compatibility.snapshot(vehicle);
    return !this.closed&&pending.expiresAt>this.options.clock.now()&&vehicle.connected&&vehicle.identity?.generation===pending.vehicleGeneration
      &&this.options.routerGeneration()===pending.routerGeneration&&compatibility.reboot===pending.reboot;
  }

  private ambiguous(vehicle:VehicleSnapshot):boolean {
    const identity=vehicle.connected?vehicle.identity:null;
    if(!identity||this.options.clock.now()<this.identityOverflowUntil||this.known.size!==1) return true;
    const only=this.known.values().next().value as SeenIdentity;
    return only.system!==identity.system||only.component!==identity.component;
  }

  private observeGeneration():void {
    const generation=this.options.routerGeneration();
    if(this.lastRouter!==undefined&&generation!==this.lastRouter) {this.clearQueue();this.report=null;}
    this.lastRouter=generation;
    const vehicle=this.options.vehicle(), selected=vehicle.connected?vehicle.identity?.generation??null:null;
    if(this.lastVehicleGeneration!==undefined&&selected!==this.lastVehicleGeneration) {this.clearQueue();this.report=null;}
    this.lastVehicleGeneration=selected;
  }

  private observeCompatibility(vehicle:VehicleSnapshot):void {
    const reboot=this.compatibility.snapshot(vehicle).reboot;
    if(reboot!==this.lastReboot) {this.clearQueue();this.report=null;this.lastReboot=reboot;}
  }

  private expire(now:number):void {
    const before=this.queue.length;
    for(let index=this.queue.length-1;index>=0;index--)if(this.queue[index].expiresAt<=now)this.queue.splice(index,1);
    this.dropped+=before-this.queue.length;
    this.expirePacing(now);
  }

  private prune(now:number):void {
    for(const [key,identity] of this.known) if(now-identity.at>=FRESH_MS) this.known.delete(key);
  }

  private pacingDelay(now:number,nextBytes=0):number {
    this.expirePacing(now);
    const previous=this.sentAt.at(-1);
    const interval=previous?Math.max(0,previous.at+MIN_FRAME_INTERVAL_MS-now):0;
    const budget=byteBudget(this.options.serialBaud());
    const used=this.sentAt.reduce((total,value)=>total+value.bytes,0);
    if((this.sentAt.length>=MAX_FRAMES_PER_SECOND||used+nextBytes>budget)&&this.sentAt[0]) return Math.max(interval,this.sentAt[0].at+1000-now);
    return interval;
  }

  private expirePacing(now:number):void {while(this.sentAt[0]&&now-this.sentAt[0].at>=1000)this.sentAt.shift();}
  private clearQueue():void {this.dropped+=this.queue.length;this.queue.splice(0);this.clearTimer();}
  private schedule(delay:number):void {
    if(this.timer!==null||this.closed) return;
    this.timer=this.options.clock.setTimer(Math.max(1,delay),()=>{this.timer=null;this.kick();});
  }
  private clearTimer():void {if(this.timer!==null){this.options.clock.clearTimer(this.timer);this.timer=null;}}
}

function validRequest(request:common.TerrainRequest):boolean {
  return Number.isSafeInteger(request.lat)&&Number.isSafeInteger(request.lon)&&request.lat>-900_000_000&&request.lat<900_000_000
    &&request.lon>=-1_800_000_000&&request.lon<=1_800_000_000&&request.gridSpacing===30&&typeof request.mask==='bigint'&&request.mask>=0n;
}
function validHeights(heights:number[]):boolean {return heights.length===16&&heights.every(value=>Number.isInteger(value)&&value>=-32768&&value<=32767);}
function validBaud(baud:number):number {return Number.isFinite(baud)&&baud>=1200?baud:1200;}
function byteBudget(baud:number):number{return Math.floor(validBaud(baud)/100);}
function identityKey(system:number,component:number):string{return `${system}:${component}`;}
function compareIdentity(left:{system:number;component:number},right:{system:number;component:number}):number{return left.system-right.system||left.component-right.component;}
function sameRequest(left:PendingRequest,right:PendingRequest):boolean {return left.vehicleGeneration===right.vehicleGeneration&&left.routerGeneration===right.routerGeneration&&left.reboot===right.reboot&&left.key.latE7===right.key.latE7&&left.key.lonE7===right.key.lonE7&&left.bit===right.bit;}
