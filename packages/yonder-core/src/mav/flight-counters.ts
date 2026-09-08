// SPDX-License-Identifier: GPL-3.0-or-later
import type { InstrumentReading } from './instrumentation-types.js';
interface Observation { at:number; active:boolean }
/** Only intervals bracketed by fresh observations count. No speed/arming flight inference. R-FLT-23. */
export class FlightCounters {
  private armed:Observation|null=null;
  private airborne:Observation|null=null;
  private auto:Observation|null=null;
  private armedMs=0;
  private airborneMs=0;
  private autoMs=0;
  private boot:{ms:number;at:number;source:string}|null=null;
  private clockAuthority:'GLOBAL_POSITION_INT'|'SYSTEM_TIME'|null=null;
  private bootStream:{raw:number;offset:number;rollback?:{raw:number;at:number;count:number}}|null=null;
  private epochClock:{ms:number;at:number}|null=null;
  private forwardCandidate:{ms:number;at:number;firstAt:number;count:number}|null=null;
  private note='Before-attachment history excluded';
  gap():void {this.armed=null;this.airborne=null;this.auto=null;this.note='Telemetry gap excluded';}
  heartbeat(active:boolean,at:number,autoMode:boolean|null=null):void {
    if(this.armed){const dt=at-this.armed.at;if(dt>=0&&dt<3000){if(active&&this.armed.active)this.armedMs+=dt;}else {this.note='Heartbeat gap excluded';this.airborne=null;}}
    const autoActive=active&&autoMode===true;
    if(this.auto){const dt=at-this.auto.at;if(dt>=0&&dt<3000&&this.auto.active&&autoActive)this.autoMs+=dt;}
    this.auto=autoMode===null?null:{active:autoActive,at};
    this.armed={active,at};
  }
  landed(state:number,at:number):void {
    const valid=[1,2,3,4].includes(state),active=state===2;
    if(this.airborne){const dt=at-this.airborne.at;if(dt>=0&&dt<5000&&this.armed!==null&&at-this.armed.at<3000){if(active&&this.airborne.active)this.airborneMs+=dt;}else this.note='Landed-state or heartbeat gap excluded';}
    this.airborne=valid?{active,at}:null;
  }
  /** GPI is the sole authority once seen; SYSTEM_TIME can only initialize a fallback. */
  observeBoot(ms:number,source:string,at:number):boolean {
    if(!Number.isInteger(ms)||ms<0||ms>4294967295)return false;
    if(source!=='GLOBAL_POSITION_INT'&&source!=='SYSTEM_TIME')return false;
    if(this.clockAuthority==='GLOBAL_POSITION_INT'&&source!=='GLOBAL_POSITION_INT')return false;
    if(this.clockAuthority!==source){
      if(this.clockAuthority!==null){
        // A source handoff does not prove a reboot. Retain partial totals, cut
        // the observed interval, and start the authoritative reported clock.
        this.armed=null;this.airborne=null;this.auto=null;
        this.note='Clock source changed; preceding boot continuity unverified';
      }
      this.clockAuthority=source;this.bootStream=null;this.boot=null;
      this.epochClock=null;this.forwardCandidate=null;
    }
    const wrap=4294967296, previous=this.bootStream;
    let offset=previous?.offset??0,reboot=false;
    if(this.epochClock){
      // Only this authoritative stream can recover its clock after buffering.
      // Secondary clocks cannot affect this epoch, even when it expires.
      const expected=this.epochClock.ms+Math.max(0,at-this.epochClock.at);
      const nearestOffset=Math.round((expected-ms)/wrap)*wrap;
      const candidate=ms+nearestOffset;
      if(candidate<0)return false;
      if(candidate>expected+2000){
        // Reboot-confirming packets may themselves have been buffered. A
        // coherent advancing stream can recover its arrival-clock relationship;
        // one old packet (or repeated copies of one) cannot move the baseline.
        const pending=this.forwardCandidate;
        const coherent=pending&&candidate>pending.ms&&at>pending.at
          &&Math.abs((candidate-pending.ms)-(at-pending.at))<=2000;
        const next=coherent?{ms:candidate,at,firstAt:pending.firstAt,count:pending.count+1}
          :{ms:candidate,at,firstAt:at,count:1};
        this.forwardCandidate=next;
        if(next.count<3||at-next.firstAt<500)return false;
        this.forwardCandidate=null;
        this.epochClock={ms:candidate,at};
        this.bootStream={raw:ms,offset:nearestOffset};
        this.boot={ms:candidate,at,source};
        return false;
      }
      this.forwardCandidate=null;

    }
    if(previous&&offset>0&&previous.raw<60000&&ms>wrap-60000)return false;
    if(previous&&ms<previous.raw){
      if(previous.raw>wrap-60000&&ms<60000)offset+=wrap;
      else {
        // As for ownship trail epochs, one reordered datagram does not prove a
        // power cycle. Require three advancing low-clock samples spanning 0.5 s.
        const pending=previous.rollback;
        previous.rollback=!pending||ms<=pending.raw?{raw:ms,at,count:1}:{raw:ms,at:pending.at,count:pending.count+1};
        if(previous.rollback.count<3||at-previous.rollback.at<500)return false;
        reboot=true;offset=0;
        this.armedMs=0;this.airborneMs=0;this.autoMs=0;this.armed=null;this.airborne=null;this.auto=null;this.boot=null;this.epochClock={ms,at};this.forwardCandidate=null;
        this.note='Confirmed autopilot reboot; totals restarted';
      }
    }
    this.bootStream={raw:ms,offset};
    const uptime=offset+ms;
    if(this.boot===null||uptime>=this.boot.ms)this.boot={ms:uptime,at,source};
    return reboot;
  }
  readings(at:number,connected:boolean,source:string):Record<string,InstrumentReading> {
    const reading=(value:number|null,observedAt:number|null,ttlMs:number,quality:InstrumentReading['quality'],reason?:string):InstrumentReading=>{
      const ageMs=observedAt===null?null:Math.max(0,at-observedAt),fresh=connected&&observedAt!==null&&at>=observedAt&&ageMs!==null&&ageMs<ttlMs;
      return {value:fresh?value:null,unit:'s',source,ageMs,ttlMs,quality:fresh&&value!==null?quality:'unavailable',...(!fresh?{reason:!connected?'Aircraft disconnected':observedAt===null?'Required state has not been reported':'State expired; observed history retained'}:reason?{reason}:{})};
    };
    const history=`Total since collector attachment or last confirmed boot; gaps excluded. ${this.note}.`;
    return {
      'flight.bootSeconds':{...reading(this.boot?this.boot.ms/1000:null,this.boot?.at??null,5000,'reported'),source:this.boot?`${this.boot.source} · ${source}`:source},
      'flight.armedSeconds':reading(this.armedMs/1000,this.armed?.at??null,3000,'partial',`Armed intervals only; transition boundaries excluded. ${history}`),
      'flight.airborneSeconds':reading(this.airborneMs/1000,this.airborne?.at??null,5000,'partial',`IN_AIR intervals only; TAKEOFF, LANDING and transition boundaries excluded. ${history}`),
      'flight.autoSeconds':reading(this.autoMs/1000,this.auto?.at??null,3000,'partial',`Armed ArduPlane AUTO intervals only; pauses and transition boundaries excluded. ${history}`),
    };
  }
}
