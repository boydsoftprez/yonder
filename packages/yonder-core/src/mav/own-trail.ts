// SPDX-License-Identifier: GPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import type {OwnTrailPoint,OwnTrailSummary,OwnTrailPage} from './types.js';

const WRAP=2**32;
function metres(a:OwnTrailPoint,lat:number,lon:number):number{
  const rad=Math.PI/180,dlat=(lat-a[2])*rad,dlon=(lon-a[3])*rad;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,Math.sin(dlat/2)**2+Math.cos(a[2]*rad)*Math.cos(lat*rad)*Math.sin(dlon/2)**2)));
}
/** R-FLT-15: passive, bounded, current-boot observations; never a command source. */
export class OwnTrail {
  private epoch=randomUUID();
  private revision=0;
  private points:OwnTrailPoint[]=[];
  private serial=0;
  private segment=0;
  private broken=true;
  private rawBoot:number|null=null;
  private wrap=0;
  private bootMs:number|null=null;
  private startBootMs:number|null=null;
  private lastReceived:number|null=null;
  private clockAt:number|null=null;
  private rollback:{boot:number;at:number;count:number}|null=null;
  private simplified=false;
  private truncated=false;
  private gaps=0;
  constructor(private readonly capacity=20000){
    if(!Number.isInteger(capacity)||capacity<8||capacity>20000)throw new Error('Invalid ownship trail capacity');
  }
  break():void {this.broken=true;}
  observe(rawBoot:number,lat:number,lon:number,valid:boolean,now:number):void{
    if(!Number.isInteger(rawBoot)||rawBoot<0||rawBoot>=WRAP||!Number.isFinite(now))return;
    if(this.wrap>0&&this.rawBoot!==null&&this.rawBoot<60000&&rawBoot>WRAP-60000)return;
    if(this.rawBoot!==null&&rawBoot<this.rawBoot){
      // uint32 millisecond rollover is not a power cycle.
      if(this.rawBoot>WRAP-60000&&rawBoot<60000){this.wrap+=WRAP;this.rollback=null;}
      else {
        // Ignore a single delayed datagram. Three advancing low-clock samples,
        // covering at least 0.5 s, establish a new observation epoch.
        if(!this.rollback||rawBoot<=this.rollback.boot)this.rollback={boot:rawBoot,at:now,count:1};
        else {this.rollback.boot=rawBoot;this.rollback.count++;}
        if(this.rollback.count<3||now-this.rollback.at<500)return;
        this.epoch=randomUUID();this.revision=0;this.points=[];this.serial=0;this.segment=0;
        this.broken=true;this.wrap=0;this.startBootMs=null;this.lastReceived=null;
        this.simplified=false;this.truncated=false;this.gaps=0;this.rollback=null;
      }
    }else {
      this.rollback=null;
      if(this.rawBoot===rawBoot)return;
    }
    this.rawBoot=rawBoot;this.bootMs=this.wrap+rawBoot;this.clockAt=now;
    if(!valid||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180){this.break();return;}
    const previous=this.points.at(-1),boot=this.bootMs;
    if(this.lastReceived!==null&&(now<this.lastReceived||now-this.lastReceived>5000))this.break();
    this.lastReceived=now;
    const travelled=previous?metres(previous,lat,lon):0;
    if(previous&&!this.broken){
      const elapsed=boot-previous[1];
      if(elapsed<=0)return;
      if(travelled>100+400*elapsed/1000){this.break();return;}
      if(elapsed<1000||(travelled<2&&elapsed<30000))return;
    }
    if(this.broken){this.segment++;if(previous)this.gaps++;}
    const total=(previous?.[4]??0)+(previous&&!this.broken?travelled:0);
    this.points.push([++this.serial,boot,lat,lon,Math.round(total*10)/10,this.segment]);
    this.startBootMs??=boot;this.broken=false;
    if(this.points.length>this.capacity)this.compact();
  }
  private compact():void{
    // Preserve endpoints of each segment; never connect across a telemetry gap.
    const old=this.points;
    this.points=old.filter((p,i)=>i===0||i===old.length-1||old[i-1]![5]!==p[5]||old[i+1]?.[5]!==p[5]||i%2===0);
    this.simplified=true;this.revision++;
    if(this.points.length>this.capacity){this.points=this.points.slice(-this.capacity);this.truncated=true;}
  }
  summary():OwnTrailSummary{
    return {epoch:this.epoch,revision:this.revision,latest:this.serial,bootMs:this.bootMs,clockAt:this.clockAt,startBootMs:this.startBootMs,
      simplified:this.simplified,truncated:this.truncated,gaps:this.gaps,tail:this.points.at(-1)?.slice() as OwnTrailPoint??null};
  }
  page(epoch?:string,after=0,minimumBootMs=0,minimumDistanceM=0):OwnTrailPage{
    const reset=epoch!==undefined&&epoch!==this.epoch;
    const cursor=reset?0:after;
    const eligible=this.points.filter(p=>p[0]>cursor&&p[1]>=minimumBootMs&&p[4]>=minimumDistanceM);
    const points=eligible.slice(0,1024),next=points.at(-1)?.[0]??this.serial;
    return {...this.summary(),points:points.map(p=>p.slice() as OwnTrailPoint),next,more:eligible.length>points.length,reset};
  }
}
